// Bull v2 — Anchor: orchestration. Two entry points the scheduler calls (all four managers are
// deadline-day filers — Feb 14/17 · May 15 · Aug 14 · Nov 14, typically after 4pm ET):
//
//   · runFilingEvening — the evening a 13F lands: fetch, parse, store; rebuild the clone; run the
//     re-trade gate against the previous build; run drift-watch; queue flags. Trading NEVER
//     happens here — a pending-rebuild marker is left in state, and…
//   · tradeNextOpen — next market open: read the marker, plan against live prices + ledger
//     positions, execute through the shared gateway, clear the marker.
//
//   · watchAmendments covers the ~60-day window after each deadline (config amendmentWatchDays):
//     Berkshire's confidential-treatment reveals land months late as NEW HOLDINGS /A filings;
//     Himalaya restated Q4'25 as a RESTATEMENT /A. A qualifying amendment re-runs the clone and
//     re-trades ONLY if the gate passes (top-5 membership change or a >2pp weight move).
//
// Config dials come from loadConfig() (anchor.*) — nothing numeric is hardcoded here.
import type { DatabaseSync } from "node:sqlite";
import { d9, mul9, type D9 } from "../../decimal.js";
import { getState, setState, clearState } from "../../db.js";
import type { EffectiveConfig } from "../../config.js";
import type { BrokerPort } from "../../broker.js";
import type { EdgarPort, MappingPort, PricePort, ManagerCfg, CloneBuild, DriftHit, FilingSummary } from "./types.js";
import { parseInfoTable } from "./infotable.js";
import { mapLines } from "./mapping.js";
import { buildClone, summarize, compareBuilds, type ManagerTable } from "./clone.js";
import { storeFiling, hasFiling, getCurrentLines, storedPeriods, storeBuild, latestBuild, queueApproval } from "./store.js";
import { driftWatch, daysPastDeadline, flagDrift, type DriftCfg } from "./drift.js";
import { top5TtmVsSpyPp9, quarterReturn9 } from "./prices.js";
import { planRebuild, executePlan, anchorPositions, writePositionMeta, type ExecuteResult } from "./planner.js";

export interface AnchorPorts {
  edgar: EdgarPort;
  mapping: MappingPort;
  prices: PricePort;
}

const PENDING_KEY = "anc:pending_rebuild";

/** Seed sleeve equity before any position exists: book equity × anchor split. Steady-state equity
 *  (positions value + sleeve cash share) is computed by the BOOK layer and passed in — the sleeve
 *  does not own cross-sleeve cash attribution. */
export function seedSleeveEquity9(eff: EffectiveConfig): D9 {
  return mul9(d9(eff.config.book.equityUsd), d9(eff.config.book.sleeveSplit.anc));
}

export interface FilingEveningResult {
  newFilings: { manager: string; accession: string; restated: boolean }[];
  missing: { manager: string; daysLate: number }[];
  build?: CloneBuild & { buildId: number };
  retrade: boolean;
  retradeReason?: string;
  driftHits: DriftHit[];
  mappingFlags: number;   // approvals rows written for unresolved CUSIPs
}

/** Fetch + store anything new for `period` across the manager set, then rebuild/gate/drift-watch.
 *  Idempotent: re-running the same evening re-fetches nothing already stored and re-queues nothing. */
export async function runFilingEvening(
  db: DatabaseSync, ports: AnchorPorts, eff: EffectiveConfig,
  opts: { period: string; today: string },
): Promise<FilingEveningResult> {
  const anchor = eff.config.anchor;
  const managers: ManagerCfg[] = anchor.managers;
  const driftCfg: DriftCfg = anchor.driftWatch;

  const newFilings: FilingEveningResult["newFilings"] = [];
  const missing: FilingEveningResult["missing"] = [];

  for (const m of managers) {
    const rec = await ports.edgar.latest13F(m.cik, opts.period);
    if (!rec) {
      const daysLate = daysPastDeadline(opts.period, opts.today);
      if (daysLate > 0) missing.push({ manager: m.name, daysLate });
      continue;
    }
    if (hasFiling(db, rec.cik, rec.period, rec.accession)) continue;
    const xml = await ports.edgar.fetchInfoTable(rec.accession);
    const lines = parseInfoTable(xml, rec.period);
    const { restated } = storeFiling(db, rec, lines);
    newFilings.push({ manager: m.name, accession: rec.accession, restated });
  }

  // Liveness flags for missing filers (the drift runner also covers this; here catches it earliest).
  const liveHits: DriftHit[] = [];
  for (const miss of missing) {
    const m = managers.find((x) => x.name === miss.manager)!;
    liveHits.push(...driftWatch({
      manager: m.name, cik: m.cik, summaries: [],
      liveness: { period: opts.period, daysLate: miss.daysLate },
    }, driftCfg));
  }

  let result: FilingEveningResult = { newFilings, missing, retrade: false, driftHits: liveHits, mappingFlags: 0 };
  if (newFilings.length === 0) {
    if (liveHits.length) flagDrift(db, liveHits);
    return result;
  }

  // Rebuild + gate + drift on the new state of the quarter.
  const rebuilt = await rebuildAndGate(db, ports, eff, opts.period, `filings:${newFilings.map((f) => f.accession).join(",")}`);
  const drift = await runDriftWatch(db, ports, eff, opts.period);
  result = { ...result, ...rebuilt, driftHits: [...liveHits, ...drift] };
  if (liveHits.length) flagDrift(db, liveHits);
  return result;
}

