# Agent-First Front Door — Classifier + Router

One URL, two response bodies.

Requests classified as **AI agents, crawlers or MCP clients** get a structured
JSON action payload backed by real data. Requests classified as **humans** are
proxied to the existing website, untouched. The same D1 tables back the JSON
payload, the `/api/*` endpoints and the MCP server, so there is never a second
copy of "what we sell" or "when we're free" to keep in sync.

```
Request → Worker (classifyRequest)
              │
      ┌───────┼────────┐
      │       │        │
    human   agent     mcp
      │       │        │
   origin   D1-backed  MCP server Worker
   site     JSON       (same D1 tables,
   (as-is)  payload     exposed as tools)
```

Everything the classifier decides lands in `request_log`. Everything that
*breaks* on the agent path lands in `incidents` — a separate table, because
"what agents can't do here yet" is its own signal, not traffic noise.

## Layout

| Path | What it is |
| --- | --- |
| `src/index.js` | Router: classify → admin → api → agent payload or origin passthrough |
| `src/classifier.js` | The rules. Read this one file to change what counts as an agent |
| `src/db.js` | Every D1 query in the system. The single source of truth |
| `src/payload.js` | The agent-facing JSON, built from D1 |
| `src/observability.js` | `request_log` + `incidents` writes, and the admin report query |
| `src/validate.js` | Booking input rules, shared by the HTTP route and the MCP tool |
| `src/routes/api.js` | `/api/services`, `/api/availability`, `/api/book` |
| `src/routes/admin.js` | `/admin/classification-report`, shared-secret gated |
| `mcp/src/index.js` | MCP server Worker (Streamable HTTP transport) |
| `mcp/src/tools.js` | `get_services`, `check_availability`, `book_consult` |
| `migrations/0001_init.sql` | D1 schema |
| `seed.sql` | Example rows — dev only |
| `test/` | 48 tests, run against the real schema on `node:sqlite` |

## How the human/agent split works

`classifyRequest()` returns one of four buckets, checked in this order:

1. **`mcp`** — path starts with `/mcp`, or the request carries `mcp-session-id`
   or `x-mcp-client`. Wins even for browser-shaped requests.
2. **`agent`** — the User-Agent matches a known crawler/LLM-fetcher/HTTP-client
   substring (`KNOWN_AGENT_UA`), *or* the client accepts JSON but not HTML,
   *or* there is no User-Agent at all.
3. **`unknown`** — accepts HTML but sends none of `sec-fetch-mode`,
   `sec-fetch-site`, `sec-ch-ua`. Probably a custom scraper. **Served the agent
   payload**, and logged distinctly so you can review it.
4. **`human`** — everything else. Proxied to `ORIGIN_URL`.

Every response carries `x-served-as: <classification>`, so you can confirm any
decision from `curl -I`.

Because one URL returns two different bodies, every response sets
`Vary: user-agent, accept` (appended to whatever `Vary` the origin already
sent). Without it a shared cache can hand the agent JSON to a browser, or the
HTML page to a bot.

`/api/*` is **not** gated on classification. The payload hands those URLs to
agents, and humans clicking through a browser-based tool must be able to reach
them too; refusing on a UA guess would defeat the point. `/admin/*` is gated on
a shared secret and nothing else.

## Setup

### 1. Install and create the database

```sh
npm install
npx wrangler d1 create equation-agency-agents
```

Put the returned `database_id` into **both** `wrangler.toml` and
`mcp/wrangler.toml` — the two Workers bind the same database on purpose.

### 2. Run the migration

```sh
npx wrangler d1 migrations apply equation-agency-agents --local   # local dev
npx wrangler d1 migrations apply equation-agency-agents --remote  # production
```

Or apply the file directly:
`npx wrangler d1 execute equation-agency-agents --file=migrations/0001_init.sql`

### 3. Seed dev data (local only)

```sh
npx wrangler d1 execute equation-agency-agents --local --file=seed.sql
```

Three services and three future slots. **Do not run this against production.**

### 4. Set the admin token

```sh
echo 'ADMIN_TOKEN=some-long-random-string' > .dev.vars   # local, gitignored
npx wrangler secret put ADMIN_TOKEN                      # production
```

`/admin/classification-report` **fails closed** (503) when `ADMIN_TOKEN` is
unset, so a missing secret can never publish your traffic log.

### 5. Point the origin at your site

`ORIGIN_URL` in `wrangler.toml`. It must be a hostname the Worker's route does
**not** match, or the human passthrough loops back into the Worker. The Worker
detects that case and returns 508 with a `blocked_fetch` incident rather than
recursing, but the fix is the config.

## Local development

```sh
npm test                                  # 48 tests, no network, no wrangler
npm run dev                               # router Worker on :8787
npm run dev:mcp                           # MCP Worker on :8788
npm run deploy                            # deploy the router
npm run deploy:mcp                        # deploy the MCP server
npm run tail                              # live classification logs
```

Confirm both paths:

