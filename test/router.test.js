/**
 * The Worker end to end: classification, the D1-backed payload, /api/*,
 * /admin/*, the human passthrough, and what lands in request_log/incidents.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import worker from "../src/index.js";
import { createTestEnv, createTestCtx, rows } from "./helpers/d1.js";

const BROWSER_HEADERS = {
  "user-agent": "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/128.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-ch-ua": '"Chromium";v="128"',
};
const AGENT_HEADERS = { "user-agent": "Mozilla/5.0 (compatible; GPTBot/1.2)" };

const req = (path, { headers = {}, ...init } = {}) =>
  new Request(`https://frontdoor.example.com${path}`, { headers: new Headers(headers), ...init });

/** Runs one request against the Worker and waits for its waitUntil work. */
async function call(request, envOverrides = {}) {
  const { env, sqlite } = createTestEnv(envOverrides);
  const { ctx, settled } = createTestCtx();
  const response = await worker.fetch(request, env, ctx);
  await settled();
  return { response, env, sqlite };
}

/** Swaps global fetch for one that records calls and returns a canned page. */
async function withStubbedOrigin(fn, originResponse) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (input) => {
    calls.push(new Request(input));
    if (typeof originResponse === "function") return originResponse();
    return (
      originResponse ||
      new Response("<html>the site</html>", {
        headers: { "content-type": "text/html", vary: "accept-encoding" },
      })
    );
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = real;
  }
}

// ---------------------------------------------------------------------------
// The two response bodies
// ---------------------------------------------------------------------------

test("agents get the payload, populated from D1", async () => {
  const { response } = await call(req("/", { headers: AGENT_HEADERS }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-served-as"), "agent");
  assert.equal(response.headers.get("vary"), "user-agent, accept");

  const body = await response.json();
  assert.equal(body.status, "ok");
  assert.equal(body.services.length, 3, "services come from the seeded D1 rows");
  assert.equal(body.availability.length, 3);
  assert.deepEqual(
    body.actions.map((a) => a.name),
    ["get_services", "check_availability", "book_consult"]
  );
  assert.equal(body.actions[0].url, "https://frontdoor.example.com/api/services");
  assert.deepEqual(body.mcp_server.tools, ["get_services", "check_availability", "book_consult"]);
});

test("the payload advertises only slots the booking endpoint would accept", async () => {
  const { response, env } = await call(req("/", { headers: AGENT_HEADERS }));
  const body = await response.json();
  const advertised = body.availability.map((s) => s.slot_id).sort();
  const api = await worker.fetch(req("/api/availability", { headers: AGENT_HEADERS }), env, {
    waitUntil: () => {},
  });
  const fromApi = (await api.json()).availability.map((s) => s.slot_id).sort();
  assert.deepEqual(advertised, fromApi);
});

test("humans are proxied to ORIGIN_URL with path and query preserved", async () => {
  await withStubbedOrigin(async (calls) => {
    const { response } = await call(req("/pricing?plan=pro", { headers: BROWSER_HEADERS }));

    assert.deepEqual(
      calls.map((c) => c.url),
      ["https://origin.example.net/pricing?plan=pro"]
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-served-as"), "human");
    assert.equal(await response.text(), "<html>the site</html>");
    // The origin's own Vary survives; ours is added on top.
    assert.equal(response.headers.get("vary"), "accept-encoding, user-agent, accept");
  });
});

test("a passthrough loop is refused instead of recursing", async () => {
  const { response, sqlite } = await call(req("/", { headers: BROWSER_HEADERS }), {
    ORIGIN_URL: "https://frontdoor.example.com",
  });
  assert.equal(response.status, 508);
  const incidents = rows(sqlite, "SELECT kind, detail FROM incidents");
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].kind, "blocked_fetch");
  assert.match(incidents[0].detail, /loop/);
});

test("an unreachable origin is a 502 and a blocked_fetch incident", async () => {
  await withStubbedOrigin(async () => {
    const { response, sqlite } = await call(req("/", { headers: BROWSER_HEADERS }));
    assert.equal(response.status, 502);
    const incidents = rows(sqlite, "SELECT kind, detail FROM incidents");
    assert.equal(incidents[0].kind, "blocked_fetch");
    assert.match(incidents[0].detail, /origin.example.net/);
  }, () => {
    throw new TypeError("connection refused");
  });
});

test("a rate-limited origin is passed through and recorded", async () => {
  await withStubbedOrigin(
    async () => {
      const { response, sqlite } = await call(req("/", { headers: BROWSER_HEADERS }));
      assert.equal(response.status, 429, "the origin's own response still reaches the human");
      assert.equal(rows(sqlite, "SELECT kind FROM incidents")[0].kind, "rate_limit");
    },
    new Response("slow down", { status: 429 })
  );
});

// ---------------------------------------------------------------------------
// The advertised API
// ---------------------------------------------------------------------------

test("GET /api/services returns the active services", async () => {
  const { response } = await call(req("/api/services", { headers: AGENT_HEADERS }));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.count, 3);
  assert.equal(body.services[0].price.currency, "USD");
});