/** Shared: current tables → clone → store build → re-trade gate → pending marker. */
async function rebuildAndGate(
  db: DatabaseSync, ports: AnchorPorts, eff: EffectiveConfig, period: string, cause: string,
): Promise<Pick<FilingEveningResult, "build" | "retrade" | "retradeReason" | "mappingFlags">> {
  const anchor = eff.config.anchor;
  const managers: ManagerCfg[] = anchor.managers;

  const tables: ManagerTable[] = [];
  for (const m of managers) {
    const lines = getCurrentLines(db, m.cik, period);
    if (lines.length === 0) continue; // not filed yet — clone what exists (late filer flagged separately)
    tables.push({ manager: m, lines: await mapLines(ports.mapping, lines) });
  }
  if (tables.length === 0) return { retrade: false, mappingFlags: 0 };

  const prev = latestBuild(db);
  const build = buildClone(tables, { topN: anchor.topN, lineCapOfSlot: anchor.lineCapOfSlot }, period);

  // Mapping failures → approvals (kind 'anchor-mapping'), one row per line, never guessed around.
  let mappingFlags = 0;
  for (const flag of build.flags) {
    queueApproval(db, "anchor-mapping", `[anchor] unmapped CUSIP ${flag.cusip} (${flag.nameOfIssuer})`, flag);
    mappingFlags++;
  }

  const buildId = storeBuild(db, build, eff.version, cause);
  const stored = { ...build, buildId };

  let retrade = false;
  let retradeReason: string | undefined;
  if (!prev) {
    retrade = true;
    retradeReason = "initial-build";
  } else {
    const gate = compareBuilds(prev, build, anchor.retradeWeightMovePp);
    retrade = gate.retrade;
    if (retrade) retradeReason = gate.membershipChanged ? "membership-change" : "weight-move>2pp";
  }
  if (retrade) {
    setState(db, PENDING_KEY, JSON.stringify({ buildId, reason: retradeReason, cause, decided: new Date().toISOString() }));
  }
  return { build: stored, retrade, retradeReason, mappingFlags };
}

/** Drift-watch across the manager set for `period` (needs prior stored quarters for QoQ detectors).
 *  Performance guard uses the PRIOR quarter's top-5 (mapped) — the book a clone-follower actually
 *  held over the trailing year. Hits are flagged to approvals here. */
export async function runDriftWatch(
  db: DatabaseSync, ports: AnchorPorts, eff: EffectiveConfig, period: string,
): Promise<DriftHit[]> {
  const anchor = eff.config.anchor;
  const managers: ManagerCfg[] = anchor.managers;
  const driftCfg: DriftCfg = anchor.driftWatch;
  const all: DriftHit[] = [];

  for (const m of managers) {
    const periods = storedPeriods(db, m.cik).filter((p) => p <= period).sort().slice(-3);
    const summaries: FilingSummary[] = periods
      .map((p) => summarize(m.cik, m.name, p, getCurrentLines(db, m.cik, p)))
      .filter((s) => s.count > 0);
    if (summaries.length === 0) continue;

    // SPY QoQ returns aligned to consecutive summary pairs.
    const spyQoQReturn9: D9[] = [];
    for (let i = 1; i < summaries.length; i++) {
      const r = await quarterReturn9(ports.prices, summaries[i - 1].period, summaries[i].period);
      spyQoQReturn9.push(r ?? 0n); // unpriceable window → adjustment 0 (raw AUM change judged as-is)
    }

    // Performance guard: prior quarter's top-5 (cusips → tickers; unresolved → skip the guard).
    let perf: { ttmVsSpyPp9: D9 } | undefined;
    if (summaries.length >= 2) {
      const priorTop5 = summaries[summaries.length - 2].top5Keys;
      const symbols: string[] = [];
      for (const cusip of priorTop5) {
        const sym = await ports.mapping.tickerForCusip(cusip);
        if (sym) symbols.push(sym);
      }
      if (symbols.length === priorTop5.length) {
        const pp = await top5TtmVsSpyPp9(ports.prices, symbols, period);
        if (pp != null) perf = { ttmVsSpyPp9: pp };
      }
    }

    const hits = driftWatch({
      manager: m.name, cik: m.cik, summaries,
      ...(spyQoQReturn9.length ? { spyQoQReturn9 } : {}),
      ...(perf ? { perf } : {}),
    }, driftCfg);
    if (hits.length) flagDrift(db, hits);
    all.push(...hits);
  }
  return all;
}

