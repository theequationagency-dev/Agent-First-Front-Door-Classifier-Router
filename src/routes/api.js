/**
 * /api/* — the endpoints the agent payload advertises.
 *
 * These are open to everyone, whatever the classifier decided. The payload
 * tells agents these URLs exist; refusing to serve them on a UA guess would
 * defeat the point. Classification is still logged for every request.
 */

import { json, jsonError, corsPreflight, readJsonBody, intParam } from "../http.js";
import { listActiveServices, listOpenSlots, createBooking, BookingError, DbError } from "../db.js";
import { recordIncident } from "../observability.js";
import { validateBookingInput } from "../validate.js";
import { bookingSourceFor } from "../classifier.js";

const BOOKING_ERROR_STATUS = { slot_not_found: 404, slot_taken: 409 };

/**
 * Routes /api/*. Returns null if the path isn't ours, so the caller can fall
 * through to classification-based routing.
 */
export async function handleApi(request, env, classification) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/api";

  if (request.method === "OPTIONS") return corsPreflight();

  try {
    if (path === "/api/services") {
      if (request.method !== "GET") return methodNotAllowed("GET");
      const limit = intParam(url.searchParams.get("limit"), { fallback: 100, min: 1, max: 500 });
      const services = await listActiveServices(env, { limit });
      return json({ services, count: services.length });
    }

    if (path === "/api/availability") {
      if (request.method !== "GET") return methodNotAllowed("GET");
      const from = intParam(url.searchParams.get("from"), {
        fallback: undefined,
        min: 0,
        max: Number.MAX_SAFE_INTEGER,
      });
      const to = intParam(url.searchParams.get("to"), {
        fallback: undefined,
        min: 0,
        max: Number.MAX_SAFE_INTEGER,
      });
      const limit = intParam(url.searchParams.get("limit"), { fallback: 50, min: 1, max: 200 });
      const slots = await listOpenSlots(env, { from, to, limit });
      return json({ availability: slots, count: slots.length });
    }

    if (path === "/api/book") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      return await handleBook(request, env, classification);
    }

    return null;
  } catch (err) {
    return await failure(env, path, err);
  }
}

async function handleBook(request, env, classification) {
  const body = await readJsonBody(request);
  if (body === null) {
    return jsonError(
      400,
      "invalid_request",
      "Send a JSON object body with content-type: application/json.",
      { field: "body" }
    );
  }

  const check = validateBookingInput(body);
  if (!check.ok) {
    return jsonError(400, check.code, check.message, { field: check.field });
  }

  try {
    const booking = await createBooking(env, {
      ...check.value,
      source: bookingSourceFor(classification),
    });
    return json({ booked: true, booking }, { status: 201 });
  } catch (err) {
    if (err instanceof BookingError) {
      // Not an incident — this is the API working correctly. Tell the agent
      // exactly what to do next.
      return jsonError(BOOKING_ERROR_STATUS[err.code] || 409, err.code, err.message, {
        next_action:
          err.code === "slot_taken"
            ? "Call GET /api/availability again and pick another slot_id."
            : "Call GET /api/availability for valid slot ids.",
      });
    }
    throw err;
  }
}

function methodNotAllowed(allow) {
  return jsonError(405, "method_not_allowed", `Use ${allow} on this endpoint.`, {
    allow,
  });
}

/** Any unexpected throw on the agent path becomes an incident, not a 500 log line. */
async function failure(env, path, err) {
  const kind = err instanceof DbError ? "db_error" : "other";
  await recordIncident(env, { path, kind, detail: `${err?.name}: ${err?.message || err}` });
  return jsonError(
    503,
    "upstream_unavailable",
    "The booking database is temporarily unavailable. Retry shortly.",
    { retry_after_seconds: 30 }
  );
}