test("GET /api/availability returns open slots and honours limit", async () => {
  const { response } = await call(req("/api/availability?limit=2", { headers: AGENT_HEADERS }));
  const body = await response.json();
  assert.equal(body.count, 2);
  assert.equal(body.availability.length, 2);
});

test("POST /api/book books a slot and tags the source from the classification", async () => {
  const { env, sqlite } = createTestEnv();
  const ctx = { waitUntil: () => {} };
  const listed = await (await worker.fetch(req("/api/availability", { headers: AGENT_HEADERS }), env, ctx)).json();
  const slotId = listed.availability[0].slot_id;

  const response = await worker.fetch(
    req("/api/book", {
      method: "POST",
      headers: { ...AGENT_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({ slot_id: slotId, name: "Ada", email: "ada@example.com" }),
    }),
    env,
    ctx
  );

  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.booked, true);
  assert.equal(body.booking.slot_id, slotId);
  assert.equal(rows(sqlite, "SELECT source FROM bookings")[0].source, "agent");
});

test("double booking through the API is a 409 with a next action", async () => {
  const { env } = createTestEnv();
  const ctx = { waitUntil: () => {} };
  const post = () =>
    worker.fetch(
      req("/api/book", {
        method: "POST",
        headers: { ...AGENT_HEADERS, "content-type": "application/json" },
        body: JSON.stringify({ slot_id: 1, name: "Ada", email: "ada@example.com" }),
      }),
      env,
      ctx
    );

  assert.equal((await post()).status, 201);
  const second = await post();
  assert.equal(second.status, 409);
  const body = await second.json();
  assert.equal(body.error.code, "slot_taken");
  assert.match(body.error.next_action, /availability/);
});

test("invalid booking input is a 400 naming the field", async () => {
  const cases = [
    [{ name: "Ada", email: "ada@example.com" }, "slot_id"],
    [{ slot_id: 1, email: "ada@example.com" }, "name"],
    [{ slot_id: 1, name: "Ada", email: "not-an-email" }, "email"],
    [{ slot_id: 1, name: "Ada", email: "ada@example.com", notes: 42 }, "notes"],
  ];
  for (const [payload, field] of cases) {
    const { response } = await call(
      req("/api/book", {
        method: "POST",
        headers: { ...AGENT_HEADERS, "content-type": "application/json" },
        body: JSON.stringify(payload),
      })
    );
    assert.equal(response.status, 400, field);
    const body = await response.json();
    assert.equal(body.error.code, "invalid_request");
    assert.equal(body.error.field, field);
  }
});

test("a non-JSON booking body is rejected before touching D1", async () => {
  const { response, sqlite } = await call(
    req("/api/book", { method: "POST", headers: AGENT_HEADERS, body: "slot_id=1" })
  );
  assert.equal(response.status, 400);
  assert.equal(rows(sqlite, "SELECT * FROM bookings").length, 0);
});

test("wrong methods are 405, and OPTIONS preflight succeeds", async () => {
  const { response: get } = await call(req("/api/book", { headers: AGENT_HEADERS }));
  assert.equal(get.status, 405);

  const { response: options } = await call(req("/api/services", { method: "OPTIONS", headers: AGENT_HEADERS }));
  assert.equal(options.status, 204);
  assert.equal(options.headers.get("access-control-allow-origin"), "*");
});

test("humans reach the API too — it is not gated on classification", async () => {
  const { response } = await call(req("/api/services", { headers: BROWSER_HEADERS }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).count, 3);
});

// ---------------------------------------------------------------------------
// Logging, incidents, admin
// ---------------------------------------------------------------------------

