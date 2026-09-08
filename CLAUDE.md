# CLAUDE.md

Notes for whoever (or whatever) works on this next. The README explains what
the project is and why — this file is the things you would otherwise have to
rediscover, plus the decisions already settled so they do not get relitigated.

Keep this file short. If something belongs in the README, put it there and
link, do not copy it. Two drifting copies of the same claim is the exact
failure this project exists to fix.

## Commands

```sh
npm test             # 55 tests. No network, no wrangler, no Cloudflare account
npm run build:check  # both Workers must bundle; needs no credentials
npm run dev          # router Worker  :8787
npm run dev:mcp      # MCP Worker     :8788 (shares the local D1)
npm run migrate:local && npm run seed:local
```

Node 22+ — the test harness uses `node:sqlite`.

Both dev servers share `.wrangler/state`, so booking a slot over HTTP removes
it from `check_availability` over MCP. That is the architecture working, and
it is the fastest end-to-end sanity check.

## Shape

Two Workers, one D1 database.

| | |
| --- | --- |
| `src/index.js` | Router: classify → admin → discovery → api → payload or origin |
| `src/classifier.js` | The four-bucket ruleset. Self-contained on purpose |
| `src/db.js` | **Every D1 query in the system** |
| `src/payload.js` | The agent-facing JSON |
| `src/routes/` | `api.js`, `admin.js`, `discovery.js` (`/llms.txt`, `/.well-known/agent.json`) |
| `src/observability.js` | `request_log` + `incidents` writes, admin report query |
| `mcp/src/` | MCP server Worker, same D1, official TypeScript SDK |
| `test/helpers/d1.js` | D1 API implemented over `node:sqlite` |

## Invariants

Break these and the project stops being what it is.

1. **All SQL lives in `src/db.js`.** The payload, the API routes, `/llms.txt`
   and the MCP tools all call it. One definition of the data, one way it is
   written. SQL anywhere else is a bug, not a shortcut.
2. **Every response sets `Vary: user-agent, accept`,** appended to the
   origin's own `Vary` rather than replacing it. One URL returns two different
   bodies; without this a shared cache serves the wrong one.
3. **`src/classifier.js` stays readable start to finish** by someone who has
   read nothing else. A list of substrings, a list of headers, ordered
   if-statements. Clever pattern-matching here is a regression even if it is
   more accurate.
4. **The booking claim stays atomic.** Insert and slot-claim go in one D1
   `batch()` — a single transaction — both conditioned on `booked = 0`. Two
   concurrent callers, exactly one winner, no orphan row. `UNIQUE` on
   `bookings.slot_id` is the backstop.
5. **Logging can never break a request.** `logClassification` and
   `recordIncident` swallow their own errors and fall back to `console.log`.
6. **`ORIGIN_URL` has no default.** A fork that forgets to configure it gets a
   502, never a silent proxy to someone else's site.

## Settled decisions

Do not reopen these without a reason that is new.

- **`/api/*` is not gated on classification.** The payload hands those URLs to
  agents; refusing them on a user-agent guess defeats the point.
- **The payload degrades, the API does not.** D1 down → the payload returns
  200 with `status: "degraded"` and contact details intact; `/api/*` returns
  503. An agent asking for data should be told it is missing, not handed an
  empty list.
- **MCP is its own Worker, stateless.** D1 has no public network client, so a
  Node service would need an extra hop and an extra credential. Stateless mode
  means no server-initiated notifications and no resumable streams; those need
  a Durable Object. Full reasoning at the top of `mcp/src/index.js`.
- **`incidents` is separate from `request_log`.** Failures on the agent path
  are their own signal, not traffic noise.
- **Discovery endpoints answer everyone.** A misclassified agent can still ask
  directly, so a classifier miss degrades rather than blocks.
- **The booking domain is a worked example.** `services` / `availability` /
  `bookings` are meant to be replaced. `request_log` and `incidents` are the
  framework. Making the swap easier is welcome; building the booking product
  out further is a different project.

## House style

- British spelling (`behaviour`, `organisation`, `honour`) — already dominant
  in the tree.
- Explicit over clever. Comments explain *why*; the code says what.
- New behaviour comes with a test. Especially the classifier, the booking
  race, and the `Vary` handling — regressions there are silent and expensive.
- Prices are integer cents plus a currency. Times are unix seconds in the
  database, ISO strings on the wire. No floats for money, ever.

## Testing approach

`test/helpers/d1.js` implements the D1 API over `node:sqlite` and loads the
real `migrations/0001_init.sql` and `seed.sql`. The tests therefore run the
actual schema and the actual SQL — a broken query fails the suite, not just
broken JavaScript. Only the transport is faked, and only the methods the code
calls are implemented, so a new dependency on the D1 API shows up as a failure
rather than passing silently.

`test/mcp.test.js` includes one round trip driven by the official SDK client
over a real HTTP server, to prove a real client can connect.

## Gotchas

- `wrangler dev` needs `--persist-to .wrangler/state` on the MCP config for
  the two Workers to share a local database. `npm run dev:mcp` does this.
- `database_id` is `REPLACE_WITH_...` in both configs by design. Deploys fail
  loudly until someone fills them in.
- `ADMIN_TOKEN` is a secret, never a `[vars]` entry. `/admin/*` fails closed
  (503) when it is unset.
- The admin report counts its own request — it is classified and logged like
  anything else (no UA → `agent`).
- Anything under `/mcp` classifies as `mcp` on the *router* Worker too; the
  MCP server itself is a separate deployment on its own hostname.

## Known gaps

Documented in the README under "Not done yet": no booking notification, no
rate limiting on `/api/book`, no retention policy for `request_log` or
`bookings` (both hold personal data), admin auth is a shared secret.
