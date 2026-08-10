// Bull v2 insider sleeve — pure cluster engine (design cluster filter, v1 params journaled in
// config: insider.cluster). Zero I/O: BuyEvents in, Clusters out. Every threshold comes from the
// config subtree (never hardcoded); only the SCORING weights are code constants because the design
// fixes them outside config (role points CFO 1.5 > CEO 1.25 > officer/indep-dir 1.0, first-ever
// bonus) — they're grouped below so a future amendment can lift them into config in one move.
//
// The rules, verbatim: ≥3 distinct insider CIKs buying within a 10-calendar-day rolling window
// keyed on TRADE date; ≥$10k per insider, ≥$100k cluster aggregate; role gate ≥1 officer OR
// ≥2 directors AND ≥2 participants who aren't pure 10%-owner entities (fund/LP/LLC vehicles);
// routine-buyer screen (CMP proxy): same-calendar-month P-buys in each of 3 prior years drops that
// insider; first-ever-buy earns a score bonus.
import { d9, d9num, d9str, type D9 } from "../../decimal.js";

export interface BuyEvent {
  symbol: string;
  issuerCik: string;
  ownerCik: string;
  ownerName: string;
  isOfficer: boolean;
  isDirector: boolean;
  isTenPercentOwner: boolean;
  officerTitle: string | null;
  tradeDate: string;          // YYYY-MM-DD — the window keys on TRADE date, not filing date
  shares9: D9;
  value9: D9;                 // shares × price
  sharesAfter9: D9 | null;
}

export interface ClusterParticipant {
  cik: string;
  name: string;
  isOfficer: boolean;
  isDirector: boolean;
  isTenPercentOwner: boolean;
  officerTitle: string | null;
  value9: string;             // d9str decimal string (participants ride in a JSON column)
  shares9: string;            // d9str decimal string
  deltaOwnFrac: number;       // conviction: bought / held-before (capped 1; analytics-only float)
  firstEver: boolean;
}

export interface Cluster {
  clusterId: string;          // deterministic: ins:{symbol}:{windowEnd}
  symbol: string;
  issuerCik: string;
  windowStart: string;
  windowEnd: string;
  participants: ClusterParticipant[];
  aggregate9: D9;
  officerCount: number;
  directorCount: number;
  score: number;
}

export interface ClusterCfg {
  minInsiders: number;
  windowDays: number;
  minPerInsiderUsd: number;
  minAggregateUsd: number;
  roleGate: { minOfficers: number; orMinDirectors: number; minNonOwnerParticipants: number };
  exclude10b51: boolean; // enforced upstream in form4.classifyTxn; kept for config completeness
}

/** Prior P-buy trade dates for (owner, issuer) — routine screen + first-ever detection. */
export type OwnerHistoryFn = (ownerCik: string) => string[];

// Scoring constants (design-fixed, not config — see header).
const ROLE_PTS_CFO = 1.5;
const ROLE_PTS_CEO = 1.25;
const ROLE_PTS_OFFICER_OR_DIRECTOR = 1.0;
const FIRST_EVER_BONUS = 0.25;

const RE_CFO = /\bCFO\b|chief\s+financial/i;
const RE_CEO = /\bCEO\b|chief\s+executive/i;
// Institutional-vehicle name shapes — a pure 10%-owner whose name reads like a fund is plumbing,
// not conviction.
const RE_ENTITY = /\b(L\.?\s?P|LLC|L\.L\.C|LTD|INC|FUND|CAPITAL|PARTNERS|MANAGEMENT|ADVIS[OE]RS|HOLDINGS|TRUST|VENTURES|GP)\b\.?/i;

/** Calendar-day difference b − a (both YYYY-MM-DD). Noon-UTC anchored so DST can't skew it. */
export function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 86_400_000);
}

/** Routine-buyer screen (CMP proxy): the insider bought (code P) in this same calendar month in
 *  EACH of the 3 prior years → their buying is a program, not a signal. */
export function isRoutineBuyer(buyDate: string, priorPBuyDates: string[]): boolean {
  const month = buyDate.slice(5, 7);
  const year = parseInt(buyDate.slice(0, 4), 10);
  for (let k = 1; k <= 3; k++) {
    const target = String(year - k);
    if (!priorPBuyDates.some((d) => d.slice(0, 4) === target && d.slice(5, 7) === month)) return false;
  }
  return true;
}