test("every request is written to request_log", async () => {
  const { env, sqlite } = createTestEnv();
  const { ctx, settled } = createTestCtx();
  await worker.fetch(req("/", { headers: AGENT_HEADERS }), env, ctx);
  await worker.fetch(req("/api/services", { headers: { "user-agent": "Scraper/1.0", accept: "text/html" } }), env, ctx);
  await settled();

  const logged = rows(sqlite, "SELECT path, classification FROM request_log ORDER BY id");
  assert.deepEqual(logged, [
    { path: "/", classification: "agent" },
    { path: "/api/services", classification: "unknown" },
  ]);
});

test("a D1 failure degrades the payload instead of 500ing, and records an incident", async () => {
  const { env, sqlite } = createTestEnv();
  const broken = {
    ...env,
    DB: {
      prepare(sql) {
        // Let the log/incident inserts through; break the payload reads.
        if (/^\s*insert/i.test(sql)) return env.DB.prepare(sql);
        throw new Error("D1_ERROR: no such table");
      },
      batch: (s) => env.DB.batch(s),
    },
  };
  const { ctx, settled } = createTestCtx();
  const response = await worker.fetch(req("/", { headers: AGENT_HEADERS }), broken, ctx);
  await settled();

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "degraded");
  assert.deepEqual(body.services, []);
  assert.ok(body.mcp_server.url, "the agent can still fall back to MCP");
  assert.match(body.degraded_reason, /temporarily unavailable/);

  const incidents = rows(sqlite, "SELECT kind, detail FROM incidents");
  assert.equal(incidents[0].kind, "db_error");
  assert.match(incidents[0].detail, /buildAgentPayload/);
});

test("an API-level D1 failure is a 503 plus a db_error incident", async () => {
  const { env, sqlite } = createTestEnv();
  const broken = {
    ...env,
    DB: {
      prepare(sql) {
        if (/^\s*insert/i.test(sql)) return env.DB.prepare(sql);
        throw new Error("D1_ERROR: connection lost");
      },
    },
  };
  const { ctx, settled } = createTestCtx();
  const response = await worker.fetch(req("/api/services", { headers: AGENT_HEADERS }), broken, ctx);
  await settled();

  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "upstream_unavailable");
  const incidents = rows(sqlite, "SELECT kind, detail FROM incidents");
  assert.equal(incidents[0].kind, "db_error");
  assert.match(incidents[0].detail, /connection lost/);
});

test("/admin/classification-report needs the token", async () => {
  const { response: anon } = await call(req("/admin/classification-report", { headers: AGENT_HEADERS }));
  assert.equal(anon.status, 401);

  const { response: wrong } = await call(
    req("/admin/classification-report", { headers: { ...AGENT_HEADERS, "x-admin-token": "nope" } })
  );
  assert.equal(wrong.status, 401);
});

test("/admin/classification-report fails closed when ADMIN_TOKEN is unset", async () => {
  const { response } = await call(
    req("/admin/classification-report", { headers: { ...AGENT_HEADERS, "x-admin-token": "anything" } }),
    { ADMIN_TOKEN: undefined }
  );
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "admin_not_configured");
});

test("/admin/classification-report summarises traffic, the unknown bucket and incidents", async () => {
  const { env, sqlite } = createTestEnv();
  const { ctx, settled } = createTestCtx();

  await worker.fetch(req("/", { headers: AGENT_HEADERS }), env, ctx);
  for (let i = 0; i < 2; i++) {
    await worker.fetch(
      req("/", { headers: { "user-agent": "MysteryFetcher/3.1", accept: "text/html" } }),
      env,
      ctx
    );
  }
  await settled();
  sqlite.exec("INSERT INTO incidents (path, kind, detail) VALUES ('/api/book', 'db_error', 'boom')");

  const response = await worker.fetch(
    req("/admin/classification-report", { headers: { authorization: "Bearer test-admin-token" } }),
    env,
    ctx
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");

  const report = await response.json();
  assert.equal(report.totals.by_classification.unknown, 2);
  // The report request is itself classified and logged (no UA -> agent), so
  // it counts alongside the GPTBot hit above.
  assert.equal(report.totals.by_classification.agent, 2);
  assert.equal(report.unknown_bucket.top_user_agents[0].user_agent, "MysteryFetcher/3.1");
  assert.equal(report.unknown_bucket.top_user_agents[0].requests, 2);
  assert.equal(report.unknown_bucket.recent.length, 2);
  assert.equal(report.incidents.by_kind.db_error, 1);
  assert.equal(report.incidents.recent[0].path, "/api/book");
});
