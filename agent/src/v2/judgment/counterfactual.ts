// Bull v2 — counterfactual ledger (design §6, CJ's "make sure it actually works"). Every thesis-
// check verdict logs its full input hash, votes, action, and the counterfactual path: the stop-fill
// assumed at the stop price with proceeds parked in the sleeve's proxy (IWM for insider, SPY for
// wildcard). Outcomes append at 1/3/6 months; value_add = actual − counterfactual (positive = the
// hold beat the mechanical stop). ~8–12 events/yr is TELEMETRY, not proof — the ledger's job is to
// catch a broken judgment layer early via pre-registered kill-switches, and to reconstruct the
// pure-mechanical record so the insider signal stays cleanly testable.
import type { DatabaseSync } from "node:sqlite";
import { d9, d9str, mul9, div9, type D9 } from "./../decimal.js";
import { getState, setState } from "./../db.js";

export const PROXY_FOR: Record<string, string> = { ins: "IWM", wld: "SPY" };

export function ensureJdgTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS jdg_verdicts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      sleeve TEXT NOT NULL,
      symbol TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      votes_json TEXT NOT NULL,
      class TEXT NOT NULL,
      action TEXT NOT NULL,           -- sell_now | hold_with_floor | escalate_hold
      entry_price9 TEXT NOT NULL,
      verdict_price9 TEXT NOT NULL,
      stop_price9 TEXT NOT NULL,
      qty9 TEXT NOT NULL,
      proxy_symbol TEXT NOT NULL,
      proxy_price9 TEXT NOT NULL,     -- proxy at verdict time (counterfactual basis)
      bear_severity TEXT,
      config_version TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jdg_outcomes (
      verdict_id INTEGER NOT NULL REFERENCES jdg_verdicts(id),
      checkpoint_months INTEGER NOT NULL,   -- 1 | 3 | 6
      date TEXT NOT NULL,
      position_price9 TEXT NOT NULL,
      proxy_price9 TEXT NOT NULL,
      actual_value9 TEXT NOT NULL,
      counterfactual_value9 TEXT NOT NULL,
      value_add9 TEXT NOT NULL,             -- actual − counterfactual
      PRIMARY KEY (verdict_id, checkpoint_months)
    );
  `);
}

export interface VerdictRecord {
  ts: string; sleeve: string; symbol: string; inputHash: string; votesJson: string;
  cls: string; action: string; entryPrice9: D9; verdictPrice9: D9; stopPrice9: D9; qty9: D9;
  proxyPrice9: D9; bearSeverity?: string; configVersion: string;
}

export function recordVerdict(db: DatabaseSync, v: VerdictRecord): number {
  ensureJdgTables(db);
  const res = db.prepare(
    `INSERT INTO jdg_verdicts(ts, sleeve, symbol, input_hash, votes_json, class, action, entry_price9,
       verdict_price9, stop_price9, qty9, proxy_symbol, proxy_price9, bear_severity, config_version)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(v.ts, v.sleeve, v.symbol, v.inputHash, v.votesJson, v.cls, v.action,
    d9str(v.entryPrice9), d9str(v.verdictPrice9), d9str(v.stopPrice9), d9str(v.qty9),
    PROXY_FOR[v.sleeve] ?? "SPY", d9str(v.proxyPrice9), v.bearSeverity ?? null, v.configVersion);
  return Number(res.lastInsertRowid);
}

const CHECKPOINTS = [1, 3, 6] as const;

/** Verdicts owing an outcome checkpoint at `asOfDate` (checkpoint month elapsed, row absent). */
export function dueOutcomes(db: DatabaseSync, asOfDate: string): { verdictId: number; checkpoint: number; symbol: string; sleeve: string }[] {
  ensureJdgTables(db);
  const out: { verdictId: number; checkpoint: number; symbol: string; sleeve: string }[] = [];
  const verdicts = db.prepare("SELECT id, ts, symbol, sleeve FROM jdg_verdicts").all() as any[];
  for (const v of verdicts) {
    for (const m of CHECKPOINTS) {
      const dueDate = new Date(new Date(v.ts).getTime() + m * 30.44 * 86_400_000).toISOString().slice(0, 10);
      if (dueDate > asOfDate) continue;
      const exists = db.prepare("SELECT 1 FROM jdg_outcomes WHERE verdict_id=? AND checkpoint_months=?").get(v.id, m);
      if (!exists) out.push({ verdictId: v.id, checkpoint: m, symbol: v.symbol, sleeve: v.sleeve });
    }
  }
  return out;
}

/** Append one outcome. actual = the verdict's real path (hold → qty × current price; sell_now →
 *  proceeds parked in proxy, same as the counterfactual by construction → value_add 0, which is the
 *  honest accounting: the mechanical alternative WAS selling). counterfactual = stop-fill proceeds
 *  grown by the proxy since verdict time. */
