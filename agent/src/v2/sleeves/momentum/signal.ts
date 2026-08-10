// Bull v2 — momentum signal core (design §2). PURE functions over plain data — no DB, no network,
// no clock — so every ranking decision is deterministic and unit-testable to the tiebreak. Pipeline:
//
//   12-1 total return (dividend-adjusted month-end closes) → deterministic sort
//   → top 50 → quality vetoes (EDGAR fundamentals; MISSING = VETO)
//   → re-rank survivors by Frog-in-the-Pan smoothness → hold top-N (equity-indexed schedule)
//   → hold-band target selection (buy from top `buyFromTop`, sell only below rank `sellBelowRank`)
//
// Determinism is a hard requirement: two runs over the same inputs MUST produce the same book, or a
// replay/backtest can't reproduce a live month. Every sort has a total order (score DESC →
// dollar-volume DESC → symbol ASC; FIP ASC → score DESC → symbol ASC) — no Array.sort ties left to
// engine whim. Scores/ratios are plain numbers (analytics); money enters in planner.ts as d9.
import { scheduleLookup } from "../../config.js";
import type { Fundamentals, MomentumConfig } from "./ports.js";

export interface SignalInput {
  symbol: string;
  closes: number[];              // ascending ADJUSTED month-end closes; latest = signal month-end
  dollarVolume: number;          // formation-window avg daily close×volume (tiebreak only)
  pctPosDays: number;            // fraction of formation-window daily returns > 0
  pctNegDays: number;            // fraction < 0 (zeros count in neither)
  fundamentals: Fundamentals | null;  // null = EDGAR gave us nothing → veto
  sector: string;                // GICS sector
}

export interface ScoredSymbol extends SignalInput {
  score: number;                 // 12-1 total return
  momRank: number;               // 1-based rank inside the momentum top-50
}

export interface RankedSymbol extends ScoredSymbol {
  fip: number;
  finalRank: number;             // 1-based FIP-smoothness rank among veto survivors
}

export type VetoReason = "missing-fundamentals" | "unprofitable" | "accruals" | "leverage";

export interface RankResult {
  top: ScoredSymbol[];                              // momentum top-50, pre-veto, in mom-rank order
  vetoed: { symbol: string; reason: VetoReason }[];
  final: RankedSymbol[];                            // FIP-reranked survivors, in final-rank order
}

/** 12-1 total return from ascending month-end ADJUSTED closes: skip the most recent `skip` months,
 *  measure over the prior `lookback`: closes[L−1−skip] / closes[L−1−lookback] − 1. With the classic
 *  12/1 that is P(t−1)/P(t−12) − 1 and needs 13 closes — which is exactly why the universe demands
 *  ≥13 month-end closes of history. Dividend adjustment is upstream (adjustment=all bars). */
export function return12x1(closes: number[], lookback: number, skip: number): number {
  if (skip >= lookback) throw new Error(`return12x1: skip ${skip} must be < lookback ${lookback}`);
  const L = closes.length;
  if (L < lookback + 1) throw new Error(`return12x1: need ${lookback + 1} closes, got ${L}`);
  const start = closes[L - 1 - lookback];
  const end = closes[L - 1 - skip];
  if (!(start > 0)) throw new Error("return12x1: non-positive base close");
  return end / start - 1;
}

/** Frog-in-the-Pan information discreteness: sign(score) × (%neg − %pos). More NEGATIVE = smoother
 *  (a winner that ground up on many small green days, or a loser that bled steadily) — and smooth
 *  momentum persists (Da/Gurun/Warachka), so the final rank sorts FIP ASCENDING. */
export function fipScore(score: number, pctPosDays: number, pctNegDays: number): number {
  const sign = score > 0 ? 1 : score < 0 ? -1 : 0;
  return sign * (pctNegDays - pctPosDays);
}

/** Quality veto for one name (design §2). Missing fundamentals ALWAYS veto — a company EDGAR can't
 *  explain doesn't get momentum money. The debt check is skipped for Financials/Real Estate (their
 *  balance sheets make Debt/Assets meaningless), including when their debt fields are missing. */
export function vetoReason(f: Fundamentals | null, sector: string, cfg: MomentumConfig): VetoReason | null {
  if (!f) return "missing-fundamentals";
  if (f.gpOverAssets == null || f.ttmOpIncome == null) return "missing-fundamentals";
  if (f.gpOverAssets <= 0 && f.ttmOpIncome < 0) return "unprofitable";       // veto 1: GP/A ≤ 0 AND TTM op income < 0
  if (f.accruals == null) return "missing-fundamentals";
  if (f.accruals > cfg.vetoes.accrualsMax) return "accruals";                // veto 2: (NI−CFO)/Assets > +0.10
  if (!isFinancialOrReit(sector)) {
    if (f.debtOverAssets == null) return "missing-fundamentals";
    if (f.debtOverAssets > cfg.vetoes.debtAssetsMax) return "leverage";      // veto 3: Debt/Assets > 0.70
  }
  return null;
}

export function isFinancialOrReit(sector: string): boolean {
  const s = sector.trim().toLowerCase();
  return s === "financials" || s === "real estate";
}

