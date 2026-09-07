/**
 * Classifier tests. No dependencies — Node 18+ provides Request/Headers,
 * and classifyRequest touches nothing else from the Workers runtime.
 *
 *   npm test
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import worker, { classifyRequest, buildAgentPayload } from "../src/index.js";

const BROWSER_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-ch-ua": '"Chromium";v="128"',
};

const req = (url, headers = {}) =>
  new Request(url, { headers: new Headers(headers) });

test("mcp: path prefix", () => {
  assert.equal(classifyRequest(req("https://example.com/mcp")), "mcp");
  assert.equal(classifyRequest(req("https://example.com/mcp/tools")), "mcp");
});

test("mcp: session and client headers", () => {
  assert.equal(
    classifyRequest(req("https://example.com/", { "mcp-session-id": "abc" })),
    "mcp"
  );
  assert.equal(
    classifyRequest(req("https://example.com/", { "x-mcp-client": "claude" })),
    "mcp"
  );
});

test("mcp beats a browser-shaped request", () => {
  assert.equal(
    classifyRequest(req("https://example.com/mcp", BROWSER_HEADERS)),
    "mcp"
  );
});

test("agent: known crawler user agents", () => {
  for (const ua of [
    "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)",
    "Mozilla/5.0 (compatible; ClaudeBot/1.0)",
    "curl/8.4.0",
    "python-requests/2.32.3",
    "axios/1.7.2",
  ]) {
    assert.equal(
      classifyRequest(req("https://example.com/", { "user-agent": ua })),
      "agent",
      ua
    );
  }
});

test("agent: json preferred over html", () => {
  assert.equal(
    classifyRequest(
      req("https://example.com/", {
        ...BROWSER_HEADERS,
        accept: "application/json",
      })
    ),
    "agent"
  );
});

test("agent: no user-agent at all", () => {
  assert.equal(classifyRequest(req("https://example.com/", {})), "agent");
});

test("unknown: html-accepting client with no browser fingerprint", () => {
  assert.equal(
    classifyRequest(
      req("https://example.com/", {
        "user-agent": "SomeInternalScraper/2.0",
        accept: "text/html",
      })
    ),
    "unknown"
  );
});

test("human: ordinary browser navigation", () => {
  assert.equal(classifyRequest(req("https://example.com/", BROWSER_HEADERS)), "human");
});

test("agent responses carry classification and vary headers", async () => {
  const ctx = { waitUntil: (p) => p };
  const res = await worker.fetch(req("https://example.com/mcp"), {}, ctx);

  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-served-as"), "mcp");
  assert.match(res.headers.get("content-type"), /application\/json/);
  assert.equal(res.headers.get("vary"), "user-agent, accept");

  const body = await res.json();
  assert.ok(Array.isArray(body.actions) && body.actions.length > 0);
});

test("human traffic is proxied to ORIGIN_URL with the path preserved", async () => {
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    seen.push(new Request(input).url);
    return new Response("<html></html>", {
      headers: { "content-type": "text/html", vary: "accept-encoding" },
    });
  };

  try {
    const res = await worker.fetch(
      req("https://example.com/pricing?plan=pro", BROWSER_HEADERS),
      { ORIGIN_URL: "https://origin.example.net" },
      { waitUntil: (p) => p }
    );

    assert.deepEqual(seen, ["https://origin.example.net/pricing?plan=pro"]);
    assert.equal(res.headers.get("x-served-as"), "human");
    // Origin's own Vary is kept, ours is added on top.
    assert.equal(res.headers.get("vary"), "accept-encoding, user-agent, accept");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("payload exposes the mcp server as the preferred entry point", async () => {
  const payload = await buildAgentPayload({}, req("https://example.com/"));
  assert.ok(payload.mcp_server.url.startsWith("https://"));
  assert.ok(!Number.isNaN(Date.parse(payload.generated_at)));
});
