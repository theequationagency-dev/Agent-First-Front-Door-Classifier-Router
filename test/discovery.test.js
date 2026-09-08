/**
 * /llms.txt and /.well-known/agent.json — the two stable discovery URLs.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import worker from "../src/index.js";
import { renderLlmsTxt } from "../src/routes/discovery.js";
import { createTestEnv, createTestCtx } from "./helpers/d1.js";

const BROWSER_HEADERS = {
  "user-agent": "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/128.0.0.0 Safari/537.36",
  accept: "text/html",
  "sec-fetch-mode": "navigate",
  "sec-ch-ua": '"Chromium";v="128"',
};

const req = (path, headers = {}) =>
  new Request(`https://frontdoor.example.com${path}`, { headers: new Headers(headers) });

async function call(path, headers = {}, overrides = {}) {
  const { env, sqlite } = createTestEnv(overrides);
  const { ctx, settled } = createTestCtx();
  const response = await worker.fetch(req(path, headers), env, ctx);
  await settled();
  return { response, env, sqlite };
}

test("/.well-known/agent.json returns the payload to anyone", async () => {
  const { response } = await call("/.well-known/agent.json", BROWSER_HEADERS);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-served-as"), "discovery");
  const body = await response.json();
  assert.equal(body.services.length, 3);
  assert.equal(body.discovery.llms_txt, "https://frontdoor.example.com/llms.txt");
});

test("/llms.txt is plain text in the llms.txt shape", async () => {
  const { response } = await call("/llms.txt", BROWSER_HEADERS, {
    SITE_NAME: "Example Co",
    SITE_DESCRIPTION: "We do a thing.",
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/plain/);

  const text = await response.text();
  const lines = text.split("\n");
  assert.equal(lines[0], "# Example Co", "H1 first");
  assert.equal(lines[2], "> We do a thing.", "blockquote summary second");
  assert.match(text, /^## Actions$/m);
  assert.match(text, /^## Services$/m);
  assert.match(text, /^## Availability$/m);
  assert.match(text, /- \[book_consult\]\(https:\/\/frontdoor\.example\.com\/api\/book\): POST/);
});

test("/llms.txt lists the live rows, not a hand-written copy", async () => {
  const { env, sqlite } = createTestEnv();
  sqlite.exec("UPDATE services SET active = 0 WHERE name = 'Audit'");
  sqlite.exec("INSERT INTO services (name, description, price_cents, active) VALUES ('New Thing', 'Fresh.', 1000, 1)");

  const response = await worker.fetch(req("/llms.txt"), env, { waitUntil: () => {} });
  const text = await response.text();
  assert.match(text, /- New Thing \(\$10\): Fresh\./);
  assert.ok(!text.includes("- Audit "), "a deactivated service disappears on the next request");
});

test("llms.txt survives a degraded payload", () => {
  const text = renderLlmsTxt({
    status: "degraded",
    site: { name: "Example Co", url: "https://example.com" },
    actions: [],
    services: [],
    availability: [],
    generated_at: new Date().toISOString(),
  });
  assert.match(text, /^# Example Co$/m);
  assert.match(text, /temporarily unavailable/);
});

test("the MCP section only appears when an MCP server is configured", async () => {
  const withMcp = await call("/llms.txt", {}, { MCP_SERVER_URL: "https://mcp.example.com" });
  assert.match(await withMcp.response.text(), /^## MCP$/m);

  const without = await call("/llms.txt", {});
  assert.ok(!(await without.response.text()).includes("## MCP"));
});

test("discovery URLs are not gated on classification", async () => {
  for (const headers of [BROWSER_HEADERS, { "user-agent": "GPTBot" }, {}]) {
    const { response } = await call("/llms.txt", headers);
    assert.equal(response.status, 200);
  }
});
