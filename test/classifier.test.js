/**
 * Classifier rules. No database, no network — just headers in, bucket out.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyRequest,
  bookingSourceFor,
  SEARCH_AND_PREVIEW_UA,
  KNOWN_AGENT_UA,
} from "../src/classifier.js";

const BROWSER_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-ch-ua": '"Chromium";v="128"',
};

const req = (url, headers = {}) => new Request(url, { headers: new Headers(headers) });

test("mcp: path prefix", () => {
  assert.equal(classifyRequest(req("https://example.com/mcp")), "mcp");
  assert.equal(classifyRequest(req("https://example.com/mcp/tools")), "mcp");
});

test("mcp: session and client headers", () => {
  assert.equal(classifyRequest(req("https://example.com/", { "mcp-session-id": "abc" })), "mcp");
  assert.equal(classifyRequest(req("https://example.com/", { "x-mcp-client": "claude" })), "mcp");
});

test("mcp beats a browser-shaped request", () => {
  assert.equal(classifyRequest(req("https://example.com/mcp", BROWSER_HEADERS)), "mcp");
});

test("agent: known crawler user agents", () => {
  for (const ua of [
    "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)",
    "Mozilla/5.0 (compatible; ClaudeBot/1.0)",
    "Mozilla/5.0 (compatible; PerplexityBot/1.0)",
    "curl/8.4.0",
    "python-requests/2.32.3",
    "axios/1.7.2",
  ]) {
    assert.equal(classifyRequest(req("https://example.com/", { "user-agent": ua })), "agent", ua);
  }
});

test("agent: json preferred over html", () => {
  assert.equal(
    classifyRequest(req("https://example.com/", { ...BROWSER_HEADERS, accept: "application/json" })),
    "agent"
  );
});

test("agent: no user-agent at all", () => {
  assert.equal(classifyRequest(req("https://example.com/", {})), "agent");
});

test("unknown: html-accepting client with no browser fingerprint", () => {
  assert.equal(
    classifyRequest(
      req("https://example.com/", { "user-agent": "SomeInternalScraper/2.0", accept: "text/html" })
    ),
    "unknown"
  );
});

test("human: ordinary browser navigation", () => {
  assert.equal(classifyRequest(req("https://example.com/", BROWSER_HEADERS)), "human");
});

test("human: browser asking for json alongside html stays human", () => {
  assert.equal(
    classifyRequest(
      req("https://example.com/", { ...BROWSER_HEADERS, accept: "text/html,application/json" })
    ),
    "human"
  );
});

test("booking source follows the classification", () => {
  assert.equal(bookingSourceFor("mcp"), "mcp");
  assert.equal(bookingSourceFor("agent"), "agent");
  assert.equal(bookingSourceFor("unknown"), "agent");
  assert.equal(bookingSourceFor("human"), "human");
  assert.equal(bookingSourceFor("search"), "unknown");
  assert.equal(bookingSourceFor("nonsense"), "unknown");
});

test("search: search engines and link previews are their own bucket", () => {
  for (const ua of [
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X) AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/130.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
    "WhatsApp/2.23.20.0",
    "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
    "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
    "TelegramBot (like TwitterBot)",
    "Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)",
  ]) {
    assert.equal(
      classifyRequest(req("https://example.com/", { "user-agent": ua, accept: "text/html" })),
      "search",
      ua
    );
  }
});

test("search beats a JSON Accept header: a crawler never gets the payload", () => {
  assert.equal(
    classifyRequest(
      req("https://example.com/", {
        "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1)",
        accept: "application/json",
      })
    ),
    "search"
  );
});

test("search engines are not in the agent list", () => {
  for (const needle of SEARCH_AND_PREVIEW_UA) {
    assert.ok(!KNOWN_AGENT_UA.includes(needle), `${needle} is in both lists`);
  }
});
