// Bull v2 insider sleeve — LIVE market adapters behind the ports (ports.ts). Data host for bars +
// quotes (feed=iex — the free paper-tier feed; SIP needs a paid sub and would 403), trading host
// for asset metadata (fractionable/exchange/tradable), EDGAR companyfacts for shares outstanding
// (market cap = shares × latest price — no free "market cap by ticker" endpoint exists in our
// stack; see ports.ts header).
//
// Float honesty note: Alpaca's JSON delivers prices/volumes as JSON numbers, so floats exist for
// one instant at the parse boundary — they're converted to d9 immediately via toFixed(6) (exact
// for cent-quantized prices and integer volumes) and every comparison downstream is d9. This is
// gate math (liquidity floors, spreads), not ledger math; the ledger only ever sees broker-report
// STRINGS via the Phase-1 fill path.
import { withTimeout, DEFAULT_TIMEOUT_MS } from "../../../http-utils.js";
import { getBars } from "../../../alpaca.js";
import { d9, mul9, type D9 } from "../../decimal.js";
import type { AssetInfo, DailyBar, EdgarPort, MarketPort, PricePort, Quote, SectorPort } from "./ports.js";

const DATA_HOST = "https://data.alpaca.markets";
const TRADE_HOST = (process.env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets")
  .replace(/\/+$/, "").replace(/\/v2$/, "");
const TIMEOUT_MS = parseInt(process.env.ALPACA_TIMEOUT_MS || String(DEFAULT_TIMEOUT_MS), 10);

function authHeaders(): Record<string, string> {
  const id = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_API_SECRET;
  if (!id || !secret) throw new Error("ALPACA_API_KEY / ALPACA_API_SECRET not set");
  return { "APCA-API-KEY-ID": id, "APCA-API-SECRET-KEY": secret };
}

/** JSON number → d9 at the parse boundary (see header). */
function d9j(n: number): D9 {
  return d9(n.toFixed(6));
}

function dateNDaysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

async function fetchDailyBars(symbol: string, startDate: string, endDate: string): Promise<DailyBar[]> {
  // Reuses the battle-tested v1 getBars (data host, feed=iex, ascending, [] on failure).
  const bars = await getBars(symbol, startDate, endDate, "1Day", 1000);
  return bars.map((b) => ({ date: String(b.t).slice(0, 10), close9: d9j(b.c), volume9: d9j(b.v) }));
}

/** Build the live MarketPort. Takes the EDGAR port so the market-cap path shares its throttle +
 *  User-Agent discipline instead of side-channeling sec.gov. */
export function alpacaMarketPort(edgar?: EdgarPort): MarketPort {
  return {
    async getDailyBars(symbol: string, lookbackDays: number): Promise<DailyBar[]> {
      return fetchDailyBars(symbol, dateNDaysAgo(lookbackDays + 5), new Date().toISOString().slice(0, 10));
    },

    async getQuote(symbol: string): Promise<Quote | null> {
      // Latest NBBO-ish quote from the iex feed — the spread gate needs a real bid/ask, not a
      // last trade. null on any failure → gates fail closed.
      try {
        const r = await withTimeout((signal) => fetch(
          `${DATA_HOST}/v2/stocks/${encodeURIComponent(symbol)}/quotes/latest?feed=iex`,
          { headers: authHeaders(), signal },
        ), TIMEOUT_MS);
        if (!r.ok) return null;
        const j = (await r.json()) as { quote?: { bp?: number; ap?: number } };
        const bp = j?.quote?.bp, ap = j?.quote?.ap;
        if (typeof bp !== "number" || typeof ap !== "number" || bp <= 0 || ap <= 0) return null;
        return { bid9: d9j(bp), ask9: d9j(ap) };
      } catch { return null; }
    },

    async getMarketCap9(symbol: string, cik?: string): Promise<D9 | null> {
      if (!cik || !edgar?.getSharesOutstanding) return null; // unverifiable → floor fails closed
      const shares9 = await edgar.getSharesOutstanding(cik);
      if (shares9 === null) return null;
      const q = await this.getQuote(symbol);
      const px9 = q ? (q.bid9 + q.ask9) / 2n : null;
      if (px9 === null || px9 <= 0n) return null;
      return mul9(shares9, px9);
    },

    async getAsset(symbol: string): Promise<AssetInfo | null> {
      // Trading host read (assets metadata). Read-only — no order rail lives here.
      try {
        const r = await withTimeout((signal) => fetch(
          `${TRADE_HOST}/v2/assets/${encodeURIComponent(symbol)}`,
          { headers: authHeaders(), signal },
        ), TIMEOUT_MS);
        if (!r.ok) return null;
        const j = (await r.json()) as { fractionable?: boolean; exchange?: string; tradable?: boolean };
        return {
          fractionable: !!j.fractionable,
          exchange: typeof j.exchange === "string" ? j.exchange : null,
          tradable: !!j.tradable,
        };
      } catch { return null; }
    },
  };
}

/** Live PricePort for CAR math (daily closes; same iex daily bars). */
export const alpacaPricePort: PricePort = {
  async getCloses(symbol: string, startDate: string, endDate: string): Promise<{ date: string; close9: D9 }[]> {
    const bars = await fetchDailyBars(symbol, startDate, endDate);
    return bars.map((b) => ({ date: b.date, close9: b.close9 }));
  },
};

/** STUB — no free sector source exists in our stack (Alpaca has none; EDGAR SIC codes are a poor
 *  GICS proxy and need another fetch layer). Returns null for everything, which the planner treats
 *  as "cannot count toward the sector cap" (see planner.ts — deliberate fail-OPEN for the cap
 *  only, because a fail-closed unknown would block every entry). Phase 4/5 must supply a real
 *  SectorPort; the planner + tests are already wired for it. */
export const sectorPortStub: SectorPort = {
  async getSector(): Promise<string | null> {
    return null;
  },
};
