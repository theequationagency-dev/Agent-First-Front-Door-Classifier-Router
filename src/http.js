/**
 * Small HTTP helpers shared by every route.
 *
 * Error bodies are deliberately machine-readable — an agent that gets a 409
 * back from /api/book should be able to branch on `error.code` without
 * parsing prose.
 */

import { CLASSIFIER_VARY } from "./classifier.js";

/** JSON response with the headers every agent-facing body should carry. */
export function json(body, { status = 200, headers = {}, cache = "no-store" } = {}) {
  const res = new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": cache,
      vary: CLASSIFIER_VARY,
      // Agents running inside a browser (extensions, web-based tools) need
      // this to read the payload at all.
      "access-control-allow-origin": "*",
      ...headers,
    },
  });
  return res;
}

/**
 * Machine-readable error body.
 *
 *   { "error": { "code": "slot_taken", "message": "...", "field": "slot_id" } }
 */
export function jsonError(status, code, message, extra = {}) {
  return json({ error: { code, message, ...extra } }, { status });
}

/** Preflight for the CORS header above. */
export function corsPreflight() {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type, authorization, x-admin-token",
      "access-control-max-age": "86400",
    },
  });
}

/**
 * Adds fields to an existing Vary header without dropping what the origin set.
 */
export function appendVary(headers, fields = CLASSIFIER_VARY) {
  const existing = (headers.get("vary") || "")
    .split(",")
    .map((f) => f.trim().toLowerCase())
    .filter(Boolean);

  if (existing.includes("*")) return;

  for (const field of fields.split(",").map((f) => f.trim().toLowerCase())) {
    if (field && !existing.includes(field)) existing.push(field);
  }
  headers.set("vary", existing.join(", "));
}

/** Reads a JSON request body, or returns null if it isn't parseable JSON. */
export async function readJsonBody(request) {
  const type = (request.headers.get("content-type") || "").toLowerCase();
  if (!type.includes("application/json")) return null;
  try {
    const body = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

/** Clamps a query-string integer into a range, falling back to a default. */
export function intParam(value, { fallback, min, max }) {
  const n = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
