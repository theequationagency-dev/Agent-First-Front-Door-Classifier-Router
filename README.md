# Agent-First-Front-Door-Classifier-Router

A Cloudflare Worker that sits in front of a site and answers the same URL two
different ways:

- **Agents, crawlers and MCP clients** get a structured JSON action payload —
  what the business is, what it can do, and where the MCP server lives.
- **Humans** are proxied straight through to the existing origin, untouched
  apart from a debug header.

The point is to stop making agents scrape HTML for facts you could hand them
directly, without building a separate `.well-known` endpoint nobody visits.

## Layout

| Path | What it is |
| --- | --- |
| `src/index.js` | Classifier, agent payload builder, router, logging stub |
| `wrangler.toml` | Route, `ORIGIN_URL` var, commented D1 binding |
| `test/classify.test.js` | Classifier + router tests (no dependencies) |

## Classification

`classifyRequest()` returns one of four buckets, checked in this order:

1. **`mcp`** — path starts with `/mcp`, or the request carries `mcp-session-id`
   or `x-mcp-client`. This wins even for browser-shaped requests.
2. **`agent`** — the User-Agent matches a known crawler/LLM-fetcher/HTTP-client
   substring (`KNOWN_AGENT_UA`), *or* the client accepts JSON but not HTML,
   *or* there is no User-Agent at all.
3. **`unknown`** — accepts HTML but sends none of `sec-fetch-mode`,
   `sec-fetch-site`, `sec-ch-ua`. The fuzzy bucket: probably a custom scraper.
   It is currently served the agent payload; watch the logs and move rules into
   bucket 2 or 4 as real traffic tells you which.
4. **`human`** — everything else. Proxied to `ORIGIN_URL`.

Every response carries `x-served-as: <classification>` so you can confirm a
decision from `curl -I` or a browser devtools panel.

Because one URL returns two different bodies, both branches set
`Vary: user-agent, accept` (added to whatever `Vary` the origin already sent).
Without it a shared cache can hand the agent JSON to a human, or the HTML page
to a bot. Keep that header if you change the cache policy.

## Local development

```sh
npm test          # classifier + router tests, no install needed (Node 18+)
npm run dev       # wrangler dev
npm run deploy    # wrangler deploy
npm run tail      # live classification logs
```

Check a decision by hand:

```sh
curl -sI http://localhost:8787/ -H 'user-agent: GPTBot/1.2'   # x-served-as: agent
curl -sI http://localhost:8787/mcp                            # x-served-as: mcp
curl -s  http://localhost:8787/ -H 'accept: application/json' | head
```

## Deploying

1. Fill in the `[[routes]]` block in `wrangler.toml` with your zone and
   uncomment it.
2. Point `ORIGIN_URL` at a hostname the Worker route does **not** match — a
   Pages subdomain, say. If the origin resolves back through the same route,
   human traffic loops into the Worker.
3. `npm run deploy`, then `npm run tail` and watch the classifications for a
   day before trusting the ruleset.

## Wiring in real data

Two stubs are marked in `src/index.js`:

- `buildAgentPayload()` returns a static object. Replace it with a D1 query so
  the payload and your MCP tool responses share one source of truth.
- `logClassification()` writes to `console.log`. Swap in a D1 insert or
  Analytics Engine datapoint. It runs inside `ctx.waitUntil()` and swallows its
  own errors — logging must never break the request path.

Uncomment the `[[d1_databases]]` block in `wrangler.toml` after
`wrangler d1 create agent-front-door` to get the `env.DB` binding.
