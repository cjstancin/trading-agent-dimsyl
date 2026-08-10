// Bull v2 — Wildcard fixture adapters. Deterministic, offline, no env — the test file's (and any
// dry-run's) implementations of the three ports plus a bar generator. Fixtures live in the sleeve
// (not the test file) so a future replay harness and the Phase-3 integration smoke test reuse the
// SAME canned world instead of forking their own.
import type {
  AnchorPoolRow, Bar, CardPort, ContextCard, FundamentalsSnapshot, InsiderPoolRow,
  MomentumPoolRow, NewsClaim, PickPort, PoolPort, PricePath,
} from "./types.js";

// ---------------------------------------------------------------------------
// PoolPort fixture — 25 momentum names, 2 insider clusters (one live, one
// shadow), 3 anchor names. "AAPL" appears in momentum AND anchor, "INSA" in
// momentum AND insider — the dedupe/merge cases.
// ---------------------------------------------------------------------------

export const FIXTURE_MOM: MomentumPoolRow[] = [
  { symbol: "AAPL", rank: 1 }, { symbol: "MSFT", rank: 2 }, { symbol: "NVDA", rank: 3 },
  { symbol: "INSA", rank: 4 }, { symbol: "AVGO", rank: 5 }, { symbol: "LLY", rank: 6 },
  { symbol: "V", rank: 7 }, { symbol: "MA", rank: 8 }, { symbol: "COST", rank: 9 },
  { symbol: "WMT", rank: 10 }, { symbol: "ORCL", rank: 11 }, { symbol: "GE", rank: 12 },
  { symbol: "CAT", rank: 13 }, { symbol: "AMAT", rank: 14 }, { symbol: "ADBE", rank: 15 },
  { symbol: "NOW", rank: 16 }, { symbol: "ISRG", rank: 17 }, { symbol: "UBER", rank: 18 },
  { symbol: "PGR", rank: 19 }, { symbol: "KLAC", rank: 20 }, { symbol: "SNPS", rank: 21 },
  { symbol: "CDNS", rank: 22 }, { symbol: "MELI", rank: 23 }, { symbol: "PANW", rank: 24 },
  { symbol: "CRWD", rank: 25 },
];
export const FIXTURE_INS: InsiderPoolRow[] = [
  { symbol: "INSA", live: true },     // funded cluster, ALSO momentum rank 4 → merged flags
  { symbol: "SHDW", live: false },    // shadow-book signal, pool-eligible by design
];
export const FIXTURE_ANC: AnchorPoolRow[] = [
  { symbol: "AAPL", managers: ["Berkshire Hathaway"] },   // dup with momentum rank 1 → merged
  { symbol: "OXY", managers: ["Berkshire Hathaway"] },
  { symbol: "GOOGL", managers: ["TCI Fund Management", "AltaRock Partners"] },
];

export function fixturePoolPort(overrides: Partial<{
  mom: MomentumPoolRow[]; ins: InsiderPoolRow[]; anc: AnchorPoolRow[];
}> = {}): PoolPort {
  return {
    async momentumTop(n) { return (overrides.mom ?? FIXTURE_MOM).slice(0, n); },
    async insiderLiveClusters() { return overrides.ins ?? FIXTURE_INS; },
    async anchorTop5s() { return overrides.anc ?? FIXTURE_ANC; },
  };
}

// ---------------------------------------------------------------------------
// CardPort fixture — 10-field fundamentals, 5 dated claims, price-path
// numbers. `claimChars` inflates each claim body to force budget truncation.
// ---------------------------------------------------------------------------

export function fixtureCardPort(opts: { claimChars?: number; claims?: number } = {}): CardPort {
  const pad = (s: string) => opts.claimChars ? (s + " " + "x".repeat(opts.claimChars)).slice(0, opts.claimChars) : s;
  return {
    async fundamentals(symbol): Promise<FundamentalsSnapshot> {
      return {
        asOf: "2026-08-14",
        fields: {
          mktCapB: 120.5, peTtm: 24.1, revenueTtmB: 38.2, revenueGrowthPct: 14.2,
          grossMarginPct: 61.0, opMarginPct: 27.5, fcfTtmB: 9.1, netDebtB: -2.4,
          sharesOutB: 1.61, sector: `${symbol}-sector`,
        },
      };
    },
    async newsClaims(symbol): Promise<NewsClaim[]> {
      const n = opts.claims ?? 5;
      const all: NewsClaim[] = [
        { date: "2026-08-12", source: "reuters", tickers: [symbol], claim: pad(`${symbol} raised full-year revenue guidance`), number: "+4%" },
        { date: "2026-08-05", source: "edgar", tickers: [symbol], claim: pad(`${symbol} 10-Q filed; inventory days fell`), number: 61 },
        { date: "2026-07-29", source: "bloomberg", tickers: [symbol], claim: pad(`${symbol} announced expanded buyback`), number: "2B" },
        { date: "2026-07-15", source: "wsj", tickers: [symbol], claim: pad(`${symbol} named new CFO from inside the finance org`) },
        { date: "2026-07-01", source: "reuters", tickers: [symbol], claim: pad(`${symbol} supplier reported record orders`), number: "12%" },
      ];
      return all.slice(0, n);
    },
    async pricePath(): Promise<PricePath> {
      return {
        asOf: "2026-08-14", last: 100, chg1wPct: 1.2, chg1mPct: 4.8, chg3mPct: 11.5,
        high52w: 112, low52w: 61, atr14: 2.2,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// PickPort fixture — canned responses, FIFO. Captures every card set it was
// shown so tests can assert held names were excluded ("not re-litigated").
// ---------------------------------------------------------------------------

export interface FixturePickPort extends PickPort {
  seen: ContextCard[][];
}

export function fixturePickPort(queue: unknown[]): FixturePickPort {
  const q = [...queue];
  const seen: ContextCard[][] = [];
  return {
    seen,
    async rankPool(cards) {
      seen.push(cards);
      if (!q.length) throw new Error("fixturePickPort: response queue empty");
      return q.shift();
    },
  };
}

/** A schema-valid pick object (spread-override to break one field per test case). */
export function validPick(ticker: string, rank: number, over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    ticker, rank,
    conviction_bucket: "high",
    thesis: "Guidance raised on real demand. Margins are expanding.",
    invalidation_level: 80,
    holding_period: "months",
    what_would_change_my_mind: "Two consecutive quarters of decelerating revenue growth.",
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Bars fixture — deterministic daily bars for the ATR engine. Constant range
// and zero gap ⇒ TR = `range` for every bar ⇒ ATR = `range` exactly, which
// makes stop levels hand-checkable in tests.
// ---------------------------------------------------------------------------

export function fixtureBars(n: number, opts: { close?: number; range?: number; driftPerBar?: number } = {}): Bar[] {
  const range = opts.range ?? 2;
  const drift = opts.driftPerBar ?? 0;
  const out: Bar[] = [];
  let c = opts.close ?? 100;
  for (let i = 0; i < n; i++) {
    const day = new Date(Date.UTC(2026, 5, 1) + i * 86_400_000).toISOString().slice(0, 10);
    // h/l straddle the close so consecutive-close gaps never exceed the bar range (keeps TR = range).
    out.push({ t: day + "T04:00:00Z", o: c, h: c + range / 2, l: c - range / 2, c, v: 1_000_000 });
    c += drift;
  }
  return out;
}