/** A "pure 10%-owner entity": no officer/director seat AND (flagged 10% owner OR a fund-shaped
 *  name). Two of these can't satisfy the role gate's human-conviction requirement. */
export function isPureOwnerEntity(p: { isOfficer: boolean; isDirector: boolean; isTenPercentOwner: boolean; name: string }): boolean {
  if (p.isOfficer || p.isDirector) return false;
  return p.isTenPercentOwner || RE_ENTITY.test(p.name);
}

function rolePoints(p: ClusterParticipant): number {
  if (p.isOfficer && p.officerTitle && RE_CFO.test(p.officerTitle)) return ROLE_PTS_CFO;
  if (p.isOfficer && p.officerTitle && RE_CEO.test(p.officerTitle)) return ROLE_PTS_CEO;
  if (p.isOfficer || p.isDirector) return ROLE_PTS_OFFICER_OR_DIRECTOR;
  return 0;
}

/** Selection score (design): breadth + role points + log10(cluster$/minAggregate) + conviction
 *  (Δown%) + first-ever bonus. Floats are fine here — the score ranks candidates, it never touches
 *  money math. */
export function scoreCluster(participants: ClusterParticipant[], aggregate9: D9, cfg: ClusterCfg): number {
  const breadth = participants.length;
  const rolePts = participants.reduce((a, p) => a + rolePoints(p), 0);
  const sizePts = Math.log10(Math.max(d9num(aggregate9) / cfg.minAggregateUsd, 1));
  const conviction = participants.length
    ? participants.reduce((a, p) => a + p.deltaOwnFrac, 0) / participants.length
    : 0;
  const firstEverPts = FIRST_EVER_BONUS * participants.filter((p) => p.firstEver).length;
  return breadth + rolePts + sizePts + conviction + firstEverPts;
}

export interface WindowEval {
  qualifies: boolean;
  failReason: string | null;
  participants: ClusterParticipant[];
  aggregate9: D9;
  officerCount: number;
  directorCount: number;
  windowStart: string;
  windowEnd: string;
}

/** Evaluate ONE fixed set of buys as a candidate cluster window. Exported separately so amendment
 *  re-qualification can re-run the exact same gates over a stored cluster's window. */
export function evaluateWindow(buys: BuyEvent[], history: OwnerHistoryFn, cfg: ClusterCfg): WindowEval {
  const empty = (reason: string): WindowEval => ({
    qualifies: false, failReason: reason, participants: [], aggregate9: 0n,
    officerCount: 0, directorCount: 0, windowStart: "", windowEnd: "",
  });
  if (!buys.length) return empty("no-buys");

  // Routine-buyer screen drops the INSIDER (all their buys), not just one transaction.
  const routine = new Set<string>();
  for (const b of buys) if (isRoutineBuyer(b.tradeDate, history(b.ownerCik))) routine.add(b.ownerCik);
  const live = buys.filter((b) => !routine.has(b.ownerCik));
  if (!live.length) return empty("all-routine");

  // Per-insider aggregation: an insider clears the $10k bar on their SUMMED buys in the window.
  const byOwner = new Map<string, BuyEvent[]>();
  for (const b of live) {
    const arr = byOwner.get(b.ownerCik) ?? [];
    arr.push(b);
    byOwner.set(b.ownerCik, arr);
  }
  const minPer9 = d9(cfg.minPerInsiderUsd);
  const participants: ClusterParticipant[] = [];
  for (const [cik, arr] of byOwner) {
    const value9 = arr.reduce((a, b) => a + b.value9, 0n);
    if (value9 < minPer9) continue;
    const shares9 = arr.reduce((a, b) => a + b.shares9, 0n);
    const last = arr[arr.length - 1];
    // Conviction Δown%: bought ÷ held-before (sharesAfter − bought). Bought-from-zero (or missing
    // post balance ≤ bought) is max conviction → 1. Capped at 1 so one tiny prior holding can't
    // dominate the score.
    let deltaOwnFrac = 0;
    if (last.sharesAfter9 !== null) {
      const before = last.sharesAfter9 - shares9;
      deltaOwnFrac = before <= 0n ? 1 : Math.min(d9num(shares9) / d9num(before), 1);
    }
    participants.push({
      cik,
      name: last.ownerName,
      isOfficer: arr.some((b) => b.isOfficer),
      isDirector: arr.some((b) => b.isDirector),
      isTenPercentOwner: arr.some((b) => b.isTenPercentOwner),
      officerTitle: last.officerTitle,
      value9: d9str(value9),
      shares9: d9str(shares9),
      deltaOwnFrac,
      firstEver: history(cik).length === 0,
    });
  }

  if (participants.length < cfg.minInsiders) return empty(`insiders:${participants.length}<${cfg.minInsiders}`);
  const aggregate9 = participants.reduce((a, p) => a + d9(p.value9), 0n);
  if (aggregate9 < d9(cfg.minAggregateUsd)) return empty("aggregate-below-min");

  const officerCount = participants.filter((p) => p.isOfficer).length;
  const directorCount = participants.filter((p) => p.isDirector && !p.isOfficer).length;
  if (officerCount < cfg.roleGate.minOfficers && directorCount < cfg.roleGate.orMinDirectors)
    return empty("role-gate");
  const nonOwner = participants.filter((p) => !isPureOwnerEntity(p)).length;
  if (nonOwner < cfg.roleGate.minNonOwnerParticipants) return empty("pure-owner-entities");

  const partBuys = live.filter((b) => participants.some((p) => p.cik === b.ownerCik));
  const dates = partBuys.map((b) => b.tradeDate).sort();
  return {
    qualifies: true, failReason: null, participants, aggregate9,
    officerCount, directorCount,
    windowStart: dates[0], windowEnd: dates[dates.length - 1],
  };
}

