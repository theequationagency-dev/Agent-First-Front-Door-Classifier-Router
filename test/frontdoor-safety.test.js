/**
 * The settings that make the front door safe in front of a real site:
 * search engines and link previews get the site, "unknown" can be sent to the
 * site, same-host passthrough for a Cloudflare route, external booking, the
 * noindex header on everything JSON, and log retention.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import worker from "../src/index.js";
import mcpWorker from "../mcp/src/index.js";
import { purgeOldLogs } from "../src/observability.js";
import { createTestEnv, createTestCtx, rows } from "./helpers/d1.js";

const GOOGLEBOT = {
  "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  accept: "text/html,application/xhtml+xml,*/*;q=0.8",
};
const OLD_SAFARI = {
  // iOS 15 Safari sends no sec-fetch-* headers, so it lands in "unknown".
  "user-agent":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 15_7 like Mac OS X) AppleWebKit/605.1.15 " +
    "(KHTML, like Gecko) Version/15.6 Mobile/15E148 Safari/604.1",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};
const AGENT = { "user-agent": "Mozilla/5.0 (compatible; GPTBot/1.2)" };
const BOOKING_URL = "https://cal.com/example/strategy-call";

const req = (path, { headers = {}, ...init } = {}) =>
  new Request(`https://frontdoor.example.com${path}`, { headers: new Headers(headers), ...init });

async function call(request, envOverrides = {}) {
  const { env, sqlite } = createTestEnv(envOverrides);
  const { ctx, settled } = createTestCtx();
  const response = await worker.fetch(request, env, ctx);
  await settled();
  return { response, env, sqlite };
}

async function withStubbedOrigin(fn) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (input) => {
    calls.push(new Request(input));
    return new Response("<html><title>the site</title></html>", {
      headers: { "content-type": "text/html", "content-security-policy": "default-src 'self'" },
    });
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = real;
  }
}

// ---------------------------------------------------------------------------
// Search engines and link previews
// ---------------------------------------------------------------------------

test("Googlebot gets the website, not the payload, and is logged as search", async () => {
  await withStubbedOrigin(async (calls) => {
    const { response, sqlite } = await call(req("/servicios", { headers: GOOGLEBOT }));
    assert.equal(response.headers.get("x-served-as"), "search");
    assert.match(response.headers.get("content-type"), /text\/html/);
    assert.match(await response.text(), /the site/);
    assert.equal(calls.length, 1);
    assert.equal(new URL(calls[0].url).pathname, "/servicios");
    assert.deepEqual(rows(sqlite, "SELECT classification FROM request_log"), [
      { classification: "search" },
    ]);
  });
});

test("a WhatsApp link preview gets the website", async () => {
  await withStubbedOrigin(async () => {
    const { response } = await call(req("/", { headers: { "user-agent": "WhatsApp/2.23.20.0" } }));
    assert.equal(response.headers.get("x-served-as"), "search");
    assert.match(await response.text(), /the site/);
  });
});

test("the site's own headers (CSP) pass through untouched", async () => {
  await withStubbedOrigin(async () => {
    const { response } = await call(req("/", { headers: GOOGLEBOT }));
    assert.equal(response.headers.get("content-security-policy"), "default-src 'self'");
    assert.equal(response.headers.get("x-robots-tag"), null, "the site is not marked noindex");
  });
});

// ---------------------------------------------------------------------------
// UNKNOWN_SERVES
// ---------------------------------------------------------------------------

test("by default an unknown client still gets the payload", async () => {
  const { response } = await call(req("/", { headers: OLD_SAFARI }));
  assert.equal(response.headers.get("x-served-as"), "unknown");
  assert.match(response.headers.get("content-type"), /application\/json/);
});

test("UNKNOWN_SERVES=site sends an older iPhone to the website", async () => {
  await withStubbedOrigin(async () => {
    const { response } = await call(req("/", { headers: OLD_SAFARI }), { UNKNOWN_SERVES: "site" });
    assert.equal(response.headers.get("x-served-as"), "unknown");
    assert.match(await response.text(), /the site/);
  });
});

