# Contributing

Thanks for looking. This is a small project with a narrow job, and the most
useful contributions are usually small too.

## The most valuable thing you can send

**Classifier misses.** The user-agent list and header rules in
`src/classifier.js` only get better with real traffic, and no single deployment
sees enough of it. If something landed in the wrong bucket, open a
[classifier issue](../../issues/new?template=classifier.yml) with the user
agent and what it should have been. That is the whole flywheel.

You do not need to send a fix. A user-agent string is a complete contribution.

## Getting set up

```sh
git clone <your fork>
cd agent-front-door
npm install
npm test
```

That is it — the tests need no network, no Cloudflare account and no wrangler.
`test/helpers/d1.js` implements the D1 API over `node:sqlite` and loads the
real migration and seed files, so the suite runs the actual schema and the
actual SQL. Node 22+ (for `node:sqlite`).

To run the real thing:

```sh
npx wrangler d1 migrations apply agent-front-door --local
npm run seed:local
npm run dev        # router on :8787
npm run dev:mcp    # MCP server on :8788
```

## Before you open a PR

```sh
npm test           # must pass
npm run build:check  # both Workers must bundle
```

Both run in CI on every PR. `build:check` needs no Cloudflare credentials.

## House style

- **Explicit over clever.** Someone should be able to read `src/classifier.js`
  top to bottom and change a rule without reading anything else in the repo.
  That is a hard constraint, not a preference.
- **One source of truth.** Every D1 query lives in `src/db.js`. If you find
  yourself writing SQL anywhere else, that is the bug.
- **Comments explain why, not what.** The code says what it does.
- **New behaviour comes with a test.** Especially anything touching the
  classifier, the booking race, or the `Vary` handling — those three are where
  a regression is expensive and silent.

## Things that need doing

Rough order of usefulness:

- More classifier coverage, as above.
- A booking notification path. A booking currently lands in D1 and emails
  nobody.
- Rate limiting on `/api/book`. The `rate_limit` incident kind exists and the
  origin's 429s are recorded, but the Worker does not throttle callers itself.
- A retention/cleanup job for `request_log` and `bookings`.
- Adapters for data sources other than D1 — the seam is `src/db.js`.

## Scope

This project routes requests and serves a payload. It is deliberately not a
CMS, a booking product, or an analytics tool. `services` / `availability` /
`bookings` are a worked example of the pattern, not the point — most people
should replace them. PRs that make that swap *easier* are very welcome. PRs
that build the booking domain out further are probably a different project.

## Conduct

Be decent. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