/** Amendment watch (~60 days per period): any NEW accession for a watched quarter is fetched,
 *  stored (restatements replace), and pushed through the same rebuild + re-trade gate. */
export async function watchAmendments(
  db: DatabaseSync, ports: AnchorPorts, eff: EffectiveConfig, opts: { period: string; today: string },
): Promise<{ newFilings: number; retrade: boolean }> {
  const anchor = eff.config.anchor;
  const managers: ManagerCfg[] = anchor.managers;

  let newFilings = 0;
  for (const m of managers) {
    const index = await ports.edgar.filingIndex(m.cik);
    for (const rec of index) {
      if (rec.period !== opts.period) continue;
      if (hasFiling(db, rec.cik, rec.period, rec.accession)) continue;
      const xml = await ports.edgar.fetchInfoTable(rec.accession);
      const lines = parseInfoTable(xml, rec.period);
      storeFiling(db, rec, lines);
      newFilings++;
    }
  }
  if (newFilings === 0) return { newFilings, retrade: false };
  const rebuilt = await rebuildAndGate(db, ports, eff, opts.period, `amendment-watch:${opts.today}`);
  return { newFilings, retrade: rebuilt.retrade };
}

/** Is `today` still inside the amendment-watch window for `period`? (scheduler helper) */
export function inAmendmentWindow(period: string, today: string, eff: EffectiveConfig): boolean {
  return daysPastDeadline(period, today) <= eff.config.anchor.amendmentWatchDays;
}

export interface TradeResult {
  traded: boolean;
  reason?: string;
  execute?: ExecuteResult;
  problems?: string[];
}

/** Next market open after a pending rebuild: plan against live prices + ledger, execute via the
 *  gateway, clear the marker. Sleeve equity is supplied by the book layer (seedSleeveEquity9 for
 *  the initial build). */
export async function tradeNextOpen(
  db: DatabaseSync, broker: BrokerPort, prices: PricePort, eff: EffectiveConfig,
  opts: { asOfDate: string; sleeveEquity9: D9 },
): Promise<TradeResult> {
  const pending = getState(db, PENDING_KEY);
  if (!pending) return { traded: false, reason: "no-pending-rebuild" };
  const marker = JSON.parse(pending) as { buildId: number; reason: string };

  // Always trade the NEWEST build: if an amendment superseded the marker's build between evening
  // and open, the newest build's gate already passed transitively (a marker only exists gated).
  const target = latestBuild(db);
  if (!target) { clearState(db, PENDING_KEY); return { traded: false, reason: "no-build" }; }
  const positions = anchorPositions(db);

  const priceMap = new Map<string, D9>();
  for (const sym of new Set([...target.targets.keys(), ...positions.keys()])) {
    const p = await prices.latestPrice9(sym);
    if (p != null) priceMap.set(sym, p);
  }

  const plan = planRebuild({
    targets: target.targets,
    positions,
    prices: priceMap,
    sleeveEquity9: opts.sleeveEquity9,
    driftBandRel: eff.config.anchor.driftBandRel,
    reason: marker.reason,
  });

  const execute = await executePlan(db, broker, plan.orders, {
    asOfDate: opts.asOfDate,
    configVersion: eff.version,
    washBlacklistDays: eff.config.ledger.washBlacklistDays,
  });

  const slotsBySymbol = new Map<string, string[]>();
  for (const slot of target.slots) {
    for (const line of slot.lines) {
      slotsBySymbol.set(line.symbol, [...(slotsBySymbol.get(line.symbol) ?? []), slot.manager]);
    }
  }
  writePositionMeta(db, target.targets, slotsBySymbol);
  clearState(db, PENDING_KEY);
  return { traded: execute.placed > 0, reason: marker.reason, execute, problems: plan.problems };
}
