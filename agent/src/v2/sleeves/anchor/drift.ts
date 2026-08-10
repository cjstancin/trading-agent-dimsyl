// Bull v2 — Anchor: drift-watch. Seven PURE detectors over consecutive filing summaries that answer
// one question per manager: "is this still the manager CJ locked?" Every hit becomes an approvals
// row (kind 'anchor-drift') for CJ's queue — the sleeve NEVER auto-swaps a manager; drift-watch is
// a smoke alarm, not a sprinkler system.
//
// Threshold conventions (all dials from config anchor.driftWatch; never hardcoded here):
//   · "share" thresholds are fractions (0.5 = 50%); "Pp" thresholds are percentage points;
//   · comparisons are STRICT (> warn-threshold fires, == does not) except the top-10 floor,
//     which fires strictly BELOW the minimum — so an exactly-at-threshold quarter never flags;
//   · "2 consecutive = eject" detectors need the condition true for the two most recent
//     quarter-pairs; with less history they can only warn.
// All ratio math is bigint/d9 — a drift verdict must never hinge on float rounding of reported values.
import type { DatabaseSync } from "node:sqlite";
import { d9, d9str, mul9, abs9, ONE9, type D9 } from "../../decimal.js";
import { addDays } from "../../lots.js";
import { isWeekendET, isKnownNyseHoliday } from "../../../market-calendar.js";
import type { FilingSummary, DriftHit } from "./types.js";
import { queueApproval } from "./store.js";

export interface DriftCfg {
  top10ShareMin: number;      // 0.5
  top5DropPpEject: number;    // 15 (pp QoQ drop)
  nameChurnWarn: number;      // 0.3
  nameChurnEject: number;     // 0.5
  weightTurnoverWarn: number; // 0.2
  weightTurnoverEject: number;// 0.35
  aumAnomalyWarnPct: number;  // 25 (% per quarter, market-adjusted)
  aumAnomalyEjectPct: number; // 40 (% over 2 quarters, market-adjusted)
  nonEquityWarn: number;      // 0.1
  nonEquityEject: number;     // 0.25
  perfGuardWarnPp: number;    // -15
  perfGuardEjectPp: number;   // -25
  filingLateDays: number;     // 5
}

export interface DriftInput {
  manager: string;
  cik: string;
  /** Consecutive filing summaries, ASCENDING by period (oldest first). QoQ detectors need ≥2;
   *  "2 consecutive" ejects need ≥3. */
  summaries: FilingSummary[];
  /** SPY total return per quarter as d9 fractions, aligned so spyQoQReturn9[i] covers the quarter
   *  ENDING at summaries[i+1].period (i.e., one fewer entry than summaries). Feeds aum-anomaly. */
  spyQoQReturn9?: D9[];
  /** Performance guard input: the manager's PRIOR top-5 basket TTM return minus SPY TTM, in d9
   *  PERCENTAGE POINTS, for the current and (optionally) previous quarter. Computed by prices.ts. */
  perf?: { ttmVsSpyPp9: D9; prevTtmVsSpyPp9?: D9 };
  /** Liveness input (from the filing-evening loop): days past the 45-day deadline with no filing,
   *  and the ADV deregistration flag (instant eject — the firm is winding down). */
  liveness?: { period: string; daysLate?: number; advDeregistered?: boolean };
}

/** pp (config number) → d9 FRACTION (15 → 0.15). Exact for integer/decimal config values. */
function ppFrac9(pp: number): D9 {
  return d9(pp) / 100n;
}

/** bigint ratio → d9 fraction change ((cur-prev)/prev), truncated — threshold-compare only. */
function change9(cur: bigint, prev: bigint): D9 {
  if (prev === 0n) return 0n;
  return ((cur - prev) * ONE9) / prev;
}

