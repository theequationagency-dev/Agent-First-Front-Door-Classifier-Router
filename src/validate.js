/**
 * Booking input rules, in one place.
 *
 * The HTTP route and the MCP tool both call this, so an agent gets the same
 * answer whichever door it comes through.
 */

export const LIMITS = { name: 200, email: 320, notes: 2000 };

// Deliberately loose: enough to catch a typo or an obviously bogus value,
// not an attempt to fully validate RFC 5322.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * @returns {{ ok: true, value: object } | { ok: false, code: string, field: string, message: string }}
 */
export function validateBookingInput(input) {
  const fail = (field, message) => ({ ok: false, code: "invalid_request", field, message });

  if (!input || typeof input !== "object") {
    return fail("body", "Expected a JSON object body.");
  }

  const slotId = Number(input.slot_id);
  if (!Number.isInteger(slotId) || slotId <= 0) {
    return fail("slot_id", "slot_id must be a positive integer from check_availability.");
  }

  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) return fail("name", "name is required.");
  if (name.length > LIMITS.name) {
    return fail("name", `name must be ${LIMITS.name} characters or fewer.`);
  }

  const email = typeof input.email === "string" ? input.email.trim() : "";
  if (!email) return fail("email", "email is required.");
  if (email.length > LIMITS.email || !EMAIL.test(email)) {
    return fail("email", "email must be a valid email address.");
  }

  const rawNotes = input.notes;
  if (rawNotes != null && typeof rawNotes !== "string") {
    return fail("notes", "notes must be a string if provided.");
  }
  const notes = typeof rawNotes === "string" ? rawNotes.trim() : "";
  if (notes.length > LIMITS.notes) {
    return fail("notes", `notes must be ${LIMITS.notes} characters or fewer.`);
  }

  return { ok: true, value: { slot_id: slotId, name, email, notes: notes || null } };
}
