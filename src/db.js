/**
 * Data access — the single source of truth.
 *
 * The agent JSON payload, the /api/* routes and the MCP tools all go through
 * these functions. Nothing queries D1 directly anywhere else, so a change to
 * "what a service looks like" happens in exactly one place.
 */

/** Thrown for any D1 failure, so callers can log it as a `db_error` incident. */
export class DbError extends Error {
  constructor(operation, cause) {
    super(`D1 ${operation} failed: ${cause?.message || cause}`);
    this.name = "DbError";
    this.operation = operation;
    this.cause = cause;
  }
}

/** Thrown when a booking can't be made. `code` is what the caller returns. */
export class BookingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BookingError";
    this.code = code; // 'slot_not_found' | 'slot_taken'
  }
}

function requireDb(env) {
  if (!env?.DB) {
    throw new DbError("binding", new Error("no D1 binding named DB is configured"));
  }
  return env.DB;
}

async function run(env, operation, fn) {
  try {
    return await fn(requireDb(env));
  } catch (err) {
    if (err instanceof DbError) throw err;
    throw new DbError(operation, err);
  }
}

// ---------------------------------------------------------------------------
// Row shaping — one definition of the public shape of each record.
// ---------------------------------------------------------------------------

const iso = (unixSeconds) =>
  Number.isFinite(unixSeconds) ? new Date(unixSeconds * 1000).toISOString() : null;

export function shapeService(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    price: {
      amount_cents: row.price_cents,
      currency: row.currency || "USD",
      display:
        row.price_cents == null
          ? null
          : new Intl.NumberFormat("en-US", {
              style: "currency",
              currency: row.currency || "USD",
              maximumFractionDigits: 0,
            }).format(row.price_cents / 100),
    },
  };
}

export function shapeSlot(row) {
  return {
    slot_id: row.id,
    start: iso(row.slot_start),
    end: iso(row.slot_end),
    start_unix: row.slot_start,
    end_unix: row.slot_end,
  };
}

export function shapeBooking(row) {
  return {
    booking_id: row.id,
    slot_id: row.slot_id,
    name: row.name,
    email: row.email,
    notes: row.notes ?? null,
    source: row.source,
    created_at: iso(row.created_at),
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listActiveServices(env, { limit = 100 } = {}) {
  const { results } = await run(env, "listActiveServices", (db) =>
    db
      .prepare(
        `SELECT id, name, description, price_cents, currency
           FROM services
          WHERE active = 1
          ORDER BY price_cents IS NULL, price_cents ASC, id ASC
          LIMIT ?`
      )
      .bind(limit)
      .all()
  );
  return (results || []).map(shapeService);
}

/**
 * Open (unbooked) slots. `from`/`to` are unix seconds; `from` defaults to now
 * so we never advertise a slot that has already passed.
 */
export async function listOpenSlots(env, { from, to, limit = 50 } = {}) {
  const start = Number.isFinite(from) ? from : Math.floor(Date.now() / 1000);
  const end = Number.isFinite(to) ? to : null;

  const { results } = await run(env, "listOpenSlots", (db) =>
    db
      .prepare(
        `SELECT id, slot_start, slot_end
           FROM availability
          WHERE booked = 0
            AND slot_start >= ?
            AND (? IS NULL OR slot_start <= ?)
          ORDER BY slot_start ASC
          LIMIT ?`
      )
      .bind(start, end, end, limit)
      .all()
  );
  return (results || []).map(shapeSlot);
}

export async function getSlot(env, slotId) {
  const row = await run(env, "getSlot", (db) =>
    db
      .prepare(`SELECT id, slot_start, slot_end, booked FROM availability WHERE id = ?`)
      .bind(slotId)
      .first()
  );
  return row || null;
}

export async function getBooking(env, bookingId) {
  const row = await run(env, "getBooking", (db) =>
    db
      .prepare(
        `SELECT id, slot_id, name, email, notes, source, created_at
           FROM bookings WHERE id = ?`
      )
      .bind(bookingId)
      .first()
  );
  return row ? shapeBooking(row) : null;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Claims a slot and records the booking.
 *
 * Both statements go through one D1 batch, which runs as a single
 * transaction, and both are conditioned on the slot still being open. Two
 * concurrent callers therefore cannot both succeed: whichever commits second
 * sees `booked = 1`, inserts no row, and gets a BookingError('slot_taken').
 *
 * Throws BookingError for the two expected refusals, DbError for anything else.
 */
export async function createBooking(env, { slot_id, name, email, notes = null, source = "unknown" }) {
  const claimInsert = (db) =>
    db
      .prepare(
        `INSERT INTO bookings (slot_id, name, email, notes, source)
         SELECT ?1, ?2, ?3, ?4, ?5
          WHERE EXISTS (SELECT 1 FROM availability WHERE id = ?1 AND booked = 0)`
      )
      .bind(slot_id, name, email, notes, source);

  const markBooked = (db) =>
    db.prepare(`UPDATE availability SET booked = 1 WHERE id = ? AND booked = 0`).bind(slot_id);

  let inserted;
  try {
    const [insertResult] = await run(env, "createBooking", (db) =>
      db.batch([claimInsert(db), markBooked(db)])
    );
    inserted = insertResult;
  } catch (err) {
    // The UNIQUE index on bookings.slot_id is the backstop if availability
    // and bookings ever disagree about whether a slot is free.
    if (/UNIQUE|constraint/i.test(String(err?.cause?.message || err?.message))) {
      throw new BookingError("slot_taken", `Slot ${slot_id} is already booked.`);
    }
    throw err;
  }

  if (!inserted?.meta?.changes) {
    // Nothing inserted: either the slot doesn't exist or someone else has it.
    const slot = await getSlot(env, slot_id);
    if (!slot) throw new BookingError("slot_not_found", `No slot with id ${slot_id}.`);
    throw new BookingError("slot_taken", `Slot ${slot_id} is already booked.`);
  }

  const booking = await getBooking(env, inserted.meta.last_row_id);
  const slot = await getSlot(env, slot_id);
  return { ...booking, slot: slot ? shapeSlot(slot) : null };
}