/** Run all seven detectors. Pure — returns hits; flagDrift() persists them. */
export function driftWatch(input: DriftInput, cfg: DriftCfg): DriftHit[] {
  const { manager, cik, summaries } = input;
  const hits: DriftHit[] = [];
  const n = summaries.length;
  const cur = n > 0 ? summaries[n - 1] : undefined;
  const prev = n > 1 ? summaries[n - 2] : undefined;
  const prevPrev = n > 2 ? summaries[n - 3] : undefined;
  const period = cur?.period ?? input.liveness?.period ?? "?";
  const hit = (detector: DriftHit["detector"], level: "warn" | "eject", evidence: Record<string, unknown>): void => {
    hits.push({ detector, level, manager, cik, period, evidence });
  };

  // 1. Deconcentration — top-10 < 50% of value, or top-5 share dropped >15pp QoQ. One quarter =
  //    warn; the condition true for two CONSECUTIVE quarters = eject flag. A concentrated
  //    best-ideas book is the entire reason the manager is a slot — deconcentration means the
  //    edge we're cloning is being diluted into an index.
  if (cur) {
    const deconAt = (c: FilingSummary, p?: FilingSummary): boolean => {
      if (c.top10Share9 < d9(cfg.top10ShareMin)) return true;
      if (p && p.top5Share9 - c.top5Share9 > ppFrac9(cfg.top5DropPpEject)) return true;
      return false;
    };
    const nowBad = deconAt(cur, prev);
    const prevBad = prev ? deconAt(prev, prevPrev) : false;
    if (nowBad) {
      hit("deconcentration", prevBad ? "eject" : "warn", {
        top10Share: d9str(cur.top10Share9),
        top5Share: d9str(cur.top5Share9),
        prevTop5Share: prev ? d9str(prev.top5Share9) : null,
        consecutive: prevBad,
      });
    }
  }

  // 2. Name churn — fraction of last quarter's names GONE this quarter. A best-ideas manager
  //    holding >1yr should churn slowly; >30% warns, >50% flags eject (strategy change).
  if (cur && prev) {
    const prevKeys = new Set(prev.weights.keys());
    const inter = [...cur.weights.keys()].filter((k) => prevKeys.has(k)).length;
    const churn = prevKeys.size === 0 ? 0n : ((BigInt(prevKeys.size - inter)) * ONE9) / BigInt(prevKeys.size);
    if (churn > d9(cfg.nameChurnEject)) hit("name-churn", "eject", { churn: d9str(churn), prevNames: prevKeys.size, retained: inter });
    else if (churn > d9(cfg.nameChurnWarn)) hit("name-churn", "warn", { churn: d9str(churn), prevNames: prevKeys.size, retained: inter });
  }

  // 3. Weight turnover — Σ|Δw|/2 over the union of names. Catches the manager who keeps the same
  //    names but trades them like a momentum book (>20% warn / >35% eject per quarter).
  if (cur && prev) {
    let sum = 0n;
    const keys = new Set([...cur.weights.keys(), ...prev.weights.keys()]);
    for (const k of keys) sum += abs9((cur.weights.get(k) ?? 0n) - (prev.weights.get(k) ?? 0n));
    const turnover = sum / 2n;
    if (turnover > d9(cfg.weightTurnoverEject)) hit("weight-turnover", "eject", { turnover: d9str(turnover) });
    else if (turnover > d9(cfg.weightTurnoverWarn)) hit("weight-turnover", "warn", { turnover: d9str(turnover) });
  }

  // 4. Market-adjusted AUM anomaly — 13F value change minus what the market alone explains.
  //    >25% in a quarter warns (big inflows/outflows/liquidations); >40% cumulative over two
  //    quarters flags eject. Redemption spirals force selling that has nothing to do with conviction.
  if (cur && prev && input.spyQoQReturn9?.length) {
    const spy = input.spyQoQReturn9;
    const lastSpy = spy[spy.length - 1];
    const adj = change9(cur.totalValueUsd, prev.totalValueUsd) - lastSpy;
    const warnFrac = ppFrac9(cfg.aumAnomalyWarnPct);
    let ejected = false;
    if (prevPrev && spy.length >= 2) {
      const spyPrev = spy[spy.length - 2];
      // Cumulative 2-quarter market move: (1+s1)(1+s2) − 1, exact in d9.
      const spyCum = mul9(ONE9 + spyPrev, ONE9 + lastSpy) - ONE9;
      const adj2 = change9(cur.totalValueUsd, prevPrev.totalValueUsd) - spyCum;
      if (abs9(adj2) > ppFrac9(cfg.aumAnomalyEjectPct)) {
        hit("aum-anomaly", "eject", { adjChange2q: d9str(adj2), aum: String(cur.totalValueUsd), aum2qAgo: String(prevPrev.totalValueUsd) });
        ejected = true;
      }
    }
    if (!ejected && abs9(adj) > warnFrac) {
      hit("aum-anomaly", "warn", { adjChangeQoQ: d9str(adj), aum: String(cur.totalValueUsd), prevAum: String(prev.totalValueUsd), spyQoQ: d9str(lastSpy) });
    }
  }

  // 5. Representativeness — options + ETFs + non-common classes as a share of 13F value. Above
  //    10%/25% the public table stops describing the real book, and a clone of it is fiction.
  if (cur) {
    if (cur.nonEquityShare9 > d9(cfg.nonEquityEject)) hit("representativeness", "eject", { nonEquityShare: d9str(cur.nonEquityShare9) });
    else if (cur.nonEquityShare9 > d9(cfg.nonEquityWarn)) hit("representativeness", "warn", { nonEquityShare: d9str(cur.nonEquityShare9) });
  }

  // 6. Performance guard — the manager's PRIOR top-5 TTM vs SPY. < −15pp warns; < −25pp for two
  //    consecutive quarters flags eject. The one detector that judges results, not structure —
  //    deliberately slow (TTM, two strikes) because the sleeve exists to buy through drawdowns.
  if (input.perf) {
    const { ttmVsSpyPp9, prevTtmVsSpyPp9 } = input.perf;
    const ejectAt = d9(cfg.perfGuardEjectPp); // e.g. −25 (d9 pp)
    if (ttmVsSpyPp9 < ejectAt && prevTtmVsSpyPp9 != null && prevTtmVsSpyPp9 < ejectAt) {
      hit("performance-guard", "eject", { ttmVsSpyPp: d9str(ttmVsSpyPp9), prevTtmVsSpyPp: d9str(prevTtmVsSpyPp9) });
    } else if (ttmVsSpyPp9 < d9(cfg.perfGuardWarnPp)) {
      hit("performance-guard", "warn", { ttmVsSpyPp: d9str(ttmVsSpyPp9) });
    }
  }

  // 7. Liveness — a filing missing 5+ days past the 45-day deadline warns (something is wrong at
  //    the firm or with our fetch — either needs eyes); ADV deregistration is an instant eject
  //    flag (the adviser is shutting down; there will be no more filings to clone).
  if (input.liveness) {
    const { daysLate, advDeregistered } = input.liveness;
    if (advDeregistered) hit("liveness", "eject", { advDeregistered: true });
    else if (daysLate != null && daysLate >= cfg.filingLateDays) hit("liveness", "warn", { daysLate, period: input.liveness.period });
  }

  return hits;
}