test("UNKNOWN_SERVES=site does not change what known agents get", async () => {
  const { response } = await call(req("/", { headers: AGENT }), { UNKNOWN_SERVES: "site" });
  assert.equal(response.headers.get("x-served-as"), "agent");
  assert.match(response.headers.get("content-type"), /application\/json/);
});

// ---------------------------------------------------------------------------
// ORIGIN_URL = "same-host"
// ---------------------------------------------------------------------------

test("same-host passthrough fetches the request itself, method, path and query intact", async () => {
  await withStubbedOrigin(async (calls) => {
    const { response } = await call(req("/contacto?x=1", { headers: GOOGLEBOT }), {
      ORIGIN_URL: "same-host",
    });
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://frontdoor.example.com/contacto?x=1");
    assert.equal(calls[0].method, "GET");
  });
});

test("same-host passthrough failing is a 502 and an incident", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network down");
  };
  try {
    const { response, sqlite } = await call(req("/", { headers: GOOGLEBOT }), { ORIGIN_URL: "same-host" });
    assert.equal(response.status, 502);
    assert.equal(rows(sqlite, "SELECT kind FROM incidents")[0].kind, "blocked_fetch");
  } finally {
    globalThis.fetch = real;
  }
});

// ---------------------------------------------------------------------------
// noindex on everything JSON
// ---------------------------------------------------------------------------

test("the payload, /api/*, agent.json and llms.txt all carry x-robots-tag: noindex", async () => {
  for (const [path, headers] of [
    ["/", AGENT],
    ["/api/services", AGENT],
    ["/.well-known/agent.json", {}],
    ["/llms.txt", {}],
  ]) {
    const { response } = await call(req(path, { headers }));
    assert.equal(response.headers.get("x-robots-tag"), "noindex", path);
  }
});

// ---------------------------------------------------------------------------
// BOOKING_URL (external booking)
// ---------------------------------------------------------------------------

test("with BOOKING_URL the payload offers the booking page and no slots", async () => {
  const { response } = await call(req("/", { headers: AGENT }), {
    BOOKING_URL,
    SITE_LANGUAGE: "es-419",
    CONTACT_URL: "https://frontdoor.example.com/contacto",
  });
  const body = await response.json();
  assert.deepEqual(body.actions.map((a) => a.name), ["get_services", "book_call"]);
  const book = body.actions.find((a) => a.name === "book_call");
  assert.equal(book.url, BOOKING_URL);
  assert.equal(book.method, "GET");
  assert.deepEqual(body.availability, []);
  assert.equal(body.site.language, "es-419");
  assert.equal(body.site.contact_page, "https://frontdoor.example.com/contacto");
});

test("with BOOKING_URL, /api/book and /api/availability are off and write nothing", async () => {
  const book = await call(
    req("/api/book", {
      method: "POST",
      headers: { ...AGENT, "content-type": "application/json" },
      body: JSON.stringify({ slot_id: 1, name: "A", email: "a@example.com" }),
    }),
    { BOOKING_URL }
  );
  assert.equal(book.response.status, 404);
  const err = (await book.response.json()).error;
  assert.equal(err.code, "booking_external");
  assert.equal(err.booking_url, BOOKING_URL);
  assert.equal(rows(book.sqlite, "SELECT COUNT(*) AS n FROM bookings")[0].n, 0);

  const avail = await call(req("/api/availability", { headers: AGENT }), { BOOKING_URL });
  assert.equal(avail.response.status, 404);
});

test("a BOOKING_URL that is not https is ignored rather than advertised", async () => {
  const { response } = await call(req("/", { headers: AGENT }), { BOOKING_URL: "javascript:alert(1)" });
  const body = await response.json();
  assert.ok(body.actions.some((a) => a.name === "book_consult"));
  assert.ok(!JSON.stringify(body).includes("javascript:"));
});

