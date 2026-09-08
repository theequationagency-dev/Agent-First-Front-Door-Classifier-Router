/**
 * Data layer, against the real schema and the real SQL (node:sqlite).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  listActiveServices,
  listOpenSlots,
  createBooking,
  getSlot,
  BookingError,
  DbError,
} from "../src/db.js";
import { createTestEnv, rows } from "./helpers/d1.js";

test("seed data loads and only active services are listed", async () => {
  const { env, sqlite } = createTestEnv();
  sqlite.exec("INSERT INTO services (name, description, price_cents, active) VALUES ('Retired', 'x', 100, 0)");

  const services = await listActiveServices(env);
  assert.equal(services.length, 3);
  assert.ok(!services.some((s) => s.name === "Retired"));

  const cheapest = services[0];
  assert.equal(cheapest.name, "Digital Marketing Audit");
  assert.equal(cheapest.price.amount_cents, 30000);
  assert.equal(cheapest.price.display, "$300");
});

test("availability lists only future, unbooked slots", async () => {
  const { env, sqlite } = createTestEnv();
  const past = Math.floor(Date.now() / 1000) - 3600;
  sqlite.exec(`INSERT INTO availability (slot_start, slot_end, booked) VALUES (${past}, ${past + 3600}, 0)`);
  sqlite.exec("UPDATE availability SET booked = 1 WHERE id = 1");

  const slots = await listOpenSlots(env);
  const ids = slots.map((s) => s.slot_id);
  assert.ok(!ids.includes(1), "booked slot is excluded");
  assert.equal(slots.length, 2, "past slot is excluded");
  assert.ok(slots[0].start.endsWith("Z"), "start is ISO for agents");
  assert.equal(typeof slots[0].start_unix, "number");
});

test("availability honours from/to/limit", async () => {
  const { env } = createTestEnv();
  const all = await listOpenSlots(env);
  assert.equal((await listOpenSlots(env, { limit: 1 })).length, 1);

  const cutoff = all[0].start_unix;
  const upTo = await listOpenSlots(env, { to: cutoff });
  assert.equal(upTo.length, 1);

  const after = await listOpenSlots(env, { from: cutoff + 1 });
  assert.equal(after.length, all.length - 1);
});

test("booking claims the slot and records the source", async () => {
  const { env, sqlite } = createTestEnv();
  const [slot] = await listOpenSlots(env);

  const booking = await createBooking(env, {
    slot_id: slot.slot_id,
    name: "Ada Lovelace",
    email: "ada@example.com",
    notes: "Interested in the audit",
    source: "mcp",
  });

  assert.equal(booking.slot_id, slot.slot_id);
  assert.equal(booking.source, "mcp");
  assert.equal(booking.slot.start, slot.start);
  assert.ok(booking.booking_id > 0);

  const stored = await getSlot(env, slot.slot_id);
  assert.equal(stored.booked, 1, "slot is marked booked");
  assert.equal(rows(sqlite, "SELECT * FROM bookings").length, 1);

  const open = await listOpenSlots(env);
  assert.ok(!open.some((s) => s.slot_id === slot.slot_id), "slot leaves availability");
});

test("a second booking for the same slot is refused, and writes nothing", async () => {
  const { env, sqlite } = createTestEnv();
  const [slot] = await listOpenSlots(env);
  const args = { slot_id: slot.slot_id, name: "First", email: "first@example.com", source: "agent" };

  await createBooking(env, args);
  await assert.rejects(
    () => createBooking(env, { ...args, name: "Second", email: "second@example.com" }),
    (err) => err instanceof BookingError && err.code === "slot_taken"
  );

  const bookings = rows(sqlite, "SELECT name FROM bookings");
  assert.deepEqual(bookings.map((b) => b.name), ["First"], "no orphan booking row");
});

test("booking an unknown slot is refused distinctly", async () => {
  const { env } = createTestEnv();
  await assert.rejects(
    () => createBooking(env, { slot_id: 9999, name: "N", email: "n@example.com" }),
    (err) => err instanceof BookingError && err.code === "slot_not_found"
  );
});

test("the unique index is a backstop if availability and bookings disagree", async () => {
  const { env, sqlite } = createTestEnv();
  const [slot] = await listOpenSlots(env);
  // A booking exists but the slot was never flagged — the state the app code
  // cannot produce, but a manual SQL edit can.
  sqlite.exec(
    `INSERT INTO bookings (slot_id, name, email, source) VALUES (${slot.slot_id}, 'Manual', 'm@example.com', 'human')`
  );

  await assert.rejects(
    () => createBooking(env, { slot_id: slot.slot_id, name: "N", email: "n@example.com" }),
    (err) => err instanceof BookingError && err.code === "slot_taken"
  );
});

test("a missing D1 binding raises DbError rather than a TypeError", async () => {
  await assert.rejects(() => listActiveServices({}), (err) => err instanceof DbError);
});
