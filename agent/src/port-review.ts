// PORT — Post-close Combined-book Risk & correlation review (Senku-designed; John von Neumann's job).
// PURE, no I/O: treats the trading floor as ONE portfolio across Bill (positional) + Hakari (intraday,
// when present); Shiro's qualitative notes are folded in at the digest layer, not here. Given each
// trader's book of positions, it computes aggregate net long/short, single-name + sector concentration
// across the COMBINED book, cross-trader overlap (a name held by >1 desk = crowding), and combined
// drawdown vs a notional risk budget, then derives 0–3 deterministic rebalancing PROPOSALS.
//
// HARD RAIL: every proposal is advisory only and tagged 'CJ-approve-to-act'. This module NEVER places,
// sizes, or modifies an order, never touches the broker, never moves money. It is read-only over data the
// runner already loaded, which makes it trivially unit-testable (no network, no side effects).
const num = (v: unknown): number => { const x = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN; return Number.isFinite(x) ? x : 0; };
const r2 = (n: number) => Math.round(n * 100) / 100;
/** Percent of `part` over `whole`, rounded to 2dp. Returns 0 when `whole` is non-positive (no div-by-zero). */
const pct = (part: number, whole: number): number => (whole > 0 ? r2((part / whole) * 100) : 0);

export const UNKNOWN_SECTOR = "Unknown";

/** One position in a trader's book. marketValueUsd is SIGNED (Alpaca market_value: negative for shorts). */
export interface BookPosition {
  symbol: string;
  qty: number;                      // signed: + long, − short
  marketValueUsd: number;           // signed $ value of the position
  unrealizedPlPct?: number | null;
  sector?: string | null;           // optional; resolved via the sector map when absent
}

/** One trader's book. `present:false` means the source file was missing — recorded as a gap, never faked. */
export interface Book {
  trader: string;                   // "Bill" | "Hakari"
  present: boolean;
  equityUsd?: number | null;
  peakEquityUsd?: number | null;
  positions: BookPosition[];
}

export interface PortConfig {
  singleNameCapPct: number;         // single-name concentration cap (% of combined gross)
  sectorCapPct: number;             // sector concentration cap (% of combined gross)
  riskBudgetPct: number;            // combined drawdown budget as % of combined peak equity (notional)
  maxProposals: number;             // hard cap on proposals emitted
}

// Tuned conservative: no single name over a quarter of gross, no sector over 40%, a 15% combined-peak
// drawdown budget (mirrors alerts.ts' −15% drawdown alert), and at most 3 proposals per review.
export const DEFAULT_PORT_CONFIG: PortConfig = { singleNameCapPct: 25, sectorCapPct: 40, riskBudgetPct: 15, maxProposals: 3 };

export type SectorMap = Record<string, string>;
// Curated sector map for the large-caps Bill/Hakari are most likely to trade. Unmapped symbols bucket
// under "Unknown" and the gap is surfaced in the review notes — never guessed into a real sector.
export const DEFAULT_SECTORS: SectorMap = {
  AAPL: "Technology", MSFT: "Technology", NVDA: "Technology", AMD: "Technology", AVGO: "Technology",
  GOOGL: "Technology", GOOG: "Technology", META: "Technology", ORCL: "Technology", CRM: "Technology",
  ADBE: "Technology", INTC: "Technology", QCOM: "Technology", MU: "Technology", SMCI: "Technology",
  PLTR: "Technology", AMZN: "Consumer", TSLA: "Consumer", HD: "Consumer", NKE: "Consumer",
  MCD: "Consumer", SBUX: "Consumer", COST: "Consumer", WMT: "Consumer", JPM: "Financials",
  BAC: "Financials", GS: "Financials", MS: "Financials", V: "Financials", MA: "Financials",
  BRKB: "Financials", XOM: "Energy", CVX: "Energy", COP: "Energy", UNH: "Healthcare",
  JNJ: "Healthcare", LLY: "Healthcare", PFE: "Healthcare", MRK: "Healthcare", ABBV: "Healthcare",
  BA: "Industrials", CAT: "Industrials", GE: "Industrials", SPY: "Index/ETF", QQQ: "Index/ETF",
  IWM: "Index/ETF", DIA: "Index/ETF", VOO: "Index/ETF", XLK: "Index/ETF", VXUS: "Index/ETF",
};

const grossOf = (books: Book[]): number =>
  books.filter((b) => b.present).reduce((s, b) => s + b.positions.reduce((t, p) => t + Math.abs(num(p.marketValueUsd)), 0), 0);

// ── Exposure ────────────────────────────────────────────────────────────────────────────────────────
export interface Exposure {
  longUsd: number;
  shortUsd: number;
  grossUsd: number;
  netUsd: number;                   // long − short (signed: negative = net short)
  equityUsd: number;
  netPctEquity: number;             // signed net exposure as % of combined equity
  grossPctEquity: number;
  positions: number;                // total open positions across present books
}

