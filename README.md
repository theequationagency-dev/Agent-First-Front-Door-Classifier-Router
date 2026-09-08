# Agent-First Front Door

**One URL, two response bodies.** An agent asks for your homepage and gets a
typed JSON payload of what you offer and exactly which calls to make next. A
person asks for the same URL and gets your website, untouched.

[![CI](https://github.com/theequationagency-dev/Agent-First-Front-Door-Classifier-Router/actions/workflows/ci.yml/badge.svg)](https://github.com/theequationagency-dev/Agent-First-Front-Door-Classifier-Router/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A Cloudflare Worker in front of the site you already have. No changes to your
site, no separate "AI version" to keep in sync.

```
Request → Worker (classifyRequest)
              │
      ┌───────┼────────┐
      │       │        │
    human   agent     mcp
      │       │        │
   your      D1-backed  MCP server Worker
   site      JSON       (same tables,
   (as-is)   payload     exposed as tools)
```

## Why not just llms.txt?

Use `llms.txt` too — **this project generates one for you** at `/llms.txt`,
from the same database that answers a booking call, so it cannot go stale.

The difference is what an agent can do after reading it.

| | `llms.txt` | Agent-First Front Door |
| --- | --- | --- |
| **Where** | One file at `/llms.txt` the agent must know to look for | The URL the agent already requested, plus `/llms.txt` and `/.well-known/agent.json` |
| **Content** | Markdown links to pages | Typed JSON: fields, prices as integer cents, ISO timestamps |
| **Maintained by** | You, by hand | Generated from your database on every request |
| **Round trips to a fact** | Fetch `/llms.txt` → fetch a linked page → parse prose | One. The facts are in the first response |
| **Then what?** | Read more pages | Call the endpoints it just named — `POST /api/book` with a schema and error codes |
| **Write operations** | None | Yes, with validation and conflict handling |
| **Tool calling** | No | MCP server over the same data |
| **Needs** | A static file | A Cloudflare Worker + D1 |

`llms.txt` is a fine convention and it is much simpler — if you have a static
site and only want to be read, it may be all you need. This is for sites where
an agent should be able to *do* something, and where the answer changes often
enough that a hand-maintained file will drift.

The honest summary: `llms.txt` describes a site to a reader. This one hands an
agent a live, typed contract and the endpoints to act on it.

## What an agent actually gets

```console
$ curl -s -A "GPTBot" https://example.com/
```

```jsonc
{
  "status": "ok",
  "site": { "name": "Example Co", "contact": "hello@example.com", "url": "https://example.com" },
  "actions": [
    {
      "name": "book_consult",
      "endpoint": "/api/book",
      "url": "https://example.com/api/book",
      "method": "POST",
      "content_type": "application/json",
      "body_schema": {
        "type": "object",
        "required": ["slot_id", "name", "email"],
        "properties": { "slot_id": { "type": "integer" }, "name": { "type": "string" } }
      },
      "errors": {
        "slot_taken": "409 — someone booked that slot first; re-check availability"
      }
    }
  ],
  "services":     [ { "id": 2, "name": "Audit", "price": { "amount_cents": 30000, "display": "$300" } } ],
  "availability": [ { "slot_id": 1, "start": "2026-09-09T10:00:00.000Z" } ],
  "mcp_server":   { "url": "https://mcp.example.com", "transport": "streamable-http" },
  "discovery":    { "llms_txt": "https://example.com/llms.txt" }
}
```

The same request from a browser returns your website with
`x-served-as: human`. Every response says which bucket it came from.

## Quickstart

Node 22+ and a Cloudflare account.

```sh
git clone https://github.com/theequationagency-dev/Agent-First-Front-Door-Classifier-Router.git
cd Agent-First-Front-Door-Classifier-Router
npm install
npm test          # 55 tests, no network and no Cloudflare account needed
```

Then run it against a local database:

```sh
npx wrangler d1 create agent-front-door     # put the id in both wrangler.toml files
npm run migrate:local
npm run seed:local
npm run dev                                  # :8787
```

```sh
curl -s -A "GPTBot" http://127.0.0.1:8787/        # → JSON payload
curl -s http://127.0.0.1:8787/llms.txt            # → generated llms.txt
curl -sI http://127.0.0.1:8787/ \
  -A "Mozilla/5.0 (Macintosh) Chrome/128.0.0.0 Safari/537.36" \
  -H 'accept: text/html' -H 'sec-fetch-mode: navigate' | grep x-served-as
```

Nothing in this repo points at a real site. `ORIGIN_URL` has no default — the
Worker returns 502 rather than proxying somewhere you did not choose.

## Making it yours

Three files, in order of how much you will change them:

1. **`wrangler.toml`** — `ORIGIN_URL` (your existing site), `SITE_NAME`,
   `SITE_DESCRIPTION`, `CONTACT_EMAIL`, `MCP_SERVER_URL`. Your identity is
   config, not code.
2. **`migrations/0001_init.sql` + `src/db.js`** — `services`, `availability`
   and `bookings` are a worked example of the pattern. Most people should
   replace them with whatever their site actually offers. `request_log` and
   `incidents` are the framework; keep those.
3. **`src/payload.js`** — `actionCatalog()` is what agents are told they can
   do. Change it to match your endpoints.

Every D1 query in the system lives in `src/db.js`. That is the seam: the JSON
payload, the `/api/*` routes, `/llms.txt` and the MCP tools all call it, so
there is exactly one definition of what your data is and one way it gets
written. If you find yourself writing SQL anywhere else, that is the bug.

## How classification works

`classifyRequest()` in `src/classifier.js` returns one of four buckets. Read
that one file to change a rule — it is a list of substrings, a list of headers,
and some ordered if-statements, on purpose.

1. **`mcp`** — path starts with `/mcp`, or the request carries `mcp-session-id`
   or `x-mcp-client`. Wins even for browser-shaped requests.
2. **`agent`** — the User-Agent matches a known crawler/LLM-fetcher/HTTP-client
   substring, *or* the client accepts JSON but not HTML, *or* there is no
   User-Agent at all.
3. **`unknown`** — accepts HTML but sends none of `sec-fetch-mode`,
   `sec-fetch-site`, `sec-ch-ua`. Probably a custom scraper. **Served the agent
   payload**, and logged distinctly so you can review it.
4. **`human`** — everything else. Proxied to `ORIGIN_URL`.

Because one URL returns two different bodies, every response sets
`Vary: user-agent, accept` (appended to whatever `Vary` your origin already
sent). Without it a shared cache can hand the agent JSON to a browser, or your
homepage to a bot.

**Getting it wrong is expected.** That is what `/admin/classification-report`
is for — see [Tuning](#tuning-the-classifier). And an agent we misclassify as
human can still get the payload by asking for `/llms.txt`,
`/.well-known/agent.json`, or any URL with `Accept: application/json`.

## Endpoints

| Endpoint | Method | Auth | Notes |
| --- | --- | --- | --- |
| `/` (and any path) | GET | — | Payload or your site, by classification |
| `/.well-known/agent.json` | GET | — | The payload, always, for any caller |
| `/llms.txt` | GET | — | Generated llms.txt, same data |
| `/api/services` | GET | — | `?limit=` (1–500) |
| `/api/availability` | GET | — | `?from=&to=` unix seconds, `?limit=` (1–200) |
| `/api/book` | POST | — | JSON `{slot_id, name, email, notes?}` |
| `/admin/classification-report` | GET | token | `?days=` (1–90), `?limit=` (1–200) |

`/api/*` is **not** gated on classification. The payload hands those URLs to
agents; refusing them on a user-agent guess would defeat the point.

Errors are machine-readable, so an agent can branch on the code instead of
parsing prose:

```json
{ "error": { "code": "slot_taken",
             "message": "Slot 1 is already booked.",
             "next_action": "Call GET /api/availability again and pick another slot_id." } }
```

| Code | Status | Meaning |
| --- | --- | --- |
| `invalid_request` | 400 | `error.field` names the field that failed |
| `slot_not_found` | 404 | No slot with that id |
| `slot_taken` | 409 | Someone booked it first — re-check availability |
| `method_not_allowed` | 405 | Wrong verb |
| `unauthorized` | 401 | Admin token missing or wrong |
| `admin_not_configured` | 503 | `ADMIN_TOKEN` is not set |
| `upstream_unavailable` | 503 | D1 failed; an incident was recorded |

**Double-booking** is refused at two levels: the insert and the slot claim run
in one D1 batch — a single transaction — both conditioned on the slot still
being open, so of two concurrent callers exactly one wins and the loser writes
nothing. A `UNIQUE` index on `bookings.slot_id` is the backstop if the two
tables ever disagree.

`bookings.source` records which door each booking came through: `human`,
`agent`, or `mcp`.

## MCP

Three tools over the same tables: `get_services`, `check_availability`,
`book_consult`. Official TypeScript SDK, Streamable HTTP at `POST /mcp`,
deployed as its own Worker.

```json
{ "mcpServers": { "example": { "url": "https://mcp.example.com/mcp" } } }
```

It runs as a separate Worker rather than a Node service because D1 has no
public network client — a standalone service would need Cloudflare's admin REST
API or a bespoke authed endpoint, an extra hop and an extra credential for no
gain. The tradeoff is stateless mode: no server-initiated notifications and no
resumable streams, which would need a Durable Object to hold the session. The
reasoning is written out at the top of `mcp/src/index.js`.

## Tuning the classifier

Ongoing work, not a build step. The `unknown` bucket is where the guesses live.

```sh
npx wrangler secret put ADMIN_TOKEN
curl -s -H "authorization: Bearer $ADMIN_TOKEN" \
     "https://example.com/admin/classification-report?days=7" | jq
```

You get request counts by bucket, the top user agents in `unknown` with
last-seen times, recent `unknown` requests with paths, the top agents already
matching (to spot false positives), and incidents by kind.

Then move real agents into `KNOWN_AGENT_UA` in `src/classifier.js`, and loosen
the header rules if real browsers turn up in `unknown`. Nothing is automated —
put a recurring reminder on it.

**Found one? [File it.](../../issues/new?template=classifier.yml)** The
user-agent list only improves with real traffic and no single deployment sees
enough of it. A user-agent string on its own is a complete contribution.

## When things break

`incidents` is a separate table from `request_log` on purpose: it is the
running list of where this system fails *agents* specifically, which is its own
signal rather than traffic noise.

| Kind | Recorded when |
| --- | --- |
| `db_error` | Any D1 failure — payload, API route, admin report, or a failed log write |
| `mcp_tool_failure` | An MCP tool threw, or the transport failed |
| `blocked_fetch` | The origin passthrough failed or would loop |
| `rate_limit` | Your origin answered 429 |
| `other` | Anything else unexpected |

Nothing in the logging path can break a request: every write swallows its own
error and falls back to `console.log`, visible in `wrangler tail`.

When D1 is unreachable the payload **degrades rather than fails** — 200 with
`"status": "degraded"`, empty lists, your contact details and MCP URL intact,
so an agent still has somewhere to go. The `/api/*` routes return 503 instead:
an agent asking for data specifically should be told the data is missing, not
handed an empty list.

## Testing

```sh
npm test            # 55 tests
npm run build:check # both Workers bundle
```

No network, no Cloudflare account, no wrangler needed for the suite.
`test/helpers/d1.js` implements the D1 API over `node:sqlite` and loads the
real `migrations/0001_init.sql` and `seed.sql`, so the tests exercise the
actual schema and the actual SQL — a broken query fails the suite, not just
broken JavaScript. The MCP suite includes a full round trip driven by the
official SDK client over real HTTP.

## Deploying

```sh
npx wrangler d1 migrations apply agent-front-door --remote
npx wrangler secret put ADMIN_TOKEN
npx wrangler deploy                      # router
npx wrangler deploy -c mcp/wrangler.toml # MCP server
```

Fill in the `[[routes]]` blocks in both configs first — the router in front of
your zone, the MCP server on its own hostname so the router's route does not
swallow it. `ORIGIN_URL` must be a hostname the router's route does **not**
match, or the passthrough loops; the Worker returns 508 rather than recursing,
but the fix is the config.

Then watch `npm run tail` and the classification report for a day or two before
trusting the ruleset.

## Not done yet

- **No notification path.** A booking lands in D1 and emails nobody. Wire that
  up before taking real traffic.
- **No rate limiting on `/api/book`.** The `rate_limit` incident kind exists
  and origin 429s are recorded, but the Worker does not throttle callers.
- **No retention policy.** `request_log` holds user agents and paths;
  `bookings` holds names and email addresses. Both are personal data in most
  jurisdictions and nothing deletes them for you.
- **Admin auth is a shared secret.** Fine for one operator; put Cloudflare
  Access in front of `/admin/*` if you want SSO.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md). Classifier misses are the most useful thing
you can send, and you do not need to write a fix to send one.

## License

MIT — see [LICENSE](LICENSE).