/** 13F deadline for a quarter: period end + 45 calendar days, rolled FORWARD past weekends and
 *  NYSE-holiday proxies for SEC holidays (Feb 14→17 when the 14th is a Saturday — the design's
 *  "Feb 14/17" is exactly this roll). */
export function filingDeadline(period: string): string {
  let day = addDays(period, 45);
  for (let i = 0; i < 7; i++) {
    const dt = new Date(day + "T12:00:00Z");
    if (!isWeekendET(dt) && !isKnownNyseHoliday(dt)) return day;
    day = addDays(day, 1);
  }
  return day;
}

/** Calendar days `today` is past the filing deadline for `period` (0 when not yet late). */
export function daysPastDeadline(period: string, today: string): number {
  const deadline = filingDeadline(period);
  if (today <= deadline) return 0;
  const ms = new Date(today + "T12:00:00Z").getTime() - new Date(deadline + "T12:00:00Z").getTime();
  return Math.round(ms / 86_400_000);
}

/** Persist detector hits to the approvals queue (kind 'anchor-drift'). Returns approval ids.
 *  This is the ONLY side effect drift-watch has — flags for CJ, never swaps. */
export function flagDrift(db: DatabaseSync, hits: DriftHit[]): number[] {
  return hits.map((h) =>
    queueApproval(db, "anchor-drift", `[anchor] ${h.manager}: ${h.detector} ${h.level.toUpperCase()} (${h.period})`, h),
  );
}
