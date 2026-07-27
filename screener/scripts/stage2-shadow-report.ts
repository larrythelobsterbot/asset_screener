import Database from "better-sqlite3";
import path from "node:path";

import {
  buildStage2ShadowReport,
  type Stage2ShadowReportRow,
  type Stage2TargetCounterfactualReportRow,
} from "../src/lib/stage2ShadowReport";

const LIMIT = 10_000;
const dbPath = process.env.SCREENER_DB_PATH ?? path.join(process.cwd(), "data", "screener.db");
const db = new Database(dbPath, { readonly: true, fileMustExist: true });

try {
  const candidateRows = db.prepare(`
    select
      candidate.id as candidate_id,
      candidate.strategy_version as candidate_strategy_version,
      candidate.shadow_policy_json,
      alert.id as alert_id,
      alert.delivery_status,
      alert.outcome_status as live_outcome_status,
      alert.pnl_r as live_pnl_r,
      counterfactual.outcome_status as counterfactual_outcome_status,
      counterfactual.pnl_r as counterfactual_pnl_r
    from alert_candidates candidate
    left join telegram_alerts alert
      on alert.candidate_id = candidate.id and alert.candidate_attribution = 'linked'
    left join telegram_alert_counterfactuals counterfactual
      on counterfactual.alert_id = alert.id
      and counterfactual.policy_version = 'target-1_5r-v1'
    where candidate.shadow_policy_json is not null
    order by candidate.evaluated_at desc, candidate.id desc
    limit ?
  `).all(LIMIT + 1) as Stage2ShadowReportRow[];

  const targetRows = db.prepare(`
    select outcome_status, pnl_r
    from telegram_alert_counterfactuals
    where policy_version = 'target-1_5r-v1'
    order by id desc
    limit ?
  `).all(LIMIT + 1) as Stage2TargetCounterfactualReportRow[];

  const candidateTruncated = candidateRows.length > LIMIT;
  const targetTruncated = targetRows.length > LIMIT;
  const attributionFailures = db.prepare(`
    select count(*) as count
    from telegram_alerts
    where candidate_attribution = 'failed' and delivery_status = 'delivered'
  `).get() as { count: number };
  const report = buildStage2ShadowReport(candidateRows.slice(0, LIMIT), {
    sampleTruncated: candidateTruncated,
    targetSampleTruncated: targetTruncated,
    targetCounterfactuals: targetRows.slice(0, LIMIT),
    attributionFailures: attributionFailures.count,
  });

  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    database: dbPath,
    bounds: {
      candidateLimit: LIMIT,
      targetCounterfactualLimit: LIMIT,
      candidateTruncated,
      targetTruncated,
    },
    ...report,
  }, null, 2));
} finally {
  db.close();
}
