// Bull v2 — EDGAR fundamentals (real FundamentalsPort adapter + PURE extraction). Three layers:
//
//   1. Wire: data.sec.gov companyfacts JSON + the SEC ticker→CIK map, fetched with a declared
//      User-Agent (SEC blocks anonymous UAs) and throttled to ≤2 req/s (their published fair-use
//      ceiling is 10/s; we stay far under — 900 CIKs × quarterly refresh is nothing at 2/s).
//   2. Cache: mom_facts_cache, quarterly cadence. Fundamentals only move on 10-Q/10-K filings, so a
//      cached blob younger than ~80 days is authoritative; on a fetch failure a STALE blob is
//      served rather than nothing (a transient SEC 503 must not veto fifty names via
//      "missing-fundamentals" — that veto is for companies EDGAR genuinely can't explain).
//   3. Pure extraction (extractFundamentals): US-GAAP tag-FALLBACK CHAINS (filers pick different
//      tags for the same concept), TTM = sum of the four most recent distinct ~quarterly durations,
//      falling back to the most recent annual duration; balance items take the latest instant.
//      Any concept the chains can't resolve stays null — and null = VETO upstream, by contract.
import type { DatabaseSync } from "node:sqlite";
import { withTimeout, DEFAULT_TIMEOUT_MS } from "../../../http-utils.js";
import { ensureMomTables } from "./schema.js";
import type { Fundamentals, FundamentalsPort } from "./ports.js";

const USER_AGENT = "bull-v2-momentum/0.1 (paper-trading research; cj@dimsylaisolutions.com)";
const TICKER_MAP_URL = "https://www.sec.gov/files/company_tickers.json";
const FACTS_URL = (cik10: string) => `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik10}.json`;
const CACHE_MAX_AGE_DAYS = 80;      // < a quarter — one refresh per filing cycle
const MIN_REQUEST_GAP_MS = 500;     // ≤2 req/s

// ---------------------------------------------------------------------------
// Tag-fallback chains. Order matters: most standard tag first.
// ---------------------------------------------------------------------------
const TAGS = {
  revenue: ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "RevenueFromContractWithCustomerIncludingAssessedTax", "SalesRevenueNet"],
  cogs: ["CostOfRevenue", "CostOfGoodsAndServicesSold", "CostOfGoodsSold", "CostOfSales"],
  grossProfit: ["GrossProfit"],
  opIncome: ["OperatingIncomeLoss"],
  netIncome: ["NetIncomeLoss", "ProfitLoss"],
  cfo: ["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"],
  assets: ["Assets"],
  ltDebtNoncurrent: ["LongTermDebtNoncurrent"],
  ltDebtCurrent: ["LongTermDebtCurrent"],
  ltDebtTotal: ["LongTermDebt", "LongTermDebtAndCapitalLeaseObligations"],
  stDebt: ["ShortTermBorrowings", "DebtCurrent", "CommercialPaper"],
} as const;

interface FactPoint { start?: string; end: string; val: number }

/** First tag in the chain that has USD data points wins (a filer uses ONE tag consistently —
 *  merging across tags would double-count restated concepts). */
function seriesFor(facts: unknown, tags: readonly string[]): FactPoint[] {
  const gaap = (facts as { facts?: { "us-gaap"?: Record<string, unknown> } })?.facts?.["us-gaap"];
  if (!gaap) return [];
  for (const tag of tags) {
    const units = (gaap[tag] as { units?: Record<string, unknown> } | undefined)?.units;
    if (!units) continue;
    const usd = (units["USD"] ?? Object.values(units)[0]) as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(usd) || !usd.length) continue;
    const pts = usd
      .filter((p) => typeof p.val === "number" && typeof p.end === "string")
      .map((p) => ({ start: typeof p.start === "string" ? p.start : undefined, end: String(p.end), val: Number(p.val) }));
    if (pts.length) return pts;
  }
  return [];
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

/** TTM for a FLOW concept: dedupe by period-end (later filings restate earlier periods — last
 *  write wins), keep ~quarterly durations (70–100d), sum the four most recent distinct quarter
 *  ends. Fewer than four quarters → most recent ANNUAL duration (330–380d). Neither → null. */
export function ttmFlow(facts: unknown, tags: readonly string[]): number | null {
  const pts = seriesFor(facts, tags).filter((p) => p.start);
  const quarterly = new Map<string, number>();
  const annual = new Map<string, number>();
  for (const p of pts) {
    const d = daysBetween(p.start!, p.end);
    if (d >= 70 && d <= 100) quarterly.set(p.end, p.val);
    else if (d >= 330 && d <= 380) annual.set(p.end, p.val);
  }
  const qEnds = [...quarterly.keys()].sort().slice(-4);
  if (qEnds.length === 4) return qEnds.reduce((acc, e) => acc + quarterly.get(e)!, 0);
  const aEnds = [...annual.keys()].sort();
  if (aEnds.length) return annual.get(aEnds[aEnds.length - 1])!;
  return null;
}

