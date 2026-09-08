/**
 * Two separate logs, on purpose:
 *
 *   request_log — every classification decision. Traffic data, used to review
 *                 the "unknown" bucket and tune the ruleset.
 *   incidents   — failures on the agent-facing path (D1 errors, blocked
 *                 fetches, rate limits, MCP tool failures). These are signal
 *                 about what agents can't do yet, so they don't get buried in
 *                 the traffic log.
 *
 * Neither one may ever break a request: both swallow their own errors and
 * fall back to console.log so the failure is still visible in `wrangler tail`.
 */

export const INCIDENT_KINDS = [
  "rate_limit",
  "blocked_fetch",
  "db_error",
  "mcp_tool_failure",
  "other",
];

const MAX_UA = 512;
const MAX_DETAIL = 2000;

const truncate = (value, max) =>
  typeof value === "string" && value.length > max ? value.slice(0, max) + "…" : value;

/**
 * Records one classification decision. Call inside ctx.waitUntil() — it is
 * never on the critical path.
 */
export async function logClassification(env, request, classification) {
  let path = "/";
  const ua = truncate(request.headers.get("user-agent") || "", MAX_UA);
  try {
    path = new URL(request.url).pathname;
  } catch {
    // Keep the default path rather than losing the whole log line.
  }

  try {
    if (env?.DB) {
      await env.DB.prepare(
        `INSERT INTO request_log (path, user_agent, classification) VALUES (?, ?, ?)`
      )
        .bind(path, ua, classification)
        .run();
      return;
    }
    console.log(JSON.stringify({ log: "classification", path, ua, classification }));
  } catch (err) {
    // A failing request_log insert is itself an incident worth keeping.
    console.log(
      JSON.stringify({
        log: "classification",
        path,
        ua,
        classification,
        log_error: String(err?.message || err),
      })
    );
    await recordIncident(env, {
      path,
      kind: "db_error",
      detail: `request_log insert failed: ${err?.message || err}`,
    });
  }
}

/**
 * Records a failure on the agent path. Safe to await anywhere: it cannot throw.
 */
export async function recordIncident(env, { path = null, kind = "other", detail = null } = {}) {
  const safeKind = INCIDENT_KINDS.includes(kind) ? kind : "other";
  const safeDetail = truncate(detail == null ? null : String(detail), MAX_DETAIL);

  try {
    if (env?.DB) {
      await env.DB.prepare(`INSERT INTO incidents (path, kind, detail) VALUES (?, ?, ?)`)
        .bind(path, safeKind, safeDetail)
        .run();
      return;
    }
  } catch (err) {
    // Fall through to the console so the incident is not lost entirely.
    console.error(
      JSON.stringify({ log: "incident_write_failed", kind: safeKind, error: String(err?.message || err) })
    );
  }
  console.error(JSON.stringify({ log: "incident", path, kind: safeKind, detail: safeDetail }));
}

/**
 * The /admin/classification-report body: what the classifier decided over the
 * last `days`, which user agents are landing in the fuzzy buckets, and what
 * has been breaking for agents.
 */
export async function classificationReport(env, { days = 7, limit = 25 } = {}) {
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const db = env.DB;

  const [totals, unknownAgents, agentAgents, recentUnknown, incidentTotals, recentIncidents] =
    await Promise.all([
      db
        .prepare(
          `SELECT classification, COUNT(*) AS requests
             FROM request_log WHERE created_at >= ?
            GROUP BY classification ORDER BY requests DESC`
        )
        .bind(since)
        .all(),
      db
        .prepare(
          `SELECT user_agent, COUNT(*) AS requests, MAX(created_at) AS last_seen
             FROM request_log
            WHERE created_at >= ? AND classification = 'unknown'
            GROUP BY user_agent ORDER BY requests DESC LIMIT ?`
        )
        .bind(since, limit)
        .all(),
      db
        .prepare(
          `SELECT user_agent, COUNT(*) AS requests, MAX(created_at) AS last_seen
             FROM request_log
            WHERE created_at >= ? AND classification = 'agent'
            GROUP BY user_agent ORDER BY requests DESC LIMIT ?`
        )
        .bind(since, limit)
        .all(),
      db
        .prepare(
          `SELECT path, user_agent, created_at
             FROM request_log
            WHERE created_at >= ? AND classification = 'unknown'
            ORDER BY created_at DESC LIMIT ?`
        )
        .bind(since, limit)
        .all(),
      db
        .prepare(
          `SELECT kind, COUNT(*) AS count FROM incidents
            WHERE created_at >= ? GROUP BY kind ORDER BY count DESC`
        )
        .bind(since)
        .all(),
      db
        .prepare(
          `SELECT path, kind, detail, created_at FROM incidents
            WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?`
        )
        .bind(since, limit)
        .all(),
    ]);

  const rows = (r) => r?.results || [];
  const iso = (t) => (Number.isFinite(t) ? new Date(t * 1000).toISOString() : null);
  const byClassification = Object.fromEntries(
    rows(totals).map((r) => [r.classification, r.requests])
  );
  const total = Object.values(byClassification).reduce((a, b) => a + b, 0);

  return {
    window: { days, since: iso(since), until: new Date().toISOString() },
    totals: { requests: total, by_classification: byClassification },
    // The tuning worklist: every UA here was a judgement call, not a match.
    unknown_bucket: {
      note:
        "Requests that accept HTML but send no browser fingerprint headers. " +
        "They are served the agent payload. Move the real agents into " +
        "KNOWN_AGENT_UA in src/classifier.js, and loosen the header rules if " +
        "real browsers show up here.",
      top_user_agents: rows(unknownAgents).map((r) => ({
        user_agent: r.user_agent,
        requests: r.requests,
        last_seen: iso(r.last_seen),
      })),
      recent: rows(recentUnknown).map((r) => ({
        path: r.path,
        user_agent: r.user_agent,
        at: iso(r.created_at),
      })),
    },
    agent_bucket: {
      top_user_agents: rows(agentAgents).map((r) => ({
        user_agent: r.user_agent,
        requests: r.requests,
        last_seen: iso(r.last_seen),
      })),
    },
    incidents: {
      by_kind: Object.fromEntries(rows(incidentTotals).map((r) => [r.kind, r.count])),
      recent: rows(recentIncidents).map((r) => ({
        path: r.path,
        kind: r.kind,
        detail: r.detail,
        at: iso(r.created_at),
      })),
    },
  };
}