/** Detect clusters across a stream of qualifying buys (already filtered to real P-buys by
 *  form4.classifyTxn). Rolling window: every distinct trade date is tried as a window END; buys
 *  within the trailing `windowDays` CALENDAR days (inclusive — day 10 in, day 11 out) are its
 *  members. Overlapping qualifying windows collapse to one cluster per episode (the widest, then
 *  richest, then EARLIEST-ending window — earliest so the signal fires as soon as it qualifies). */
export function detectClusters(buys: BuyEvent[], history: OwnerHistoryFn, cfg: ClusterCfg): Cluster[] {
  const bySymbol = new Map<string, BuyEvent[]>();
  for (const b of buys) {
    const arr = bySymbol.get(b.symbol) ?? [];
    arr.push(b);
    bySymbol.set(b.symbol, arr);
  }

  const out: Cluster[] = [];
  for (const [symbol, symBuys] of bySymbol) {
    const dates = [...new Set(symBuys.map((b) => b.tradeDate))].sort();
    const candidates: WindowEval[] = [];
    for (const end of dates) {
      const windowBuys = symBuys.filter((b) => {
        const diff = dayDiff(b.tradeDate, end);
        return diff >= 0 && diff <= cfg.windowDays - 1;
      });
      const ev = evaluateWindow(windowBuys, history, cfg);
      if (ev.qualifies) candidates.push(ev);
    }
    if (!candidates.length) continue;

    // Merge overlapping candidate windows into episodes; keep the best window per episode.
    candidates.sort((a, b) => (a.windowEnd < b.windowEnd ? -1 : 1));
    const episodes: WindowEval[][] = [];
    for (const c of candidates) {
      const cur = episodes[episodes.length - 1];
      if (cur && c.windowStart <= cur[cur.length - 1].windowEnd) cur.push(c);
      else episodes.push([c]);
    }
    for (const ep of episodes) {
      ep.sort((a, b) =>
        b.participants.length - a.participants.length
        || (a.aggregate9 === b.aggregate9 ? 0 : a.aggregate9 < b.aggregate9 ? 1 : -1)
        || (a.windowEnd < b.windowEnd ? -1 : 1));
      const best = ep[0];
      out.push({
        clusterId: `ins:${symbol}:${best.windowEnd}`,
        symbol,
        issuerCik: symBuys[0].issuerCik,
        windowStart: best.windowStart,
        windowEnd: best.windowEnd,
        participants: best.participants,
        aggregate9: best.aggregate9,
        officerCount: best.officerCount,
        directorCount: best.directorCount,
        score: scoreCluster(best.participants, best.aggregate9, cfg),
      });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}
