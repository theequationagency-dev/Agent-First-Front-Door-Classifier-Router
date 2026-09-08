/**
 * The MCP server Worker.
 *
 * Two layers of coverage: raw JSON-RPC over the Streamable HTTP endpoint
 * (the wire contract), and one round trip driven by the official SDK client
 * against the Worker served over real HTTP (proof a real client can connect).
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "node:http";
import { Readable } from "node:stream";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import mcpWorker from "../mcp/src/index.js";
import { createTestEnv, rows } from "./helpers/d1.js";

const ctx = { waitUntil: () => {} };
const ACCEPT = "application/json, text/event-stream";

/** POSTs one JSON-RPC message to the Worker and returns the parsed result. */
async function rpc(env, message) {
  const response = await mcpWorker.fetch(
    new Request("https://mcp.example.com/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: ACCEPT },
      body: JSON.stringify(message),
    }),
    env,
    ctx
  );
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

const callTool = (env, name, args = {}) =>
  rpc(env, { jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } });

// ---------------------------------------------------------------------------

test("the root advertises the endpoint and the tool names", async () => {
  const { env } = createTestEnv();
  const response = await mcpWorker.fetch(new Request("https://mcp.example.com/"), env, ctx);
  const body = await response.json();
  assert.equal(body.endpoint, "https://mcp.example.com/mcp");
  assert.deepEqual(body.tools, ["get_services", "check_availability", "book_consult"]);
});

test("initialize and tools/list expose exactly the three capabilities", async () => {
  const { env } = createTestEnv();

  const init = await rpc(env, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
  });
  assert.equal(init.status, 200);
  assert.equal(init.body.result.serverInfo.name, "equation-agency-front-door");

  const list = await rpc(env, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  assert.deepEqual(
    list.body.result.tools.map((t) => t.name).sort(),
    ["book_consult", "check_availability", "get_services"]
  );
});

test("get_services returns the same rows the HTTP API serves", async () => {
  const { env } = createTestEnv();
  const { body } = await callTool(env, "get_services");
  const structured = body.result.structuredContent;
  assert.equal(structured.count, 3);
  assert.equal(structured.services[0].price.display, "$300");
  // The text block is the same object, for clients that only read text.
  assert.deepEqual(JSON.parse(body.result.content[0].text), structured);
});

test("check_availability returns bookable slot ids", async () => {
  const { env } = createTestEnv();
  const { body } = await callTool(env, "check_availability", { limit: 2 });
  const structured = body.result.structuredContent;
  assert.equal(structured.count, 2);
  assert.ok(Number.isInteger(structured.availability[0].slot_id));
});

test("book_consult writes a booking tagged source=mcp", async () => {
  const { env, sqlite } = createTestEnv();
  const slots = (await callTool(env, "check_availability")).body.result.structuredContent.availability;

  const { body } = await callTool(env, "book_consult", {
    slot_id: slots[0].slot_id,
    name: "Grace Hopper",
    email: "grace@example.com",
    notes: "Wants the audit",
  });

  assert.equal(body.result.structuredContent.booked, true);
  assert.equal(body.result.structuredContent.slot_id, slots[0].slot_id);

  const stored = rows(sqlite, "SELECT name, email, source FROM bookings");
  assert.deepEqual(stored, [{ name: "Grace Hopper", email: "grace@example.com", source: "mcp" }]);

  const remaining = (await callTool(env, "check_availability")).body.result.structuredContent;
  assert.ok(!remaining.availability.some((s) => s.slot_id === slots[0].slot_id));
});

test("book_consult refuses a taken slot with an instruction, not a crash", async () => {
  const { env } = createTestEnv();
  const args = { slot_id: 1, name: "First", email: "first@example.com" };
  await callTool(env, "book_consult", args);

  const { body } = await callTool(env, "book_consult", { ...args, name: "Second" });
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /already booked/i);
  assert.match(body.result.content[0].text, /check_availability/);
});

test("book_consult refuses an unknown slot", async () => {
  const { env } = createTestEnv();
  const { body } = await callTool(env, "book_consult", {
    slot_id: 9999,
    name: "Nobody",
    email: "nobody@example.com",
  });
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /No slot with id 9999/);
});

test("bad tool arguments are rejected before reaching D1", async () => {
  const { env, sqlite } = createTestEnv();
  const { body } = await callTool(env, "book_consult", {
    slot_id: 1,
    name: "Ada",
    email: "not-an-email",
  });
  assert.ok(body.error || body.result?.isError, "the call fails");
  assert.equal(rows(sqlite, "SELECT * FROM bookings").length, 0);
});

test("a D1 failure inside a tool becomes an mcp_tool_failure incident", async () => {
  const { env, sqlite } = createTestEnv();
  const broken = {
    ...env,
    DB: {
      prepare(sql) {
        if (/^\s*insert/i.test(sql)) return env.DB.prepare(sql);
        throw new Error("D1_ERROR: table is gone");
      },
    },
  };

  const { body } = await callTool(broken, "get_services");
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /temporarily unavailable/);

  const incidents = rows(sqlite, "SELECT path, kind, detail FROM incidents");
  assert.equal(incidents[0].kind, "mcp_tool_failure");
  assert.equal(incidents[0].path, "mcp:get_services");
  assert.match(incidents[0].detail, /table is gone/);
});

// ---------------------------------------------------------------------------
// One full round trip with the official client, over real HTTP.
// ---------------------------------------------------------------------------

test("the official MCP client can connect, list tools and book a slot", async (t) => {
  const { env, sqlite } = createTestEnv();

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = new Request(`http://localhost${req.url}`, {
      method: req.method,
      headers: req.headers,
      body: chunks.length ? Buffer.concat(chunks) : undefined,
    });
    const response = await mcpWorker.fetch(request, env, ctx);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) Readable.fromWeb(response.body).pipe(res);
    else res.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  await client.connect(transport);

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "book_consult",
    "check_availability",
    "get_services",
  ]);

  const availability = await client.callTool({ name: "check_availability", arguments: {} });
  const slot = availability.structuredContent.availability[0];

  const booked = await client.callTool({
    name: "book_consult",
    arguments: { slot_id: slot.slot_id, name: "Katherine Johnson", email: "kj@example.com" },
  });
  assert.equal(booked.structuredContent.booked, true);
  assert.equal(rows(sqlite, "SELECT source FROM bookings")[0].source, "mcp");

  await client.close();
});
