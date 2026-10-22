/**
 * Agent-First Front Door — Classifier + Router
 * Cloudflare Worker
 *
 * One route, two response bodies:
 *   - Classified as agent/bot  -> structured JSON action payload (from D1)
 *   - Classified as human      -> pass through to origin (your existing site)
 *
 * Plus the endpoints that payload advertises (/api/*) and an operator view of
 * what the classifier has been deciding (/admin/classification-report).
 *
 * Deploy: wrangler.toml routes this at your zone, e.g. "example.com/*"
 * Origin for humans: the ORIGIN_URL var. D1 lives on the DB binding.
 * Nothing about your site is hardcoded here — it is all config.
 */

import { classifyRequest } from "./classifier.js";
import { buildAgentPayload } from "./payload.js";
import { logClassification, recordIncident, purgeOldLogs } from "./observability.js";
import { json, appendVary } from "./http.js";
import { handleApi } from "./routes/api.js";
import { handleAdmin } from "./routes/admin.js";
import { handleDiscovery } from "./routes/discovery.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const classification = classifyRequest(request);

    // Log every classification decision to request_log so the "unknown"
    // bucket can be reviewed later. Never block the response on it.
    ctx.waitUntil(logClassification(env, request, classification));

    // Operator endpoints first: they are auth-gated and must not depend on
    // what the classifier thought of the caller.
    const admin = await handleAdmin(request, env);
    if (admin) return admin;

    // Discovery next: /llms.txt and /.well-known/agent.json answer everyone
    // the same way, so an agent we misclassified can still ask directly.
    const discovery = await handleDiscovery(request, env);
    if (discovery) return discovery;

    // Then the advertised API. Open to humans and agents alike — the payload
    // hands these URLs out, so gating them on a UA guess would defeat it.
    const api = await handleApi(request, env, classification);
    if (api) return api;

    if (servesPayload(classification, env)) {
      const payload = await buildAgentPayload(env, request);
      return json(payload, {
        headers: { "x-served-as": classification },
        // Short cache: the payload embeds live availability, and Vary
        // (set in json()) keeps a shared cache from serving it to a browser.
        cache: "public, max-age=60",
      });
    }

    return passThroughToOrigin(request, env, url, classification);
  },

  /** Cron trigger: drops request_log rows past their retention window. */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(purgeOldLogs(env));
  },
};

/**
 * Which buckets get the JSON payload. "search" and "human" never do.
 * "unknown" does by default; UNKNOWN_SERVES = "site" sends it to the website
 * instead, for sites whose visitors include older browsers (see the
 * classifier) and that would rather show a scraper HTML than show a person
 * JSON.
 */
export function servesPayload(classification, env) {
  if (classification === "mcp" || classification === "agent") return true;
  if (classification === "unknown") return env?.UNKNOWN_SERVES !== "site";
  return false;
}

/**
 * Humans get the existing site, untouched apart from a debug header.
 *
 * ORIGIN_URL is either the origin's URL, or the literal "same-host" when this
 * Worker runs as a Cloudflare route in front of a site on the same hostname
 * (for example a Pages custom domain). On a route, fetch(request) goes to the
 * zone's origin and does not invoke this Worker again, so there is no second
 * hostname for search engines to find as a duplicate of the site.
 */
async function passThroughToOrigin(request, env, url, classification = "human") {
  // No default: a fork with no ORIGIN_URL set must not silently proxy
  // traffic to whatever site happened to be in the template.
  const originUrl = env.ORIGIN_URL;
  if (!originUrl) {
    await recordIncident(env, {
      path: url.pathname,
      kind: "other",
      detail: "ORIGIN_URL is not set — there is nowhere to send human traffic.",
    });
    return new Response(
      "ORIGIN_URL is not configured on this Worker.\nSet it in wrangler.toml.\n",
      { status: 502, headers: { "content-type": "text/plain; charset=utf-8" } }
    );
  }

  if (originUrl === "same-host") {
    return finishPassthrough(await originFetch(request, env, url), classification, url, env);
  }

  let target;
  try {
    target = new URL(url.pathname + url.search, originUrl);
  } catch (err) {
    await recordIncident(env, {
      path: url.pathname,
      kind: "other",
      detail: `ORIGIN_URL is not a valid URL: ${originUrl}`,
    });
    return new Response("Origin is misconfigured.", { status: 502 });
  }

  // The Worker route and the origin must not be the same hostname, or the
  // passthrough loops back into this Worker until Cloudflare cuts it off.
  if (target.host === url.host) {
    await recordIncident(env, {
      path: url.pathname,
      kind: "blocked_fetch",
      detail: `ORIGIN_URL (${originUrl}) resolves to the Worker's own host — passthrough would loop.`,
    });
    return new Response("Origin is misconfigured: passthrough loop.", { status: 508 });
  }

  return finishPassthrough(
    await originFetch(new Request(target, request), env, url),
    classification,
    url,
    env
  );
}

/** Fetches from the origin; null (with an incident recorded) if it fails. */
async function originFetch(request, env, url) {
  try {
    return await fetch(request);
  } catch (err) {
    await recordIncident(env, {
      path: url.pathname,
      kind: "blocked_fetch",
      detail: `origin passthrough to ${new URL(request.url).host} failed: ${err?.message || err}`,
    });
    return null;
  }
}

async function finishPassthrough(originResponse, classification, url, env) {
  if (!originResponse) {
    return new Response("Upstream site is unavailable.", {
      status: 502,
      headers: { "x-served-as": classification, "retry-after": "30" },
    });
  }

  if (originResponse.status === 429) {
    await recordIncident(env, {
      path: url.pathname,
      kind: "rate_limit",
      detail: `origin returned 429`,
    });
  }

  // Clone so we can attach a debug header without mutating the
  // immutable response Cloudflare returned.
  const response = new Response(originResponse.body, originResponse);
  response.headers.set("x-served-as", classification);
  appendVary(response.headers);
  return response;
}
