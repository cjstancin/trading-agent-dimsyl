// Bull v2 — momentum sleeve ports (design §2). Every network source sits behind an interface so the
// ENTIRE sleeve is testable offline with injected fixtures: the pure signal core never fetches, and
// the real adapters (wikipedia.ts, alpaca-ports.ts, edgar.ts) are thin translations from wire shape
// to these plain-data types. Prices here are plain numbers, not d9 — signal math is analytics
// (ranks, ratios), not ledger money; d9 discipline starts where notionals are sized (planner.ts).
export interface WikiConstituent {
  symbol: string;              // as listed (e.g. "BRK.B") — matches Alpaca's dot convention
  security: string;
  sector: string;              // GICS sector — the debt veto skips Financials / Real Estate
  cik: string | null;          // 10-digit zero-padded when the list page carries it (S&P 500 does)
  list: "sp500" | "sp400";
}

/** Wikipedia constituent lists — the S&P 500 + S&P 400 pages, merged. MUST throw on a scrape that
 *  yields nothing: a silently-empty universe would liquidate the whole book next rebalance. */
export interface UniversePort {
  fetchConstituents(): Promise<WikiConstituent[]>;
}

export interface AssetInfo {
  tradable: boolean;
  fractionable: boolean;
}

/** Alpaca active US-equity assets (symbol → flags). Universe keeps active ∩ tradable ∩ fractionable. */
export interface AssetsPort {
  fetchActiveAssets(): Promise<Map<string, AssetInfo>>;
}

export interface MonthClose {
  month: string;               // "YYYY-MM"
  close: number;               // dividend-adjusted month-end close (adjustment=all)
}

export interface DailyBar {
  date: string;                // "YYYY-MM-DD"
  close: number;               // adjusted close
  volume: number;
}

/** Market data (Alpaca data host, adjustment=all & feed=sip). Month bars feed the 12-1 signal;
 *  daily bars feed FIP %pos/%neg, the dollar-volume tiebreak, and the 20-day vol brake. */
export interface PricePort {
  monthEndCloses(symbol: string, months: number): Promise<MonthClose[]>;  // ascending
  dailyBars(symbol: string, start: string, end: string): Promise<DailyBar[]>;  // ascending, [start, end)
}

/** EDGAR: ticker→CIK resolution (SEC company_tickers.json) + companyfacts JSON per CIK. */
export interface FundamentalsPort {
  cikFor(symbol: string): Promise<string | null>;
  companyfacts(cik: string): Promise<unknown | null>;
}

/** Extracted fundamentals for the quality vetoes. null field = the tag chains found nothing —
 *  and per the design contract, MISSING FUNDAMENTALS = VETO (no benefit of the doubt). */
export interface Fundamentals {
  gpOverAssets: number | null;   // gross profit (TTM) / total assets
  ttmOpIncome: number | null;    // operating income, trailing four quarters
  accruals: number | null;       // (NI − CFO) TTM / total assets
  debtOverAssets: number | null; // total debt / total assets
}

/** The committed config shape under "momentum" in config/v2.defaults.json — read via loadConfig();
 *  no number that lives there is ever hardcoded in this sleeve. */
export interface MomentumConfig {
  universe: { sp500: boolean; sp400: boolean; minMonthEndCloses: number; universeDeltaAlertPct: number };
  signal: { lookbackMonths: number; skipMonths: number; top: number };
  vetoes: { accrualsMax: number; debtAssetsMax: number };
  holdings: {
    nSchedule: { sleeveUsdBelow: number | null; n: number }[];
    weightBandRel: number;
    minOrderUsd: number;
  };
  rebalance: { buyFromTop: number; sellBelowRank: number; windowEt: [string, string] };
  localBrake: { vol20dVsSpyMax: number };
  slippageBpsPerSide: number;
  sellFeeUsd: number;
  shadowN: number;
}

/** Shift a "YYYY-MM" month key by delta months. Pure, no Date-object timezone traps. */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const idx = y * 12 + (m - 1) + delta;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  return `${ny}-${String(nm).padStart(2, "0")}`;
}
