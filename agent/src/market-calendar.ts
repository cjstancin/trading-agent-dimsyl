// Bill's market-day guard. Bill's systemd timers fire Mon..Fri 09:30/12:30/16:00 ET, but NYSE has 10
// full-close holidays a year. Without this guard, Bill burns SDK turns + posts useless Discord briefs
// on Juneteenth, Memorial Day, etc.
//
// Strategy: prefer Alpaca's live `/v2/clock` (it knows about every holiday + half-day), fall back to a
// hardcoded NYSE calendar + weekday check if Alpaca is unreachable. The fallback is small and stays in
// sync with the public schedule (review yearly).
import { withTimeout, DEFAULT_TIMEOUT_MS } from "./http-utils.js";

interface ClockResponse {
  is_open: boolean;
  next_open: string;   // ISO timestamp
  next_close: string;  // ISO timestamp
  timestamp: string;   // ISO timestamp
}

const ALPACA_BASE = (process.env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets")
  .replace(/\/+$/, "")
  .replace(/\/v2$/, "");

function authHeaders(): Record<string, string> {
  const id = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_API_SECRET;
  if (!id || !secret) throw new Error("ALPACA_API_KEY / ALPACA_API_SECRET not set");
  return { "APCA-API-KEY-ID": id, "APCA-API-SECRET-KEY": secret };
}

async function getClock(): Promise<ClockResponse | null> {
  try {
    const r = await withTimeout(
      (signal) => fetch(`${ALPACA_BASE}/v2/clock`, { headers: authHeaders(), signal }),
      DEFAULT_TIMEOUT_MS,
    );
    if (!r.ok) return null;
    return (await r.json()) as ClockResponse;
  } catch {
    return null;
  }
}

// NYSE full-close holidays. Source: NYSE official calendar. Half-days (1pm close) are NOT in this
// set — Bill still runs on those; he just has less time to find setups. Review yearly.
const NYSE_FULL_CLOSE_HOLIDAYS: ReadonlySet<string> = new Set([
  // 2026
  "2026-01-01", // New Year's Day
  "2026-01-19", // MLK Day
  "2026-02-16", // Presidents Day
  "2026-04-03", // Good Friday
  "2026-05-25", // Memorial Day
  "2026-06-19", // Juneteenth
  "2026-07-03", // Independence Day observed (Jul 4 is Saturday)
  "2026-09-07", // Labor Day
  "2026-11-26", // Thanksgiving
  "2026-12-25", // Christmas
  // 2027
  "2027-01-01", // New Year's Day
  "2027-01-18", // MLK Day
  "2027-02-15", // Presidents Day
  "2027-03-26", // Good Friday
  "2027-05-31", // Memorial Day
  "2027-06-18", // Juneteenth observed (Jun 19 is Saturday)
  "2027-07-05", // Independence Day observed (Jul 4 is Sunday)
  "2027-09-06", // Labor Day
  "2027-11-25", // Thanksgiving
  "2027-12-24", // Christmas observed (Dec 25 is Saturday)
]);

/** YYYY-MM-DD in ET for the given date (defaults to now). */
function dateKeyET(date: Date = new Date()): string {
  return date.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

function dayOfWeekET(date: Date = new Date()): number {
  // Force to ET, then read the day. Date is naturally a UTC timestamp; we get its ET wall-clock day.
  const etString = date.toLocaleString("en-US", { timeZone: "America/New_York" });
  return new Date(etString).getDay(); // 0 = Sunday, 6 = Saturday
}

export function isWeekendET(date: Date = new Date()): boolean {
  const d = dayOfWeekET(date);
  return d === 0 || d === 6;
}

export function isKnownNyseHoliday(date: Date = new Date()): boolean {
  return NYSE_FULL_CLOSE_HOLIDAYS.has(dateKeyET(date));
}

export interface MarketDayCheck {
  open: boolean;
  reason: string;
  via: "alpaca" | "fallback";
  date: string; // YYYY-MM-DD in ET
}

/**
 * Async — prefers Alpaca's live clock (authoritative; covers every holiday including ones Alpaca
 * adds later), falls back to the static NYSE holidays + weekday check if Alpaca is unreachable.
 * Returns { open: true } for any trading day (today's slot might be PRE-market, MID-day, or POST-close
 * — the trading day itself is still valid).
 */
export async function isMarketDayToday(): Promise<MarketDayCheck> {
  const clock = await getClock();
  if (clock != null) {
    const today = dateKeyET(new Date(clock.timestamp));
    const nextOpen = dateKeyET(new Date(clock.next_open));
    const nextClose = dateKeyET(new Date(clock.next_close));
    // Trading day if:
    //  - market is currently open right now, OR
    //  - next_open is today (haven't opened yet but will), OR
    //  - next_close is today (already opened today, will close later)
    const isTradingDay = clock.is_open || nextOpen === today || nextClose === today;
    const reason = isTradingDay
      ? clock.is_open ? "Alpaca clock: market OPEN now" : `Alpaca clock: trading day (opens ${clock.next_open})`
      : `Alpaca clock: closed all day (next open ${clock.next_open})`;
    return { open: isTradingDay, reason, via: "alpaca", date: today };
  }
  // Fallback — Alpaca unreachable. Use the local heuristic.
  const today = dateKeyET();
  if (isWeekendET()) return { open: false, reason: "weekend (fallback)", via: "fallback", date: today };
  if (isKnownNyseHoliday()) return { open: false, reason: "NYSE full-close holiday (offline calendar)", via: "fallback", date: today };
  return { open: true, reason: "weekday, not a known holiday (fallback)", via: "fallback", date: today };
}
