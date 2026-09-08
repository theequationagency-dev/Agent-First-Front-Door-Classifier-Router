/**
 * Agent-First Front Door — request classifier.
 *
 * Deliberately plain: a list of substrings, a list of headers, and a handful
 * of ordered if-statements. You should be able to read this top to bottom and
 * change a rule without reading anything else in the repo.
 *
 * Review the decisions it makes with GET /admin/classification-report.
 */

// Known agent / crawler / LLM-fetcher UA substrings (lowercase match).
// Extend this list as new agents show up in your logs.
export const KNOWN_AGENT_UA = [
  "gptbot",
  "oai-searchbot",
  "chatgpt-user",
  "claudebot",
  "anthropic-ai",
  "claude-web",
  "perplexitybot",
  "perplexity-user",
  "ccbot",
  "google-extended",
  "bingbot",
  "bytespider",
  "diffbot",
  "cohere-ai",
  "youbot",
  "meta-externalagent",
  "applebot-extended",
  "amazonbot",
  "mcp-client",
  "mcp/",
  "python-requests",
  "curl/",
  "node-fetch",
  "axios/",
  "go-http-client",
  "okhttp",
];

// Header shape that real browsers send but scripted clients rarely bother with.
export const BROWSER_ONLY_HEADERS = [
  "sec-fetch-mode",
  "sec-fetch-site",
  "sec-ch-ua",
];

// The four buckets, in the order the rules below try them.
export const CLASSIFICATIONS = ["mcp", "agent", "unknown", "human"];

// Request headers the classification depends on. Any shared cache in front of
// this Worker must key on these, or one client's response body gets served to
// a client of the other kind.
export const CLASSIFIER_VARY = "user-agent, accept";

/**
 * Returns a classification: "mcp" | "agent" | "human" | "unknown"
 */
export function classifyRequest(request) {
  const url = new URL(request.url);
  const ua = (request.headers.get("user-agent") || "").toLowerCase();
  const accept = (request.headers.get("accept") || "").toLowerCase();

  // 1. Explicit MCP handshake — path convention or dedicated header.
  //    Adjust to match whatever your MCP server actually advertises.
  if (
    url.pathname.startsWith("/mcp") ||
    request.headers.has("mcp-session-id") ||
    request.headers.get("x-mcp-client")
  ) {
    return "mcp";
  }

  // 2. Known agent/bot UA string.
  if (KNOWN_AGENT_UA.some((needle) => ua.includes(needle))) {
    return "agent";
  }

  // 3. Explicit preference for JSON over HTML (agents/scripts often send
  //    "Accept: application/json" or "*/*" with no "text/html").
  const acceptsHtml = accept.includes("text/html");
  const acceptsJson = accept.includes("application/json");
  if (acceptsJson && !acceptsHtml) {
    return "agent";
  }

  // 4. Missing browser-fingerprint headers entirely + no UA at all.
  //    Real browsers always send sec-fetch-* on modern Chromium/Firefox/Safari.
  const hasAnyBrowserHeader = BROWSER_ONLY_HEADERS.some((h) =>
    request.headers.has(h)
  );
  if (!ua) {
    return "agent"; // no UA is almost never a real browser
  }
  if (!hasAnyBrowserHeader && acceptsHtml) {
    // Sends Accept: text/html but lacks browser fingerprint headers —
    // could be an older/custom scraper. Treat as agent, but this is the
    // fuzziest bucket; log it and refine the ruleset over time.
    return "unknown";
  }

  return "human";
}

/**
 * Where a booking came from, for the bookings.source column.
 * "unknown" traffic is served the agent payload, so it books as an agent.
 */
export function bookingSourceFor(classification) {
  if (classification === "mcp") return "mcp";
  if (classification === "human") return "human";
  if (classification === "agent" || classification === "unknown") return "agent";
  return "unknown";
}
