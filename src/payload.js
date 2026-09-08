/**
 * The agent-facing payload.
 *
 * This is what an agent gets instead of HTML: who we are, what we sell, when
 * we're free, and the exact calls to make next. Services and availability come
 * from the same D1 tables the /api/* routes and the MCP tools use, so the
 * payload can never drift from what a booking call will actually accept.
 */

import { listActiveServices, listOpenSlots } from "./db.js";
import { recordIncident } from "./observability.js";

const DEFAULTS = {
  BUSINESS_NAME: "The Equation Agency LLC",
  BUSINESS_DESCRIPTION: "AI-native digital strategy and marketing agency.",
  CONTACT_EMAIL: "management@theequationagencyllc.com",
  MCP_SERVER_URL: "https://mcp.theequationagencyllc.com",
};

const cfg = (env, key) => env?.[key] || DEFAULTS[key];

/** The three advertised actions, described the way an agent needs them. */
export function actionCatalog() {
  return [
    {
      name: "get_services",
      description: "List current service offerings and pricing.",
      endpoint: "/api/services",
      method: "GET",
    },
    {
      name: "check_availability",
      description:
        "Check open consultation slots. Optional query params: from, to (unix seconds), limit.",
      endpoint: "/api/availability",
      method: "GET",
    },
    {
      name: "book_consult",
      description: "Book a consultation slot.",
      endpoint: "/api/book",
      method: "POST",
      content_type: "application/json",
      body_schema: {
        type: "object",
        required: ["slot_id", "name", "email"],
        properties: {
          slot_id: { type: "integer", description: "id from check_availability" },
          name: { type: "string", maxLength: 200 },
          email: { type: "string", format: "email", maxLength: 320 },
          notes: { type: "string", maxLength: 2000 },
        },
      },
      errors: {
        invalid_request: "400 — body failed validation; see error.field",
        slot_not_found: "404 — no slot with that id",
        slot_taken: "409 — someone booked that slot first; re-check availability",
      },
    },
  ];
}

/**
 * Builds the structured payload served to agents/MCP clients.
 *
 * If D1 is unreachable the payload still returns — with `status: "degraded"`,
 * empty lists, and an incident recorded — because the contact details and the
 * MCP server URL are useful even when the database isn't. An agent can check
 * `status` and retry rather than getting nothing at all.
 */
export async function buildAgentPayload(env, request) {
  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;

  const base = {
    status: "ok",
    business: {
      name: cfg(env, "BUSINESS_NAME"),
      description: cfg(env, "BUSINESS_DESCRIPTION"),
      contact: cfg(env, "CONTACT_EMAIL"),
      url: origin,
    },
    actions: actionCatalog().map((a) => ({ ...a, url: origin + a.endpoint })),
    mcp_server: {
      url: cfg(env, "MCP_SERVER_URL"),
      transport: "streamable-http",
      tools: ["get_services", "check_availability", "book_consult"],
      note: "Prefer connecting here directly for tool-call access instead of scraping this JSON.",
    },
    generated_at: new Date().toISOString(),
  };

  try {
    const [services, availability] = await Promise.all([
      listActiveServices(env),
      listOpenSlots(env, { limit: 10 }),
    ]);
    return { ...base, services, availability };
  } catch (err) {
    await recordIncident(env, {
      path: url.pathname,
      kind: "db_error",
      detail: `buildAgentPayload: ${err?.message || err}`,
    });
    return {
      ...base,
      status: "degraded",
      degraded_reason:
        "Live service and availability data is temporarily unavailable. The actions " +
        "below are still valid — retry, or use the MCP server.",
      services: [],
      availability: [],
    };
  }
}
