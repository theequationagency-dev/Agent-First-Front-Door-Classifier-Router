# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Use GitHub's private reporting — the **Security** tab → **Report a
vulnerability** — on this repository. That opens a private thread with the
maintainers.

If that button is not there, private reporting has not been switched on for
this repository yet. In that case open a public issue that says only that you
have a security report and asks for a private channel — **no details, no proof
of concept**. A maintainer will come back to you with somewhere private to
send it.

Include what you can: the version or commit, what you did, what happened, and
what you expected. A proof of concept helps but is not required to file.

You should get a first response within a few days. If a fix is warranted we
will credit you in the release notes unless you would rather stay anonymous.

## What is in scope

This is a template you deploy yourself, so most of the surface is yours once
you fork it. Things we consider ours to fix:

- The classifier serving an agent payload where a human should get the origin,
  or vice versa, in a way an attacker can force.
- Cache poisoning across the human/agent split (the `Vary` handling).
- Auth bypass on `/admin/*`.
- Booking-path integrity: double-booking a slot, or writing a booking for a
  slot that was never claimed.
- Injection through any value that reaches D1, `request_log`, or `incidents`.
- Leaking `ADMIN_TOKEN`, request-log contents, or booking PII to an
  unauthenticated caller.

## What is not

- Misconfiguration of your own deployment (`ORIGIN_URL` pointed somewhere
  wrong, `ADMIN_TOKEN` committed to your fork, D1 left world-readable).
- The classifier guessing wrong on a user agent. That is a tuning problem, not
  a vulnerability — open a normal issue with the report output.
- Denial of service by sending a lot of requests. Put Cloudflare rate limiting
  in front of the Worker.

## Notes for anyone deploying this

- `ADMIN_TOKEN` is a shared secret. Set it with `wrangler secret put`, never as
  a `[vars]` entry, and never in a committed `.dev.vars`.
- `request_log` stores user agents and paths; `bookings` stores names and email
  addresses. Both are personal data in most jurisdictions. Decide on a
  retention window and delete on a schedule — the schema does not do it for
  you.
- `/admin/classification-report` exposes traffic data. It fails closed when
  `ADMIN_TOKEN` is unset, but put Cloudflare Access in front of it too if you
  want more than a shared key.