```sh
# agent → JSON payload
curl -s -A "GPTBot" http://127.0.0.1:8787/ | head -20

# human → your site, proxied
curl -sI -A "Mozilla/5.0 (Macintosh) Chrome/128.0.0.0 Safari/537.36" \
     -H 'accept: text/html' -H 'sec-fetch-mode: navigate' \
     http://127.0.0.1:8787/ | grep x-served-as

# the advertised actions
curl -s http://127.0.0.1:8787/api/services
curl -s http://127.0.0.1:8787/api/availability
curl -s -X POST http://127.0.0.1:8787/api/book \
     -H 'content-type: application/json' \
     -d '{"slot_id":1,"name":"Ada","email":"ada@example.com"}'

# the same capabilities over MCP
curl -s -X POST http://127.0.0.1:8788/mcp \
     -H 'content-type: application/json' \
     -H 'accept: application/json, text/event-stream' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Both dev servers share one local D1 (`.wrangler/state`), so a slot booked over
HTTP disappears from `check_availability` over MCP. That is the architecture
working.

## The API

| Endpoint | Method | Notes |
| --- | --- | --- |
| `/api/services` | GET | Active services. `?limit=` (1–500) |
| `/api/availability` | GET | Open future slots. `?from=&to=` unix seconds, `?limit=` (1–200) |
| `/api/book` | POST | JSON `{slot_id, name, email, notes?}` |
| `/admin/classification-report` | GET | Auth required. `?days=` (1–90), `?limit=` (1–200) |

Errors are machine-readable, so an agent can branch on the code instead of
parsing prose:

```json
{ "error": { "code": "slot_taken",
             "message": "Slot 1 is already booked.",
             "next_action": "Call GET /api/availability again and pick another slot_id." } }
```

| Code | Status | Meaning |
| --- | --- | --- |
| `invalid_request` | 400 | Body failed validation; `error.field` names the field |
| `slot_not_found` | 404 | No slot with that id |
| `slot_taken` | 409 | Someone booked it first — re-check availability |
| `method_not_allowed` | 405 | Wrong verb |
| `unauthorized` | 401 | Admin token missing or wrong |
| `admin_not_configured` | 503 | `ADMIN_TOKEN` is not set |
| `upstream_unavailable` | 503 | D1 failed; an incident was recorded |

**Double-booking** is refused at two levels: the insert and the slot claim run
in one D1 batch (a single transaction), both conditioned on the slot still
being open, so of two concurrent callers exactly one wins. A `UNIQUE` index on
`bookings.slot_id` is the backstop if the two tables ever disagree.

`bookings.source` is filled in from the classification — `human`, `agent`, or
`mcp` — so you can see which door each booking came through.

## The MCP server

Three tools over the same D1 tables: `get_services`, `check_availability`,
`book_consult`. Built on the official TypeScript SDK
(`@modelcontextprotocol/sdk`), served over Streamable HTTP at `POST /mcp`.

Point a client at `https://mcp.<your-domain>/mcp`. In Claude Desktop or any
`mcp.json`:

```json
{ "mcpServers": { "equation-agency": { "url": "https://mcp.theequationagencyllc.com/mcp" } } }
```

Tool results carry both a text block and `structuredContent`, so clients that
only read text and clients that parse structured output both work.

## Tuning the classifier

This is an ongoing job, not a build step. The `unknown` bucket is where the
guesses live.

```sh
curl -s -H "authorization: Bearer $ADMIN_TOKEN" \
     "https://your-domain/admin/classification-report?days=7" | jq
```

The report gives you:

- request counts by classification for the window,
- the top user agents in the `unknown` bucket, with last-seen times,
- recent `unknown` requests with paths,
- the top user agents already matching as `agent`, to spot false positives,
- incidents grouped by kind, plus the most recent ones.

Then: move real agents into `KNOWN_AGENT_UA` in `src/classifier.js`. If real
browsers turn up in `unknown`, loosen the header rules. Nothing here is
automated — put a recurring reminder on it.

## Incidents

`incidents` is the running list of where this system breaks for agents:

| Kind | Recorded when |
| --- | --- |
| `db_error` | Any D1 failure — payload build, API route, admin report, or a failed `request_log` write |
| `mcp_tool_failure` | An MCP tool threw, or the transport failed |
| `blocked_fetch` | The origin passthrough failed or would loop |
| `rate_limit` | The origin answered 429 |
| `other` | Anything else unexpected on a route |

Nothing in the logging path can break a request: every write swallows its own
error and falls back to `console.log`, visible in `wrangler tail`.

When D1 is unreachable, the agent payload **degrades rather than failing**: it
returns 200 with `"status": "degraded"`, empty `services`/`availability`, and
the contact details and MCP URL intact, so an agent still has somewhere to go.
The `/api/*` routes return 503 with `upstream_unavailable` — an agent asking
for data specifically should be told the data isn't there, not handed an empty
list.

## Testing

```sh
npm test
```

48 tests, no network and no wrangler needed (Node 22+, for `node:sqlite`).
`test/helpers/d1.js` implements
the D1 API over `node:sqlite` and loads the real `migrations/0001_init.sql`
and `seed.sql`, so the tests exercise the actual schema and the actual SQL —
a broken query fails the suite. The MCP suite includes one full round trip
driven by the official SDK client over real HTTP.

## Deploying

```sh
npx wrangler d1 migrations apply equation-agency-agents --remote
npx wrangler deploy                      # router
npx wrangler deploy -c mcp/wrangler.toml # MCP server
npx wrangler secret put ADMIN_TOKEN
```

Uncomment and fill in the `[[routes]]` blocks in both configs first — the
router in front of your zone, the MCP server on its own hostname so the
router's route doesn't swallow it.

Then watch `npm run tail` and the classification report for a day or two before
trusting the ruleset.

## Things left open

- **Auth on `/admin/*`** is a shared secret in `ADMIN_TOKEN`. Fine for one
  operator; put Cloudflare Access in front of the route if you want SSO.
- **`bookings` has no notification path.** A booking lands in D1 and nothing
  emails anyone. Wire that up before this takes real traffic.
- **No rate limiting on `/api/book`.** The `rate_limit` incident kind exists
  and the origin's 429s are recorded, but the Worker does not throttle agents
  itself yet.
- **Classifier tuning is manual.** See above.
