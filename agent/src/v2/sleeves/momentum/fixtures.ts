// Bull v2 — momentum OFFLINE fixtures. Everything the test suite injects instead of the network:
// synthetic close series, a scraped-page HTML sample shaped like Wikipedia's constituents table, a
// companyfacts builder that emits the exact JSON geometry data.sec.gov serves, and in-memory port
// implementations. Test-only by convention — no production path imports this file.
import type {
  AssetInfo, AssetsPort, DailyBar, Fundamentals, FundamentalsPort, MonthClose, PricePort,
  UniversePort, WikiConstituent,
} from "./ports.js";
import { shiftMonth } from "./ports.js";

// ---------------------------------------------------------------------------
// Close-series builders.
// ---------------------------------------------------------------------------

/** Month-end closes ascending, ending at `endMonth`: closes[0] = start, then × (1+ret) each month. */
export function makeMonthCloses(endMonth: string, start: number, monthlyRets: number[]): MonthClose[] {
  const out: MonthClose[] = [];
  let px = start;
  const first = shiftMonth(endMonth, -monthlyRets.length);
  out.push({ month: first, close: px });
  for (let i = 0; i < monthlyRets.length; i++) {
    px *= 1 + monthlyRets[i];
    out.push({ month: shiftMonth(first, i + 1), close: px });
  }
  return out;
}

/** Flat-volume daily bars from a close path (dates are synthetic but ascending). */
export function makeDailyBars(closes: number[], volume = 1_000_000): DailyBar[] {
  return closes.map((c, i) => ({
    date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
    close: c,
    volume,
  }));
}

// ---------------------------------------------------------------------------
// Wikipedia HTML sample — same skeleton as the live pages (id="constituents",
// header-labeled columns, symbols wrapped in anchors, CIK column present).
// ---------------------------------------------------------------------------
export const WIKI_SP500_SAMPLE_HTML = `
<html><body>
<table class="wikitable" id="other-table"><tr><th>Nope</th></tr><tr><td>decoy</td></tr></table>
<table class="wikitable sortable" id="constituents">
<tbody>
<tr><th>Symbol</th><th>Security</th><th>GICS Sector</th><th>GICS Sub-Industry</th><th>Headquarters Location</th><th>Date added</th><th>CIK</th><th>Founded</th></tr>
<tr><td><a href="/wiki/MMM">MMM</a></td><td>3M</td><td>Industrials</td><td>Industrial Conglomerates</td><td>Saint Paul, Minnesota</td><td>1957-03-04</td><td>0000066740</td><td>1902</td></tr>
<tr><td><a href="/wiki/AOS">AOS</a></td><td>A. O. Smith</td><td>Industrials</td><td>Building Products</td><td>Milwaukee, Wisconsin</td><td>2017-07-26</td><td>0000091142</td><td>1916</td></tr>
<tr><td><a href="/wiki/BRK.B">BRK.B</a></td><td>Berkshire Hathaway</td><td>Financials</td><td>Multi-Sector Holdings</td><td>Omaha, Nebraska</td><td>2010-02-16</td><td>1067983</td><td>1839</td></tr>
</tbody>
</table>
</body></html>`;

// ---------------------------------------------------------------------------
// companyfacts builder — emits the {facts: {"us-gaap": {Tag: {units: {USD: [...]}}}}} geometry.
// ---------------------------------------------------------------------------
export interface FactsSpec {
  /** flow tags: four quarterly values (oldest→newest), summed for TTM */
  quarters?: Record<string, [number, number, number, number]>;
  /** instant tags: single latest balance value */
  instants?: Record<string, number>;
  /** flow tags with only an ANNUAL duration (the quarterly-fallback path) */
  annual?: Record<string, number>;
}

export function makeCompanyFacts(spec: FactsSpec): unknown {
  const gaap: Record<string, unknown> = {};
  const qPeriods = [
    { start: "2025-07-01", end: "2025-09-30" },
    { start: "2025-10-01", end: "2025-12-31" },
    { start: "2026-01-01", end: "2026-03-31" },
    { start: "2026-04-01", end: "2026-06-30" },
  ];
  for (const [tag, vals] of Object.entries(spec.quarters ?? {})) {
    gaap[tag] = { units: { USD: qPeriods.map((p, i) => ({ ...p, val: vals[i], form: "10-Q" })) } };
  }
  for (const [tag, val] of Object.entries(spec.instants ?? {})) {
    gaap[tag] = { units: { USD: [
      { end: "2025-12-31", val: val * 0.9, form: "10-K" },   // older point — latestInstant must skip it
      { end: "2026-06-30", val, form: "10-Q" },
    ] } };
  }
  for (const [tag, val] of Object.entries(spec.annual ?? {})) {
    gaap[tag] = { units: { USD: [{ start: "2025-07-01", end: "2026-06-30", val, form: "10-K" }] } };
  }
  return { cik: 1234, entityName: "Fixture Corp", facts: { "us-gaap": gaap } };
}

/** Fundamentals that sail through every veto — the baseline healthy company. */
export function cleanFundamentals(): Fundamentals {
  return { gpOverAssets: 0.35, ttmOpIncome: 500, accruals: 0.02, debtOverAssets: 0.3 };
}

// ---------------------------------------------------------------------------
// In-memory ports for the month-end integration test.
// ---------------------------------------------------------------------------
export interface FixtureSymbol {
  symbol: string;
  sector: string;
  cik: string | null;
  list: "sp500" | "sp400";
  monthCloses: MonthClose[];
  dailyCloses: number[];
  facts: unknown | null;     // null = EDGAR has nothing → missing-fundamentals veto
  tradable?: boolean;        // default true
  fractionable?: boolean;    // default true
}

export function makeFixturePorts(symbols: FixtureSymbol[]): {
  universe: UniversePort; assets: AssetsPort; prices: PricePort; fundamentals: FundamentalsPort;
} {
  const bySym = new Map(symbols.map((s) => [s.symbol, s] as const));
  return {
    universe: {
      async fetchConstituents(): Promise<WikiConstituent[]> {
        return symbols.map((s) => ({ symbol: s.symbol, security: s.symbol, sector: s.sector, cik: s.cik, list: s.list }));
      },
    },
    assets: {
      async fetchActiveAssets(): Promise<Map<string, AssetInfo>> {
        return new Map(symbols.map((s) => [s.symbol, { tradable: s.tradable ?? true, fractionable: s.fractionable ?? true }]));
      },
    },
    prices: {
      async monthEndCloses(symbol: string, months: number): Promise<MonthClose[]> {
        return (bySym.get(symbol)?.monthCloses ?? []).slice(-months);
      },
      async dailyBars(symbol: string): Promise<DailyBar[]> {
        return makeDailyBars(bySym.get(symbol)?.dailyCloses ?? []);
      },
    },
    fundamentals: {
      async cikFor(symbol: string): Promise<string | null> {
        return bySym.get(symbol)?.cik ?? null;
      },
      async companyfacts(cik: string): Promise<unknown | null> {
        for (const s of symbols) if (s.cik === cik) return s.facts;
        return null;
      },
    },
  };
}
