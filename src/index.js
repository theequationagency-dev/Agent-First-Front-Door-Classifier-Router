/**
 * Agent-First Front Door — Classifier + Router
 * Cloudflare Worker
 *
 * One route, two response bodies:
 *   - Classified as agent/bot  -> structured JSON action payload
 *   - Classified as human      -> pass through to origin (your existing site)
 *
 * Deploy: wrangler.toml routes this at your zone, e.g. "example.com/*"
 * Origin fallback for humans: set ORIGIN_URL as a var in wrangler.toml.
 */

// ---------------------------------------------------------------------------
// 1. CLASSIFIER
// ---------------------------------------------------------------------------

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
const BROWSER_ONLY_HEADERS = ["sec-fetch-mode", "sec-fetch-site", "sec-ch-ua"];

// Request headers the classification depends on. Any shared cache in front of
// this Worker must key on these, or one client's response body gets served to
// a client of the other kind.
const CLASSIFIER_VARY = "user-agent, accept";

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

// ---------------------------------------------------------------------------
// 2. AGENT-FACING PAYLOAD
// ---------------------------------------------------------------------------

/**
 * Builds the structured payload served to agents/MCP clients.
 * Pull real data from D1 here instead of the static stub below —
 * this is the single source of truth shared with your MCP tool responses.
 */
export async function buildAgentPayload(env, request) {
  // Example shape — replace with a D1 query, e.g.:
  // const { results } = await env.DB.prepare(
  //   "SELECT * FROM services WHERE active = 1"
  // ).all();

  return {
    business: {
      name: "The Equation Agency LLC",
      description: "AI-native digital strategy and marketing agency.",
      contact: "management@theequationagencyllc.com",
    },
    actions: [
      {
        name: "get_services",
        description: "List current service offerings and pricing.",
        endpoint: "/api/services",
        method: "GET",
      },
      {
        name: "check_availability",
        description: "Check open consultation slots.",
        endpoint: "/api/availability",
        method: "GET",
      },
      {
        name: "book_consult",
        description: "Book a consultation slot.",
        endpoint: "/api/book",
        method: "POST",
      },
    ],
    mcp_server: {
      url: "https://mcp.theequationagencyllc.com",
      note: "Prefer connecting here directly for tool-call access instead of scraping this JSON.",
    },
    generated_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 3. ROUTER
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const classification = classifyRequest(request);

    // Optional: log classification decisions to a KV/D1/analytics engine
    // for later tuning of the ruleset. Keep this cheap — don't block on it.
    ctx.waitUntil(logClassification(env, request, classification));

    switch (classification) {
      case "mcp":
      case "agent":
      case "unknown": {
        const payload = await buildAgentPayload(env, request);
        return new Response(JSON.stringify(payload, null, 2), {
          status: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "x-served-as": classification,
            "cache-control": "public, max-age=60",
            vary: CLASSIFIER_VARY,
          },
        });
      }

      case "human":
      default: {
        // Pass through to your existing origin (Cloudflare Pages, etc.)
        const originUrl = env.ORIGIN_URL || "https://theequationagencyllc.com";
        const url = new URL(request.url);
        const target = new URL(url.pathname + url.search, originUrl);
        const originResponse = await fetch(new Request(target, request));

        // Clone so we can attach a debug header without mutating the
        // immutable response Cloudflare returned.
        const response = new Response(originResponse.body, originResponse);
        response.headers.set("x-served-as", "human");
        appendVary(response.headers, CLASSIFIER_VARY);
        return response;
      }
    }
  },
};

/**
 * Adds fields to an existing Vary header without dropping what the origin set.
 */
function appendVary(headers, fields) {
  const existing = (headers.get("vary") || "")
    .split(",")
    .map((f) => f.trim().toLowerCase())
    .filter(Boolean);

  if (existing.includes("*")) return;

  for (const field of fields.split(",").map((f) => f.trim().toLowerCase())) {
    if (field && !existing.includes(field)) existing.push(field);
  }
  headers.set("vary", existing.join(", "));
}

// ---------------------------------------------------------------------------
// 4. LOGGING (stub — swap in D1/Analytics Engine)
// ---------------------------------------------------------------------------

async function logClassification(env, request, classification) {
  try {
    const ua = request.headers.get("user-agent") || "";
    const url = new URL(request.url);
    // Example D1 insert:
    // await env.DB.prepare(
    //   "INSERT INTO request_log (path, ua, classification, ts) VALUES (?, ?, ?, ?)"
    // ).bind(url.pathname, ua, classification, Date.now()).run();
    console.log(JSON.stringify({ path: url.pathname, ua, classification }));
  } catch (err) {
    // Never let logging break the request path.
  }
}
