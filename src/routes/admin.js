/**
 * /admin/* — operator endpoints. Auth-gated, never cached, never exposed to
 * the classifier's agent payload.
 *
 * Auth is a shared secret in the ADMIN_TOKEN binding:
 *
 *   wrangler secret put ADMIN_TOKEN
 *   curl -H "authorization: Bearer $ADMIN_TOKEN" https://…/admin/classification-report
 *
 * If ADMIN_TOKEN is unset the endpoint fails closed (503), so a missing
 * secret can never accidentally publish your traffic log. Put Cloudflare
 * Access in front of the route too if you want SSO rather than a shared key.
 */

import { json, jsonError, intParam } from "../http.js";
import { classificationReport, recordIncident } from "../observability.js";
import { DbError } from "../db.js";

/** Length-independent comparison, so the response time doesn't leak the token. */
function secretsMatch(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

function presentedToken(request) {
  const auth = request.headers.get("authorization") || "";
  const bearer = auth.match(/^Bearer\s+(.+)$/i);
  if (bearer) return bearer[1].trim();
  return request.headers.get("x-admin-token")?.trim() || null;
}

/** Routes /admin/*. Returns null if the path isn't ours. */
export async function handleAdmin(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");

  if (path !== "/admin/classification-report") return null;

  if (!env?.ADMIN_TOKEN) {
    return jsonError(
      503,
      "admin_not_configured",
      "ADMIN_TOKEN is not set on this Worker. Run: wrangler secret put ADMIN_TOKEN"
    );
  }

  if (!secretsMatch(presentedToken(request), env.ADMIN_TOKEN)) {
    return jsonError(401, "unauthorized", "Provide the admin token.", {
      how: "authorization: Bearer <ADMIN_TOKEN>, or x-admin-token: <ADMIN_TOKEN>",
    });
  }

  if (request.method !== "GET") {
    return jsonError(405, "method_not_allowed", "Use GET on this endpoint.", { allow: "GET" });
  }

  const days = intParam(url.searchParams.get("days"), { fallback: 7, min: 1, max: 90 });
  const limit = intParam(url.searchParams.get("limit"), { fallback: 25, min: 1, max: 200 });

  try {
    const report = await classificationReport(env, { days, limit });
    return json(report, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    await recordIncident(env, {
      path,
      kind: err instanceof DbError ? "db_error" : "other",
      detail: `classification report: ${err?.message || err}`,
    });
    return jsonError(503, "upstream_unavailable", "Could not read the request log.");
  }
}