/** Latest value of an INSTANT (balance-sheet) concept. */
export function latestInstant(facts: unknown, tags: readonly string[]): number | null {
  const pts = seriesFor(facts, tags).filter((p) => !p.start);
  if (!pts.length) return null;
  pts.sort((a, b) => (a.end < b.end ? -1 : a.end > b.end ? 1 : 0));
  return pts[pts.length - 1].val;
}

/** companyfacts JSON → the four veto inputs. Pure; fixture-tested. */
export function extractFundamentals(facts: unknown): Fundamentals {
  const assets = latestInstant(facts, TAGS.assets);

  let gp = ttmFlow(facts, TAGS.grossProfit);
  if (gp == null) {
    const rev = ttmFlow(facts, TAGS.revenue);
    const cogs = ttmFlow(facts, TAGS.cogs);
    gp = rev != null && cogs != null ? rev - cogs : null;
  }

  const ni = ttmFlow(facts, TAGS.netIncome);
  const cfo = ttmFlow(facts, TAGS.cfo);

  // Total debt: split long-term tags first (noncurrent + current portions), else combined tag;
  // short-term borrowings added when tagged. NO debt tags at all → null → veto upstream (yes, a
  // genuinely zero-debt filer with no debt tags gets vetoed — conservative by contract; the debt
  // check is skipped entirely for Financials/REITs where this most often bites).
  const ltn = latestInstant(facts, TAGS.ltDebtNoncurrent);
  const ltc = latestInstant(facts, TAGS.ltDebtCurrent);
  const lt = ltn != null || ltc != null ? (ltn ?? 0) + (ltc ?? 0) : latestInstant(facts, TAGS.ltDebtTotal);
  const st = latestInstant(facts, TAGS.stDebt);
  const debt = lt == null && st == null ? null : (lt ?? 0) + (st ?? 0);

  const safeDiv = (num: number | null, den: number | null): number | null =>
    num != null && den != null && den > 0 ? num / den : null;

  return {
    gpOverAssets: safeDiv(gp, assets),
    ttmOpIncome: ttmFlow(facts, TAGS.opIncome),
    accruals: ni != null && cfo != null ? safeDiv(ni - cfo, assets) : null,
    debtOverAssets: safeDiv(debt, assets),
  };
}

// ---------------------------------------------------------------------------
// Wire + cache adapter.
// ---------------------------------------------------------------------------

let nextAllowedAt = 0;
async function throttle(): Promise<void> {
  const now = Date.now();
  const wait = nextAllowedAt - now;
  nextAllowedAt = Math.max(now, nextAllowedAt) + MIN_REQUEST_GAP_MS;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

async function fetchJson(url: string): Promise<unknown | null> {
  await throttle();
  try {
    const r = await withTimeout(
      (signal) => fetch(url, { headers: { "User-Agent": USER_AGENT }, signal }),
      DEFAULT_TIMEOUT_MS,
    );
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

/** Real FundamentalsPort bound to a DB (for the quarterly cache). Ticker map is fetched once per
 *  process; symbols are normalized to bare alphanumerics on both sides because the SEC file writes
 *  BRK-B where Wikipedia/Alpaca write BRK.B. */
export function makeEdgarFundamentalsPort(db: DatabaseSync): FundamentalsPort {
  ensureMomTables(db);
  let tickerMap: Map<string, string> | null = null;

  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

  return {
    async cikFor(symbol: string): Promise<string | null> {
      if (!tickerMap) {
        const j = await fetchJson(TICKER_MAP_URL);
        const map = new Map<string, string>();
        if (j && typeof j === "object") {
          for (const row of Object.values(j as Record<string, { ticker?: string; cik_str?: number }>)) {
            if (row?.ticker && row.cik_str != null) map.set(norm(row.ticker), String(row.cik_str).padStart(10, "0"));
          }
        }
        if (!map.size) return null;   // don't cache an empty map — retry next call
        tickerMap = map;
      }
      return tickerMap.get(norm(symbol)) ?? null;
    },

    async companyfacts(cik: string): Promise<unknown | null> {
      const cik10 = cik.replace(/\D/g, "").padStart(10, "0");
      const cached = db
        .prepare("SELECT fetched_ts, json FROM mom_facts_cache WHERE cik=?")
        .get(cik10) as { fetched_ts: string; json: string } | undefined;
      const fresh = cached && (Date.now() - Date.parse(cached.fetched_ts)) / 86_400_000 < CACHE_MAX_AGE_DAYS;
      if (cached && fresh) {
        try { return JSON.parse(cached.json); } catch { /* corrupt cache row → refetch */ }
      }
      const j = await fetchJson(FACTS_URL(cik10));
      if (j != null) {
        db.prepare("INSERT OR REPLACE INTO mom_facts_cache(cik, fetched_ts, json) VALUES(?,?,?)")
          .run(cik10, new Date().toISOString(), JSON.stringify(j));
        return j;
      }
      // Fetch failed: serve stale rather than nothing (transient SEC outage ≠ missing fundamentals).
      if (cached) { try { return JSON.parse(cached.json); } catch { return null; } }
      return null;
    },
  };
}