test("llms.txt lists the booking page in external mode", async () => {
  const { response } = await call(req("/llms.txt"), { BOOKING_URL });
  const text = await response.text();
  assert.match(text, new RegExp(`\\[book_call\\]\\(${BOOKING_URL.replace(/[.]/g, "\\.")}\\)`));
  assert.doesNotMatch(text, /## Availability/);
});

test("with BOOKING_URL the MCP server offers get_booking_link and no booking tools", async () => {
  const { env } = createTestEnv({ BOOKING_URL });
  const ctx = { waitUntil: () => {} };
  const root = await (await mcpWorker.fetch(new Request("https://mcp.example.com/"), env, ctx)).json();
  assert.deepEqual(root.tools, ["get_services", "get_booking_link"]);

  const rpc = async (message) => {
    const r = await mcpWorker.fetch(
      new Request("https://mcp.example.com/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify(message),
      }),
      env,
      ctx
    );
    return JSON.parse(await r.text());
  };
  const list = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  assert.deepEqual(list.result.tools.map((t) => t.name).sort(), ["get_booking_link", "get_services"]);
  const link = await rpc({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "get_booking_link", arguments: {} },
  });
  assert.equal(link.result.structuredContent.booking_url, BOOKING_URL);
});

// ---------------------------------------------------------------------------
// services.url
// ---------------------------------------------------------------------------

test("a service's url is in the payload when set, null when not", async () => {
  const { env, sqlite } = createTestEnv();
  sqlite.exec("UPDATE services SET url = 'https://frontdoor.example.com/servicios/seo' WHERE id = 1");
  const { ctx, settled } = createTestCtx();
  const response = await worker.fetch(req("/api/services", { headers: AGENT }), env, ctx);
  await settled();
  const { services } = await response.json();
  const byId = Object.fromEntries(services.map((s) => [s.id, s]));
  assert.equal(byId[1].url, "https://frontdoor.example.com/servicios/seo");
  assert.equal(byId[2].url, null);
});

// ---------------------------------------------------------------------------
// Log retention
// ---------------------------------------------------------------------------

test("purgeOldLogs drops request_log rows past the window and keeps the rest", async () => {
  const { env, sqlite } = createTestEnv({ LOG_RETENTION_DAYS: "30" });
  const now = Date.UTC(2026, 9, 22);
  const day = 86400;
  const t = Math.floor(now / 1000);
  sqlite.exec(`INSERT INTO request_log (path, user_agent, classification, created_at) VALUES
    ('/old', 'x', 'agent', ${t - 31 * day}), ('/new', 'x', 'agent', ${t - 29 * day})`);
  sqlite.exec(`INSERT INTO incidents (path, kind, detail, created_at) VALUES
    ('/old', 'other', 'x', ${t - 91 * day}), ('/new', 'other', 'x', ${t - 89 * day})`);

  const result = await purgeOldLogs(env, now);
  assert.equal(result.ok, true);
  assert.deepEqual(rows(sqlite, "SELECT path FROM request_log"), [{ path: "/new" }]);
  assert.deepEqual(rows(sqlite, "SELECT path FROM incidents"), [{ path: "/new" }]);
});

test("purgeOldLogs never throws, and the cron handler calls it", async () => {
  assert.equal((await purgeOldLogs({})).ok, false);
  const broken = { DB: { prepare() { throw new Error("D1 down"); }, batch() { throw new Error("D1 down"); } } };
  assert.equal((await purgeOldLogs(broken)).ok, false);

  const { env, sqlite } = createTestEnv();
  sqlite.exec(`INSERT INTO request_log (path, user_agent, classification, created_at) VALUES ('/ancient', 'x', 'agent', 1)`);
  const { ctx, settled } = createTestCtx();
  await worker.scheduled({ cron: "17 4 * * *" }, env, ctx);
  await settled();
  assert.deepEqual(rows(sqlite, "SELECT path FROM request_log WHERE path = '/ancient'"), []);
});

test("llms.txt links a service to its page when it has one", async () => {
  const { env, sqlite } = createTestEnv();
  sqlite.exec("UPDATE services SET url = 'https://frontdoor.example.com/servicios/seo' WHERE id = 1");
  const name = rows(sqlite, "SELECT name FROM services WHERE id = 1")[0].name;
  const { ctx } = createTestCtx();
  const text = await (await worker.fetch(req("/llms.txt"), env, ctx)).text();
  assert.ok(text.includes(`- [${name}](https://frontdoor.example.com/servicios/seo)`), text);
});