/** Full ranking pipeline: score → deterministic sort → top-K → vetoes → FIP re-rank. */
export function computeRanks(inputs: SignalInput[], cfg: MomentumConfig): RankResult {
  const { lookbackMonths, skipMonths, top } = cfg.signal;

  // Score everything with enough history (universe already filtered ≥13; re-check as defense).
  const scored = inputs
    .filter((i) => i.closes.length >= lookbackMonths + 1)
    .map((i) => ({ ...i, score: return12x1(i.closes, lookbackMonths, skipMonths) }));

  // Deterministic momentum order: score DESC → dollar-volume DESC → symbol ASC.
  scored.sort((a, b) =>
    a.score !== b.score ? b.score - a.score
    : a.dollarVolume !== b.dollarVolume ? b.dollarVolume - a.dollarVolume
    : a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0);

  const topK: ScoredSymbol[] = scored.slice(0, top).map((s, i) => ({ ...s, momRank: i + 1 }));

  const vetoed: { symbol: string; reason: VetoReason }[] = [];
  const survivors: ScoredSymbol[] = [];
  for (const s of topK) {
    const reason = vetoReason(s.fundamentals, s.sector, cfg);
    if (reason) vetoed.push({ symbol: s.symbol, reason });
    else survivors.push(s);
  }

  // FIP re-rank: smoothest (most negative FIP) first; ties broken score DESC → symbol ASC.
  const withFip = survivors.map((s) => ({ ...s, fip: fipScore(s.score, s.pctPosDays, s.pctNegDays) }));
  withFip.sort((a, b) =>
    a.fip !== b.fip ? a.fip - b.fip
    : a.score !== b.score ? b.score - a.score
    : a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0);
  const final: RankedSymbol[] = withFip.map((s, i) => ({ ...s, finalRank: i + 1 }));

  return { top: topK, vetoed, final };
}

/** Equity-indexed N: sleeve <$4k→10, $4–8k→15, $8–20k→20, >$20k→50 — all from the config schedule
 *  (growth needs no code change or amendment; the schedule is read against live equity). */
export function nFor(cfg: MomentumConfig, sleeveUsd: number): number {
  return scheduleLookup(cfg.holdings.nSchedule, sleeveUsd).n;
}

export interface TargetSelection {
  keeps: string[];     // held AND still inside the hold band (final rank ≤ sellBelowRank)
  sells: string[];     // held AND ranked out (rank > sellBelowRank, or gone from the survivor list)
  buys: string[];      // NOT held, final rank ≤ buyFromTop, filling open slots in rank order
  targets: string[];   // keeps ∪ buys
}

/** Hold-band selection (design §2): buy only from the top `buyFromTop`, sell a holding only once it
 *  falls below rank `sellBelowRank` — the asymmetry ≈ halves turnover vs a strict top-N rebalance.
 *  Exits are RANK-OUT ONLY (no per-name stops; the book brake owns disasters). A holding that got
 *  vetoed or dropped out of the top-50 has no rank at all → same rank-out exit path. If keeps
 *  already fill N, no buys happen; if the top-`buyFromTop` non-held pool is smaller than the open
 *  slots, the book runs short and cash waits for next month (the band exists to cut churn). */
export function selectTargets(
  finalRanked: string[],          // survivor symbols in final-rank order (index 0 = rank 1)
  held: string[],
  n: number,
  buyFromTop: number,
  sellBelowRank: number,
): TargetSelection {
  const rank = new Map<string, number>();
  finalRanked.forEach((s, i) => rank.set(s, i + 1));

  const keeps: string[] = [];
  const sells: string[] = [];
  for (const h of held) {
    const r = rank.get(h);
    if (r != null && r <= sellBelowRank) keeps.push(h);
    else sells.push(h);
  }

  const slots = Math.max(0, n - keeps.length);
  const heldSet = new Set(held);
  const buys: string[] = [];
  for (const s of finalRanked) {
    if (buys.length >= slots) break;
    const r = rank.get(s)!;
    if (r > buyFromTop) break;                  // never chase past the buy band
    if (!heldSet.has(s)) buys.push(s);
  }

  return { keeps, sells, buys, targets: [...keeps, ...buys] };
}

// ---------------------------------------------------------------------------
// Local vol brake helpers (design §2: 20-day sleeve vol > 2× SPY → defer adds).
// ---------------------------------------------------------------------------

/** Simple daily returns from an ascending close series. */
export function dailyReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) if (closes[i - 1] > 0) out.push(closes[i] / closes[i - 1] - 1);
  return out;
}

/** Population stdev of the LAST `window` returns (default 20). <5 observations → 0 (unknown vol
 *  must not randomly slam the brake; the caller treats 0 as "no signal"). */
export function vol20d(returns: number[], window = 20): number {
  const tail = returns.slice(-window);
  if (tail.length < 5) return 0;
  const mean = tail.reduce((a, b) => a + b, 0) / tail.length;
  const varr = tail.reduce((a, b) => a + (b - mean) * (b - mean), 0) / tail.length;
  return Math.sqrt(varr);
}

/** Equal-weight portfolio daily returns from per-holding close series. Series are aligned from the
 *  TAIL (same trading days assumed — all US equities off the same calendar). */
export function equalWeightPortfolioReturns(closesBySymbol: number[][]): number[] {
  const rets = closesBySymbol.map(dailyReturns).filter((r) => r.length > 0);
  if (!rets.length) return [];
  const len = Math.min(...rets.map((r) => r.length));
  const out: number[] = [];
  for (let i = 0; i < len; i++) {
    let sum = 0;
    for (const r of rets) sum += r[r.length - len + i];
    out.push(sum / rets.length);
  }
  return out;
}

/** True when 20-day sleeve vol exceeds `maxRatio` × SPY's — the one local brake this sleeve has.
 *  No sleeve-level vol-scaling anywhere else by design. Unknown vol on either side → inactive. */
export function volBrakeActive(sleeveRets: number[], spyRets: number[], maxRatio: number): boolean {
  const sv = vol20d(sleeveRets);
  const bv = vol20d(spyRets);
  if (sv === 0 || bv === 0) return false;
  return sv > maxRatio * bv;
}