/** Aggregate net long/short exposure across the combined book (present books only). */
export function aggregateExposure(books: Book[]): Exposure {
  let longUsd = 0, shortUsd = 0, equityUsd = 0, positions = 0;
  for (const b of books.filter((x) => x.present)) {
    equityUsd += num(b.equityUsd);
    for (const p of b.positions) {
      const v = num(p.marketValueUsd);
      if (v >= 0) longUsd += v; else shortUsd += -v;
      positions++;
    }
  }
  const grossUsd = longUsd + shortUsd;
  const netUsd = longUsd - shortUsd;
  return {
    longUsd: r2(longUsd), shortUsd: r2(shortUsd), grossUsd: r2(grossUsd), netUsd: r2(netUsd),
    equityUsd: r2(equityUsd), netPctEquity: pct(netUsd, equityUsd), grossPctEquity: pct(grossUsd, equityUsd), positions,
  };
}

// ── Single-name concentration ───────────────────────────────────────────────────────────────────────
export interface NameConc {
  symbol: string;
  marketValueUsd: number;           // combined |market value| of the name across all present books
  pctOfGross: number;
  traders: string[];                // which desks hold it (length > 1 ⇒ crowding)
}

/** Single-name concentration across the combined book, descending by combined market value. */
export function singleNameConcentration(books: Book[]): NameConc[] {
  const gross = grossOf(books);
  const map = new Map<string, { mv: number; traders: Set<string> }>();
  for (const b of books.filter((x) => x.present)) {
    for (const p of b.positions) {
      const sym = String(p.symbol ?? "?").toUpperCase();
      const e = map.get(sym) ?? { mv: 0, traders: new Set<string>() };
      e.mv += Math.abs(num(p.marketValueUsd));
      e.traders.add(b.trader);
      map.set(sym, e);
    }
  }
  return [...map.entries()]
    .map(([symbol, e]) => ({ symbol, marketValueUsd: r2(e.mv), pctOfGross: pct(e.mv, gross), traders: [...e.traders].sort() }))
    .sort((a, b) => b.marketValueUsd - a.marketValueUsd);
}

// ── Sector concentration ────────────────────────────────────────────────────────────────────────────
export interface SectorConc { sector: string; marketValueUsd: number; pctOfGross: number }

/** Sector concentration across the combined book. A position's own `sector` wins; else the map; else "Unknown". */
export function sectorConcentration(books: Book[], sectors: SectorMap = DEFAULT_SECTORS): SectorConc[] {
  const gross = grossOf(books);
  const map = new Map<string, number>();
  for (const b of books.filter((x) => x.present)) {
    for (const p of b.positions) {
      const sym = String(p.symbol ?? "?").toUpperCase();
      const sector = (p.sector && String(p.sector).trim()) || sectors[sym] || UNKNOWN_SECTOR;
      map.set(sector, (map.get(sector) ?? 0) + Math.abs(num(p.marketValueUsd)));
    }
  }
  return [...map.entries()]
    .map(([sector, mv]) => ({ sector, marketValueUsd: r2(mv), pctOfGross: pct(mv, gross) }))
    .sort((a, b) => b.marketValueUsd - a.marketValueUsd);
}

// ── Cross-trader overlap (crowding) ───────────────────────────────────────────────────────────────────
export interface Crowding { symbol: string; traders: string[]; combinedUsd: number; pctOfGross: number }

/** Names held by more than one present desk — the same risk taken twice. Empty in a single-book review. */
export function crossTraderOverlap(books: Book[]): Crowding[] {
  return singleNameConcentration(books)
    .filter((n) => n.traders.length >= 2)
    .map((n) => ({ symbol: n.symbol, traders: n.traders, combinedUsd: n.marketValueUsd, pctOfGross: n.pctOfGross }));
}

// ── Combined drawdown vs notional risk budget ────────────────────────────────────────────────────────
export interface DrawdownView {
  combinedEquityUsd: number;
  combinedPeakUsd: number;
  drawdownUsd: number;              // peak − current, floored at 0
  drawdownPct: number;              // drawdown as % of combined peak
  budgetUsd: number;                // notional risk budget (riskBudgetPct of combined peak)
  budgetUsedPct: number;            // drawdown as % of the budget
  overBudget: boolean;
}

/** Combined drawdown across present books, measured against a notional risk budget. */
export function combinedDrawdown(books: Book[], cfg: PortConfig = DEFAULT_PORT_CONFIG): DrawdownView {
  let equity = 0, peak = 0;
  for (const b of books.filter((x) => x.present)) {
    const e = num(b.equityUsd);
    equity += e;
    peak += Math.max(num(b.peakEquityUsd), e);   // peak can never be below the current mark
  }
  const drawdownUsd = Math.max(0, peak - equity);
  const budgetUsd = r2((cfg.riskBudgetPct / 100) * peak);
  return {
    combinedEquityUsd: r2(equity), combinedPeakUsd: r2(peak),
    drawdownUsd: r2(drawdownUsd), drawdownPct: pct(drawdownUsd, peak),
    budgetUsd, budgetUsedPct: pct(drawdownUsd, budgetUsd), overBudget: budgetUsd > 0 && drawdownUsd > budgetUsd,
  };
}

