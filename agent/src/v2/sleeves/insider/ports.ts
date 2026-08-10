// Bull v2 insider sleeve — ports (design §3). EVERY network source sits behind an interface so the
// whole sleeve tests offline against fixtures: EDGAR (filings), the market data host (bars/quotes),
// the trading host (asset metadata), and whatever eventually supplies sectors. The live adapters
// live in edgar.ts / market.ts; nothing else in this sleeve may call fetch().
//
// Why symbol+cik on getMarketCap9: there is no free "market cap by ticker" endpoint in our stack.
// The honest computable path is EDGAR companyfacts shares-outstanding (keyed by CIK — which every
// Form 4 hands us) × latest price. Callers that lack a CIK get null, and null FAILS the liquidity
// floor (fail-closed: an unverifiable $75M floor is a failed floor, not a waived one).
import type { D9 } from "../../decimal.js";

/** EDGAR read surface. All methods return RAW text — parsing is pure code (form4.ts / ingest.ts),
 *  so fixtures exercise the exact same path as production bytes. */
export interface EdgarPort {
  /** Atom feed of just-disseminated Form 4s (cgi-bin/browse-edgar?action=getcurrent&type=4). */
  getCurrentForm4Atom(): Promise<string>;
  /** Daily form index (form.YYYYMMDD.idx) for the nightly reconciliation pass. date = YYYY-MM-DD. */
  getDailyIndex(date: string): Promise<string>;
  /** The Form 4 XML (or full-submission .txt — the parser handles both) for one accession. */
  getFiling(accession: string, cik: string): Promise<string>;
  /** dei:EntityCommonStockSharesOutstanding via companyfacts — feeds the market-cap floor. */
  getSharesOutstanding?(cik: string): Promise<D9 | null>;
}

export interface DailyBar {
  date: string;    // YYYY-MM-DD (session date)
  close9: D9;
  volume9: D9;     // shares
}

export interface Quote {
  bid9: D9;
  ask9: D9;
}

export interface AssetInfo {
  fractionable: boolean;
  exchange: string | null;  // Alpaca exchange code; "OTC" fails the exchange-listed gate
  tradable: boolean;
}

/** Market data + asset metadata. The spread gate NEEDS a real bid/ask (not a last trade) — that is
 *  the whole point of gating at decision AND at open — so getQuote is its own method. */
export interface MarketPort {
  /** Most-recent daily bars, ascending, at least `lookbackDays` calendar days back. */
  getDailyBars(symbol: string, lookbackDays: number): Promise<DailyBar[]>;
  getQuote(symbol: string): Promise<Quote | null>;
  /** USD market cap (d9). null = unknown → liquidity floor fails closed. */
  getMarketCap9(symbol: string, cik?: string): Promise<D9 | null>;
  getAsset(symbol: string): Promise<AssetInfo | null>;
}

/** Sector lookup for the ≤2-same-sector cap. No free live source in our stack yet (Phase 4/5 must
 *  supply one); tests fixture-feed it. null = unknown → the cap can't count it (see planner.ts). */
export interface SectorPort {
  getSector(symbol: string): Promise<string | null>;
}

/** Daily closes for CAR math (shadow book vs IWM). Separate from MarketPort so backtests can feed
 *  a pure fixture without dragging quote/asset stubs along. */
export interface PricePort {
  /** Ascending {date, close9} covering [startDate, endDate]. */
  getCloses(symbol: string, startDate: string, endDate: string): Promise<{ date: string; close9: D9 }[]>;
}
