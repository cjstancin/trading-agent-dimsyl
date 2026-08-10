// Bull v2 — Anchor: CUSIP→ticker mapping. 13F tables identify holdings by CUSIP; Alpaca trades
// tickers. The rule (design): a mapping failure is FLAGGED into the approvals queue and the line is
// dropped from the clone — we never guess a ticker, because a wrong guess trades the wrong company
// with real (paper) orders and poisons the ledger for a quarter.
//
// Adapters:
//   · fixtureMapping — a static table, used by every offline test.
//   · openFigiMapping — the real path: OpenFIGI /v3/mapping (idType ID_CUSIP), free tier 25 req/min
//     unkeyed / 250 with OPENFIGI_API_KEY. Batched 100 jobs per POST. Returns the US composite
//     ticker; FIGI "securityType" filtering is left to the caller (the clone core already filters
//     non-equity lines by 13F fields before mapping matters).
//   · SEC fallback (documented, not implemented): company_tickers.json maps CIK→ticker, NOT
//     CUSIP→ticker — usable only via issuer-name fuzzy match, which violates the never-guess rule.
//     If OpenFIGI is down on a filing evening, the correct behavior is already what failure
//     produces: the affected lines land in the approvals queue for CJ to resolve by hand.
import { withTimeout, DEFAULT_TIMEOUT_MS } from "../../../http-utils.js";
import type { MappingPort, InfoTableLine, MappedLine } from "./types.js";

/** Static-table adapter for tests and for CJ-curated manual overrides. Keys uppercased. */
export function fixtureMapping(table: Record<string, string>): MappingPort {
  const map = new Map(Object.entries(table).map(([k, v]) => [k.toUpperCase(), v.toUpperCase()]));
  return {
    async tickerForCusip(cusip: string): Promise<string | null> {
      return map.get(cusip.toUpperCase()) ?? null;
    },
  };
}

const FIGI_URL = "https://api.openfigi.com/v3/mapping";
const FIGI_TIMEOUT_MS = parseInt(process.env.OPENFIGI_TIMEOUT_MS || String(DEFAULT_TIMEOUT_MS), 10);

/** Real adapter: OpenFIGI ID_CUSIP → US composite ticker. Caches within the process (a filing
 *  evening asks about the same ~30 CUSIPs repeatedly). Any error → null → caller flags the line;
 *  the sleeve NEVER trades an unresolved CUSIP. Untested against the live API by policy (offline
 *  tests only) — first production use is behind the approvals queue anyway. */
export function openFigiMapping(): MappingPort {
  const cache = new Map<string, string | null>();
  return {
    async tickerForCusip(cusip: string): Promise<string | null> {
      const key = cusip.toUpperCase();
      if (cache.has(key)) return cache.get(key)!;
      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (process.env.OPENFIGI_API_KEY) headers["X-OPENFIGI-APIKEY"] = process.env.OPENFIGI_API_KEY;
        const res = await withTimeout(
          (signal) => fetch(FIGI_URL, {
            method: "POST",
            headers,
            body: JSON.stringify([{ idType: "ID_CUSIP", idValue: key, exchCode: "US" }]),
            signal,
          }),
          FIGI_TIMEOUT_MS,
        );
        if (!res.ok) { cache.set(key, null); return null; }
        const j: any = await res.json();
        const ticker = j?.[0]?.data?.[0]?.ticker;
        // OpenFIGI reports class shares as "BRK/B"; Alpaca wants "BRK.B".
        const normalized = typeof ticker === "string" && ticker ? ticker.replace(/\//g, ".").toUpperCase() : null;
        cache.set(key, normalized);
        return normalized;
      } catch {
        cache.set(key, null);
        return null;
      }
    },
  };
}

/** Resolve a whole table of lines. Pure orchestration over the port — unresolved lines come back
 *  with symbol=null so the clone core can exclude + flag them (never silently drop). */
export async function mapLines(mapping: MappingPort, lines: InfoTableLine[]): Promise<MappedLine[]> {
  const out: MappedLine[] = [];
  for (const line of lines) {
    out.push({ ...line, symbol: await mapping.tickerForCusip(line.cusip, line.nameOfIssuer) });
  }
  return out;
}