// ── Proposals ─────────────────────────────────────────────────────────────────────────────────────────
export const APPROVE_TAG = "CJ-approve-to-act" as const;
export interface Proposal {
  kind: "drawdown" | "single-name" | "sector" | "crowding";
  severity: number;                 // higher = more urgent; used to rank then cap
  title: string;
  detail: string;
  tag: typeof APPROVE_TAG;          // every proposal is propose-only — CJ must approve to act
}

/** Derive 0–maxProposals deterministic rebalancing proposals from a computed review, ranked by severity. */
export function buildProposals(review: PortReview, cfg: PortConfig = DEFAULT_PORT_CONFIG): Proposal[] {
  const out: Proposal[] = [];
  const trimmed = new Set<string>();                // symbols already flagged for a trim (de-dupe crowding)

  // Drawdown over budget ranks above everything — capital preservation first.
  if (review.drawdown.overBudget) {
    out.push({
      kind: "drawdown", severity: 100 + review.drawdown.budgetUsedPct, title: "De-risk — drawdown over budget",
      detail: `Combined drawdown $${review.drawdown.drawdownUsd} is ${review.drawdown.budgetUsedPct}% of the $${review.drawdown.budgetUsd} risk budget. Trim gross exposure until back within budget.`,
      tag: APPROVE_TAG,
    });
  }
  // Single-name concentration over cap.
  for (const n of review.singleName) {
    if (n.pctOfGross <= cfg.singleNameCapPct) continue;
    trimmed.add(n.symbol);
    out.push({
      kind: "single-name", severity: n.pctOfGross, title: `Trim ${n.symbol}`,
      detail: `${n.symbol} is ${n.pctOfGross}% of combined gross (cap ${cfg.singleNameCapPct}%)${n.traders.length > 1 ? `, held by ${n.traders.join(" + ")}` : ""}. Reduce to restore single-name diversification.`,
      tag: APPROVE_TAG,
    });
  }
  // Sector concentration over cap (skip the "Unknown" bucket — it isn't a real sector).
  for (const s of review.sector) {
    if (s.sector === UNKNOWN_SECTOR || s.pctOfGross <= cfg.sectorCapPct) continue;
    out.push({
      kind: "sector", severity: s.pctOfGross - 0.5, title: `Reduce ${s.sector} exposure`,
      detail: `${s.sector} is ${s.pctOfGross}% of combined gross (cap ${cfg.sectorCapPct}%). Rotate into less-correlated sectors.`,
      tag: APPROVE_TAG,
    });
  }
  // Cross-trader crowding — only if the name isn't already flagged for a single-name trim.
  for (const c of review.crowding) {
    if (trimmed.has(c.symbol)) continue;
    out.push({
      kind: "crowding", severity: c.pctOfGross, title: `Crowding in ${c.symbol}`,
      detail: `${c.symbol} is held by ${c.traders.join(" + ")} (combined ${c.pctOfGross}% of gross). Two desks long the same name doubles single-name risk — consider de-duplicating.`,
      tag: APPROVE_TAG,
    });
  }
  return out.sort((a, b) => b.severity - a.severity).slice(0, cfg.maxProposals);
}

// ── Top-level review ──────────────────────────────────────────────────────────────────────────────────
export interface PortReview {
  booksReviewed: string[];          // present traders
  booksMissing: string[];           // absent traders (a gap — never fabricated)
  exposure: Exposure;
  singleName: NameConc[];
  sector: SectorConc[];
  crowding: Crowding[];
  drawdown: DrawdownView;
  proposals: Proposal[];
  notes: string[];                  // human-readable degradation / context notes
}

/**
 * Run the full combined-book review. Pure — the runner passes already-loaded books. Degrades gracefully:
 * missing books are reported as a gap (never estimated); a single present book is reviewed and labelled
 * as such (cross-trader crowding is not assessable with one desk).
 */
export function portReview(books: Book[], cfg: PortConfig = DEFAULT_PORT_CONFIG, sectors: SectorMap = DEFAULT_SECTORS): PortReview {
  const present = books.filter((b) => b.present);
  const missing = books.filter((b) => !b.present).map((b) => b.trader);
  const sector = sectorConcentration(books, sectors);
  const notes: string[] = [];

  if (present.length === 0) notes.push("No books found — nothing to review.");
  else if (present.length === 1) notes.push(`Single-book review (${present[0].trader} only) — cross-trader crowding not assessable.`);
  if (missing.length) notes.push(`Book(s) not present: ${missing.join(", ")} — reported as a gap, not estimated.`);
  if (sector.some((s) => s.sector === UNKNOWN_SECTOR)) notes.push(`Some symbols are unmapped to a sector (bucketed "${UNKNOWN_SECTOR}").`);

  const review: PortReview = {
    booksReviewed: present.map((b) => b.trader),
    booksMissing: missing,
    exposure: aggregateExposure(books),
    singleName: singleNameConcentration(books),
    sector,
    crowding: crossTraderOverlap(books),
    drawdown: combinedDrawdown(books, cfg),
    proposals: [],
    notes,
  };
  review.proposals = buildProposals(review, cfg);
  return review;
}
