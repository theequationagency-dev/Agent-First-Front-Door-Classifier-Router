/**
 * MCP server — Cloudflare Worker.
 *
 * Hosting decision (the build brief left this open): this runs as its own
 * Worker rather than a standalone Node service.
 *
 *   - D1 has no public network client. A Node service would have to reach
 *     these tables through Cloudflare's admin REST API or a bespoke authed
 *     endpoint on the router Worker — an extra hop and an extra credential to
 *     rotate, for no gain.
 *   - The official SDK ships WebStandardStreamableHTTPServerTransport, built
 *     on Request/Response, which runs on Workers as-is. No Node shims.
 *   - Same wrangler tooling, same secrets store, same deploy as the router.
 *
 * The tradeoff: stateless mode. Each request builds a fresh server and
 * transport, so there are no server-initiated notifications and no resumable
 * streams — those need a Durable Object to hold the session between requests.
 * For three request/response tools that costs nothing. If you later add
 * long-running work (progress on a booking workflow, subscriptions), move to
 * a Durable Object-backed session and drop the stateless flags below.
 *
 * Deploy separately from the router:  wrangler deploy -c mcp/wrangler.toml
 */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { createMcpServer } from "./tools.js";
import { recordIncident } from "../../src/observability.js";

const MCP_PATH = "/mcp";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/health") {
      return Response.json({ ok: true, server: "mcp", transport: "streamable-http" });
    }

    // Advertise where the tools are, for anything that lands on the root.
    if (path === "/") {
      return Response.json({
        server: env?.SERVER_NAME || "agent-front-door",
        transport: "streamable-http",
        endpoint: new URL(MCP_PATH, url.origin).toString(),
        tools: ["get_services", "check_availability", "book_consult"],
      });
    }

    if (path !== MCP_PATH) {
      return Response.json({ error: { code: "not_found", message: `POST ${MCP_PATH}` } }, { status: 404 });
    }

    const server = createMcpServer(env);
    const transport = new WebStandardStreamableHTTPServerTransport({
      // Stateless: no session id, plain JSON responses instead of SSE.
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    try {
      await server.connect(transport);
      const response = await transport.handleRequest(request);
      // The server and transport belong to this request only.
      ctx.waitUntil(closeQuietly(server, transport));
      return response;
    } catch (err) {
      await recordIncident(env, {
        path: `mcp:transport`,
        kind: "mcp_tool_failure",
        detail: `streamable-http transport: ${err?.message || err}`,
      });
      await closeQuietly(server, transport);
      return Response.json(
        {
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        },
        { status: 500 }
      );
    }
  },
};

async function closeQuietly(server, transport) {
  try {
    await transport.close();
  } catch {
    // Nothing useful to do — the request is already answered.
  }
  try {
    await server.close();
  } catch {
    // Same.
  }
}
