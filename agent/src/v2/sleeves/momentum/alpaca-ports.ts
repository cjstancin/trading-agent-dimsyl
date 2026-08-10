// Bull v2 — Alpaca real adapters for the momentum ports. Two hosts, two very different postures:
//
//   PricePort  → the DATA host (data.alpaca.markets), read-only bars. Per the design contract the
//                signal uses adjustment=all (dividends folded into closes — 12-1 must be a TOTAL
//                return) and feed=sip (full-market closes; iex-only closes misprice thin names).
//                NOTE: sip historical bars need a paid data subscription on some accounts — if the
//                request 403s the adapter returns [], the ≥13-closes universe gate empties, and the
//                failure is LOUD at buildUniverse rather than silently mispricing the signal.
//   AssetsPort → the TRADING host, but strictly the read-only /v2/assets listing (which flags carry
//                fractionable). Same hard paper-host assertion as broker.ts: any non-paper base URL
//                throws at module load. No order path, no account math, lives here.
//
// Both follow the alpaca.ts house pattern: withTimeout on every request, [] / empty on failure so
// callers degrade explicitly, never a hung ritual.
import { withTimeout, DEFAULT_TIMEOUT_MS } from "../../../http-utils.js";
import type { AssetInfo, AssetsPort, DailyBar, MonthClose, PricePort } from "./ports.js";

const DATA_BASE = (process.env.ALPACA_DATA_URL || "https://data.alpaca.markets").replace(/\/+$/, "");

const RAW_TRADING_BASE = process.env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets";
const TRADING_BASE = RAW_TRADING_BASE.replace(/\/+$/, "").replace(/\/v2$/, "");
if (TRADING_BASE !== "https://paper-api.alpaca.markets") {
  throw new Error(`Refusing non-paper Alpaca base URL: "${RAW_TRADING_BASE}". Bull v2 is paper-only.`);
}

const TIMEOUT_MS = parseInt(process.env.ALPACA_TIMEOUT_MS || String(DEFAULT_TIMEOUT_MS), 10);

function authHeaders(): Record<string, string> {
  const id = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_API_SECRET;
  if (!id || !secret) throw new Error("ALPACA_API_KEY / ALPACA_API_SECRET not set");
  return { "APCA-API-KEY-ID": id, "APCA-API-SECRET-KEY": secret };
}

interface WireBar { t: string; o: number; h: number; l: number; c: number; v: number }

async function getBarsRaw(symbol: string, qs: URLSearchParams): Promise<WireBar[]> {
  // Single page: limit 10000 covers 13 months of dailies, let alone month bars.
  try {
    const r = await withTimeout((signal) => fetch(
      `${DATA_BASE}/v2/stocks/${encodeURIComponent(symbol)}/bars?${qs.toString()}`,
      { headers: authHeaders(), signal },
    ), TIMEOUT_MS);
    if (!r.ok) return [];
    const j = (await r.json()) as { bars?: WireBar[] };
    return Array.isArray(j?.bars) ? j.bars : [];
  } catch { return []; }
}

export const alpacaPricePort: PricePort = {
  /** Month bars (1Month, adjustment=all, feed=sip): each bar's close is the dividend-adjusted
   *  month-end close; the bar timestamp is the month START, so the month key is t.slice(0,7).
   *  CAUTION for callers: when run mid-month the newest bar is the PARTIAL current month — the
   *  month-end ritual runs at/after the last session's close, where it IS the month-end. */
  async monthEndCloses(symbol: string, months: number): Promise<MonthClose[]> {
    const start = new Date(Date.now() - (months + 2) * 31 * 86_400_000).toISOString().slice(0, 10);
    const qs = new URLSearchParams({
      timeframe: "1Month", adjustment: "all", feed: "sip", sort: "asc",
      start, limit: "10000",
    });
    const bars = await getBarsRaw(symbol, qs);
    return bars
      .filter((b) => typeof b.c === "number" && b.c > 0)
      .map((b) => ({ month: String(b.t).slice(0, 7), close: b.c }))
      .slice(-months);
  },

  async dailyBars(symbol: string, startDate: string, end: string): Promise<DailyBar[]> {
    const qs = new URLSearchParams({
      timeframe: "1Day", adjustment: "all", feed: "sip", sort: "asc",
      start: startDate, end, limit: "10000",
    });
    const bars = await getBarsRaw(symbol, qs);
    return bars
      .filter((b) => typeof b.c === "number" && b.c > 0)
      .map((b) => ({ date: String(b.t).slice(0, 10), close: b.c, volume: Number(b.v) || 0 }));
  },
};

export const alpacaAssetsPort: AssetsPort = {
  /** Active US-equity assets with flags. Throws on failure — the universe build must not quietly
   *  intersect against an empty asset list (that "filters" everything out). */
  async fetchActiveAssets(): Promise<Map<string, AssetInfo>> {
    const r = await withTimeout((signal) => fetch(
      `${TRADING_BASE}/v2/assets?status=active&asset_class=us_equity`,
      { headers: authHeaders(), signal },
    ), TIMEOUT_MS);
    if (!r.ok) throw new Error(`Alpaca GET /v2/assets → ${r.status}`);
    const assets = (await r.json()) as Array<Record<string, unknown>>;
    const out = new Map<string, AssetInfo>();
    for (const a of Array.isArray(assets) ? assets : []) {
      out.set(String(a.symbol).toUpperCase(), { tradable: !!a.tradable, fractionable: !!a.fractionable });
    }
    if (!out.size) throw new Error("Alpaca /v2/assets returned an empty list — refusing");
    return out;
  },
};