export function recordOutcome(db: DatabaseSync, verdictId: number, checkpoint: number, date: string,
  positionPrice9: D9, proxyPriceNow9: D9): { valueAdd9: D9 } {
  ensureJdgTables(db);
  const v = db.prepare("SELECT * FROM jdg_verdicts WHERE id=?").get(verdictId) as any;
  if (!v) throw new Error(`recordOutcome: no verdict ${verdictId}`);
  const qty = d9(v.qty9);
  const stopProceeds = mul9(qty, d9(v.stop_price9));
  const proxyGrowth = div9(proxyPriceNow9, d9(v.proxy_price9));
  const counterfactual = mul9(stopProceeds, proxyGrowth);
  const actual = v.action === "sell_now" ? counterfactual : mul9(qty, positionPrice9);
  const valueAdd = actual - counterfactual;
  db.prepare(
    `INSERT INTO jdg_outcomes(verdict_id, checkpoint_months, date, position_price9, proxy_price9,
       actual_value9, counterfactual_value9, value_add9)
     VALUES(?,?,?,?,?,?,?,?)
     ON CONFLICT(verdict_id, checkpoint_months) DO NOTHING`,
  ).run(verdictId, checkpoint, date, d9str(positionPrice9), d9str(proxyPriceNow9),
    d9str(actual), d9str(counterfactual), d9str(valueAdd));
  return { valueAdd9: valueAdd };
}

export const JDG_MODE_KEY = "judg:mode"; // absent → protocol on; "mechanical" → stops fire as placed

export interface KillSwitchFlag { kind: "revert-mechanical" | "rubric-fix"; reason: string; }

/** Pre-registered kill-switches (design §6) — evaluated by the weekly ritual, never tuned by config:
 *  (a) a held-through position later −80% from entry while the bear brief carried the evidence
 *      (severity high or a break vote existed) → revert to mechanical stops;
 *  (b) cumulative 6-mo value_add < −10% of sleeve NAV → revert;
 *  (c) panel disagreement (non-unanimous verdicts) > 50% trailing 6-mo → rubric fix.
 *  Reverting SETS judg:mode=mechanical (code reads it before every protocol run) and the caller
 *  files the approvals row — un-reverting is CJ's explicit call. */
export function evaluateKillSwitches(db: DatabaseSync, opts: { asOfDate: string; sleeveNav9: Record<string, D9> }): KillSwitchFlag[] {
  ensureJdgTables(db);
  const flags: KillSwitchFlag[] = [];
  const since = new Date(new Date(opts.asOfDate + "T00:00:00Z").getTime() - 6 * 30.44 * 86_400_000).toISOString();

  // (a) bankruptcy-hold: latest outcome shows −80%+ from entry on a hold verdict with bear evidence.
  const holds = db.prepare("SELECT * FROM jdg_verdicts WHERE action != 'sell_now'").all() as any[];
  for (const v of holds) {
    const latest = db.prepare("SELECT position_price9 FROM jdg_outcomes WHERE verdict_id=? ORDER BY checkpoint_months DESC LIMIT 1").get(v.id) as any;
    if (!latest) continue;
    const entry = d9(v.entry_price9);
    const now = d9(latest.position_price9);
    const collapsed = entry > 0n && now * 5n <= entry; // ≤ 20% of entry = −80%
    const bearHadIt = v.bear_severity === "high" || String(v.votes_json).includes("thesis_break");
    if (collapsed && bearHadIt) {
      flags.push({ kind: "revert-mechanical", reason: `held ${v.symbol} through collapse (−80%+) with bear-brief evidence on record (verdict ${v.id})` });
    }
  }

  // (b) cumulative trailing-6mo value_add vs each sleeve's NAV.
  for (const [sleeve, nav] of Object.entries(opts.sleeveNav9)) {
    const rows = db.prepare(
      `SELECT o.value_add9 FROM jdg_outcomes o JOIN jdg_verdicts v ON v.id=o.verdict_id
       WHERE v.sleeve=? AND v.ts >= ?`,
    ).all(sleeve, since) as { value_add9: string }[];
    const cum = rows.reduce((a, r) => a + d9(r.value_add9), 0n);
    if (nav > 0n && cum < 0n && (-cum) * 10n >= nav) {
      flags.push({ kind: "revert-mechanical", reason: `cumulative 6mo thesis-check value-add ${d9str(cum)} breaches −10% of ${sleeve} NAV ${d9str(nav)}` });
    }
  }

  // (c) disagreement rate over trailing 6mo.
  const recent = db.prepare("SELECT votes_json FROM jdg_verdicts WHERE ts >= ?").all(since) as { votes_json: string }[];
  if (recent.length >= 4) {
    let split = 0;
    for (const r of recent) {
      const classes = new Set((JSON.parse(r.votes_json) as { class: string }[]).map((x) => x.class));
      if (classes.size > 1) split++;
    }
    if (split / recent.length > 0.5) {
      flags.push({ kind: "rubric-fix", reason: `judge panel disagreed on ${split}/${recent.length} verdicts (>50%) — rubric needs work, not more votes` });
    }
  }

  if (flags.some((f) => f.kind === "revert-mechanical") && getState(db, JDG_MODE_KEY) !== "mechanical") {
    setState(db, JDG_MODE_KEY, "mechanical");
  }
  return flags;
}
