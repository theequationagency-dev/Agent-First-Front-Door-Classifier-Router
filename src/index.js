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
import { logClassification, recordIncident } from "./observability.js";
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

    switch (classification) {
      case "mcp":
      case "agent":
      case "unknown": {
        const payload = await buildAgentPayload(env, request);
        return json(payload, {
          headers: { "x-served-as": classification },
          // Short cache: the payload embeds live availability, and Vary
          // (set in json()) keeps a shared cache from serving it to a browser.
          cache: "public, max-age=60",
        });
      }

      case "human":
      default:
        return passThroughToOrigin(request, env, url);
    }
  },
};

/**
 * Humans get the existing site, untouched apart from a debug header.
 */
async function passThroughToOrigin(request, env, url) {
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

  let originResponse;
  try {
    originResponse = await fetch(new Request(target, request));
  } catch (err) {
    await recordIncident(env, {
      path: url.pathname,
      kind: "blocked_fetch",
      detail: `origin passthrough to ${target.host} failed: ${err?.message || err}`,
    });
    return new Response("Upstream site is unavailable.", {
      status: 502,
      headers: { "x-served-as": "human", "retry-after": "30" },
    });
  }

  if (originResponse.status === 429) {
    await recordIncident(env, {
      path: url.pathname,
      kind: "rate_limit",
      detail: `origin ${target.host} returned 429`,
    });
  }

  // Clone so we can attach a debug header without mutating the
  // immutable response Cloudflare returned.
  const response = new Response(originResponse.body, originResponse);
  response.headers.set("x-served-as", "human");
  appendVary(response.headers);
  return response;
}
