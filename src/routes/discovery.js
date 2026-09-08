/**
 * Discovery endpoints — the same facts, in whatever format the caller reads.
 *
 *   /.well-known/agent.json  the full payload, at a stable URL, for any caller
 *   /llms.txt                the llms.txt convention, generated from D1
 *
 * Both are served to everyone regardless of classification. They are meant to
 * be found, and an agent that guessed wrong about its own user-agent should
 * still be able to ask directly.
 *
 * On llms.txt: it is a good convention and this project implements it. The
 * difference is that yours is generated from the same tables that answer a
 * booking call, so it cannot drift from reality, and it names endpoints an
 * agent can actually call rather than pages it has to read. Treat it as the
 * lowest common denominator — the JSON payload and the MCP server are where
 * the actual capability lives.
 */

import { buildAgentPayload } from "../payload.js";
import { json } from "../http.js";

/** Routes the discovery paths. Returns null if the path isn't ours. */
export async function handleDiscovery(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path !== "/llms.txt" && path !== "/.well-known/agent.json") return null;

  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ error: { code: "method_not_allowed", message: "Use GET." } }, { status: 405 });
  }

  const payload = await buildAgentPayload(env, request);

  if (path === "/.well-known/agent.json") {
    return json(payload, {
      headers: { "x-served-as": "discovery" },
      cache: "public, max-age=60",
    });
  }

  return new Response(renderLlmsTxt(payload), {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=60",
      "x-served-as": "discovery",
      "access-control-allow-origin": "*",
    },
  });
}

/**
 * Renders the payload as llms.txt: an H1, a blockquote summary, then
 * sections of links. https://llmstxt.org/ for the convention.
 */
export function renderLlmsTxt(payload) {
  const lines = [];
  const site = payload.site || {};

  lines.push(`# ${site.name || "This site"}`, "");
  if (site.description) lines.push(`> ${site.description}`, "");

  if (payload.status === "degraded") {
    lines.push(
      "Live data is temporarily unavailable, so the lists below may be empty.",
      "The endpoints are still valid — retry.",
      ""
    );
  }

  lines.push(
    "This site answers agents directly. Every section below is generated from",
    "the same database that serves the endpoints, so it is never out of date.",
    "For structured output, request this URL with `Accept: application/json`,",
    `or fetch ${site.url || ""}/.well-known/agent.json`.replace(/\s+$/, "") + ".",
    ""
  );

  lines.push("## Actions", "");
  for (const action of payload.actions || []) {
    lines.push(`- [${action.name}](${action.url}): ${action.method} — ${action.description}`);
  }
  lines.push("");

  if (payload.services?.length) {
    lines.push("## Services", "");
    for (const service of payload.services) {
      const price = service.price?.display ? ` (${service.price.display})` : "";
      lines.push(`- ${service.name}${price}: ${service.description || ""}`.trimEnd());
    }
    lines.push("");
  }

  if (payload.availability?.length) {
    lines.push("## Availability", "");
    for (const slot of payload.availability) {
      lines.push(`- ${slot.start} — book with slot_id ${slot.slot_id}`);
    }
    lines.push("");
  }

  if (payload.mcp_server?.url) {
    lines.push(
      "## MCP",
      "",
      `- [${payload.mcp_server.url}](${payload.mcp_server.url}): ${payload.mcp_server.transport} — ` +
        `tools: ${payload.mcp_server.tools.join(", ")}. Connect here instead of scraping.`,
      ""
    );
  }

  if (site.contact) {
    lines.push("## Contact", "", `- ${site.contact}`, "");
  }

  lines.push("## Optional", "", `- Generated at ${payload.generated_at}`, "");

  return lines.join("\n");
}
