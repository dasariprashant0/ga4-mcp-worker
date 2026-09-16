/**
 * Analytics Engine — queryable time-series of what this server actually does.
 *
 * Workers Logs already carries a JSON line per tool error, but logs are for
 * reading one incident. This is for the questions you ask across weeks: who is
 * using it, which tools error most, how much GA4 quota we are burning.
 *
 * ---------------------------------------------------------------------------
 * THE SCHEMA IS SHARED WITH gtm-mcp-worker. DO NOT DIVERGE.
 * ---------------------------------------------------------------------------
 * Both Workers write to the SAME dataset (`analytics_events`), so one query
 * can cover both servers. `blob1` says which server wrote each row, so a
 * cross-server query works unchanged and a single-server one just adds
 * `WHERE blob1 = 'ga4-mcp-worker'`.
 *
 * Analytics Engine has no column names — it stores blob1..blob20 and
 * double1..double20 by position. Every query written against this dataset
 * refers to those positions, so a slot must mean the same thing in both
 * Workers or the shared columns become nonsense. Only ever APPEND at the end,
 * in both repos, and never repurpose a slot.
 *
 *   blob1  server            "ga4-mcp-worker"
 *   blob2  event             "tool"        (GA4 has no mutations)
 *   blob3  tool              e.g. "run_report"
 *   blob4  outcome           "ok" | "error"
 *   blob5  actor             signed-in user's email
 *   blob6  --                GTM account_id      — always "" here
 *   blob7  --                GTM container_id    — always "" here
 *   blob8  --                GTM workspace_id    — always "" here
 *   blob9  --                GTM entity_type     — always "" here
 *   blob10 --                GTM op              — always "" here
 *   blob11 --                GTM mode            — always "" here
 *   blob12 --                GTM dry_run         — always "" here
 *   blob13 error_kind        coarse classification, "" when outcome is ok
 *
 *   double1 duration_ms
 *   double2 is_error         1 or 0, so AVG() gives an error rate directly
 *   double3 --               GTM mutation budget — always 0 here
 *
 *   index   the Google `sub` — opaque, stable, one per person
 *
 * GA4's own property_id is NOT recorded. It lives in per-tool arguments that
 * the guard wrapper never sees, and capturing it would mean touching all nine
 * call sites. If a per-property breakdown ever matters, append it as blob14 in
 * BOTH repos rather than borrowing one of GTM's slots above.
 *
 * ---------------------------------------------------------------------------
 * PRIVACY AND RETENTION
 * ---------------------------------------------------------------------------
 * blob5 carries the signed-in user's email, because "who ran this" is the
 * point of an audit trail. It stays inside Cloudflare — the same place Workers
 * Logs already records it — and Analytics Engine retains roughly 90 days. To
 * drop it, pass ctx.sub instead of ctx.actor below; everything else keeps
 * working and blob5 simply stops being human-readable.
 *
 * No Analytics data is recorded: no dimension values, no metric values, no
 * report rows. Only which tool ran, and whether it worked.
 *
 * ---------------------------------------------------------------------------
 * FAILURE POLICY
 * ---------------------------------------------------------------------------
 * writeDataPoint is fire-and-forget and must never fail a tool call. The
 * binding is optional: absent in local dev, and absent on any deploy made
 * before it was added. Every call here is wrapped.
 */

import type { Ga4Ctx } from "./index.js";

const SERVER = "ga4-mcp-worker";

/** Analytics Engine caps a blob set at 5120 bytes total. Keep each one short. */
function blob(value: unknown, max = 128): string {
  if (value === undefined || value === null) return "";
  const s = String(value);
  return s.length <= max ? s : s.slice(0, max);
}

/**
 * Coarse classification of a failure, so you can chart "are we hitting GA4
 * quota" without full-text searching error messages.
 *
 * The strings matched here are the ones this Worker's own explainGoogleError()
 * produces, plus Google's status names.
 */
export function classifyError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("blocked by read-only endpoint allowlist")) return "blocked_by_allowlist";
  if (m.includes("invalid_grant")) return "auth";
  if (m.includes("http 429") || m.includes("resource_exhausted")) return "quota";
  if (m.includes("http 403") || m.includes("permission_denied")) return "permission";
  if (m.includes("http 401")) return "auth";
  if (m.includes("http 404") || m.includes("not_found")) return "not_found";
  if (m.includes("http 400") || m.includes("invalid_argument")) return "bad_request";
  if (m.includes("measurement id")) return "bad_property_id";
  return "other";
}

/** One row per tool call, successful or not. */
export function recordToolCall(
  ctx: Ga4Ctx,
  tool: string,
  durationMs: number,
  error?: string,
): void {
  const ds = ctx.env.analytics_engine;
  if (!ds) return; // Not bound: local dev, or a deploy predating the binding.

  try {
    ds.writeDataPoint({
      // "shared" covers the retired shared-secret mode, where there is no
      // per-person subject to key on.
      indexes: [blob(ctx.sub ?? "shared", 96)],
      blobs: [
        SERVER,
        "tool",
        blob(tool, 64),
        error ? "error" : "ok",
        blob(ctx.actor ?? "shared-credential"),
        "", // blob6  GTM account_id
        "", // blob7  GTM container_id
        "", // blob8  GTM workspace_id
        "", // blob9  GTM entity_type
        "", // blob10 GTM op
        "", // blob11 GTM mode
        "", // blob12 GTM dry_run
        error ? blob(classifyError(error), 40) : "",
      ],
      doubles: [durationMs, error ? 1 : 0, 0],
    });
  } catch {
    // Telemetry must never break a tool call. Swallow deliberately.
  }
}
