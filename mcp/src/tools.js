/**
 * MCP tools — the same three capabilities the HTTP API exposes.
 *
 * Every tool goes through ../../src/db.js, the same module the Worker's
 * /api/* routes use, against the same D1 database. There is no second copy of
 * "what a service is" or "how a slot gets claimed" to keep in sync.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  listActiveServices,
  listOpenSlots,
  createBooking,
  BookingError,
} from "../../src/db.js";
import { recordIncident } from "../../src/observability.js";
import { validateBookingInput } from "../../src/validate.js";

const VERSION = "0.1.0";

const priceShape = z.object({
  amount_cents: z.number().int().nullable(),
  currency: z.string(),
  display: z.string().nullable(),
});

const serviceShape = z.object({
  id: z.number().int(),
  name: z.string(),
  description: z.string().nullable(),
  price: priceShape,
});

const slotShape = z.object({
  slot_id: z.number().int(),
  start: z.string().nullable(),
  end: z.string().nullable(),
  start_unix: z.number().int(),
  end_unix: z.number().int(),
});

/** Tool results carry both a readable text block and the structured object. */
function ok(structured) {
  return {
    content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  };
}

/** A refusal the model should act on (bad input, slot gone) — not a failure. */
function refusal(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * An actual failure. Logged to the incidents table so "what breaks for
 * agents" stays visible, then reported to the caller in plain terms.
 */
async function failure(env, tool, err) {
  await recordIncident(env, {
    path: `mcp:${tool}`,
    kind: "mcp_tool_failure",
    detail: `${err?.name || "Error"}: ${err?.message || err}`,
  });
  return refusal(
    `${tool} is temporarily unavailable (the booking database did not respond). Retry shortly.`
  );
}

/**
 * Builds a server instance. One per request — a Worker has no long-lived
 * per-session memory, so state lives in D1, not in the process.
 */
export function createMcpServer(env) {
  const site = env?.SITE_NAME || "this organisation";
  const server = new McpServer(
    { name: env?.SERVER_NAME || "agent-front-door", version: VERSION },
    {
      instructions:
        `Services, availability and bookings for ${site}. Call ` +
        "check_availability for a slot_id before calling book_consult.",
    }
  );

  server.registerTool(
    "get_services",
    {
      title: "Get services",
      description: "List current service offerings and pricing.",
      inputSchema: {},
      outputSchema: { services: z.array(serviceShape), count: z.number().int() },
    },
    async () => {
      try {
        const services = await listActiveServices(env);
        return ok({ services, count: services.length });
      } catch (err) {
        return failure(env, "get_services", err);
      }
    }
  );

  server.registerTool(
    "check_availability",
    {
      title: "Check availability",
      description:
        "List open consultation slots. Returns slot_id values that book_consult accepts.",
      inputSchema: {
        from: z
          .number()
          .int()
          .optional()
          .describe("Earliest slot start, unix seconds. Defaults to now."),
        to: z.number().int().optional().describe("Latest slot start, unix seconds."),
        limit: z.number().int().min(1).max(200).optional().describe("Max slots to return."),
      },
      outputSchema: { availability: z.array(slotShape), count: z.number().int() },
    },
    async ({ from, to, limit }) => {
      try {
        const slots = await listOpenSlots(env, { from, to, limit: limit ?? 50 });
        return ok({ availability: slots, count: slots.length });
      } catch (err) {
        return failure(env, "check_availability", err);
      }
    }
  );

  server.registerTool(
    "book_consult",
    {
      title: "Book consultation",
      description:
        "Book a consultation slot. Use a slot_id from check_availability; a slot " +
        "someone else has taken is refused, so re-check availability and retry.",
      inputSchema: {
        slot_id: z.number().int().positive().describe("slot_id from check_availability"),
        name: z.string().min(1).max(200),
        email: z.string().email().max(320),
        notes: z.string().max(2000).optional(),
      },
      outputSchema: {
        booked: z.boolean(),
        booking_id: z.number().int(),
        slot_id: z.number().int(),
        start: z.string().nullable(),
        end: z.string().nullable(),
      },
    },
    async (args) => {
      // The same validator the HTTP route uses, so both doors agree on what
      // counts as a valid booking.
      const check = validateBookingInput(args);
      if (!check.ok) return refusal(`${check.field}: ${check.message}`);

      try {
        const booking = await createBooking(env, { ...check.value, source: "mcp" });
        return ok({
          booked: true,
          booking_id: booking.booking_id,
          slot_id: booking.slot_id,
          start: booking.slot?.start ?? null,
          end: booking.slot?.end ?? null,
        });
      } catch (err) {
        if (err instanceof BookingError) {
          return refusal(
            err.code === "slot_taken"
              ? `${err.message} Call check_availability again and pick another slot.`
              : `${err.message} Call check_availability for valid slot ids.`
          );
        }
        return failure(env, "book_consult", err);
      }
    }
  );

  return server;
}
