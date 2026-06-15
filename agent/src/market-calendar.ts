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
  // NOTE: 2026-07-03 is NOT a full close — per the NYSE 2026 calendar it is a 1pm EARLY close
  // (Jul 4 is a Saturday). It lives in NYSE_HALF_DAY_HOLIDAYS below. (Corrected from c63ee1d.)
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

// NYSE early-close (1:00pm ET) half-days. Source: NYSE/ICE official 2026–2028 calendar. These ARE
// trading days — Bill still runs — but the session ends at 13:00 ET instead of 16:00. So the mid slot
// (12:30 ET) is the LAST safe trade window, and execute must not place orders after 13:00 ET (Alpaca
// rejects them once the market is closed). Review yearly.
const NYSE_HALF_DAY_HOLIDAYS: ReadonlySet<string> = new Set([
  // 2026
  "2026-07-03", // Independence Day observed early close (Jul 4 is a Saturday)
  "2026-11-27", // Day after Thanksgiving (Black Friday)
  "2026-12-24", // Christmas Eve
  // 2027
  "2027-11-26", // Day after Thanksgiving (Black Friday)
]);

// ET wall-clock close of a half-day session: 13:00 ET.
const HALF_DAY_CLOSE_MINUTES = 13 * 60;

/** YYYY-MM-DD in ET for the given date (defaults to now). */
function dateKeyET(date: Date = new Date()): string {
  return date.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

/** Minutes since ET midnight for the given date (defaults to now). 09:30 ET → 570. */
function etMinutesOfDay(date: Date = new Date()): number {
  const hhmm = date.toLocaleTimeString("en-US", {
    timeZone: "America/New_York", hourCycle: "h23", hour: "2-digit", minute: "2-digit",
  });
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
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

/** True if the given date (defaults to now) is a NYSE 1pm early-close half-day. */
export function isHalfDayET(date: Date = new Date()): boolean {
  return NYSE_HALF_DAY_HOLIDAYS.has(dateKeyET(date));
}

/** True if the ET wall-clock time is at/after the half-day close (13:00 ET). Time-of-day only. */
export function isPastHalfDayCloseET(date: Date = new Date()): boolean {
  return etMinutesOfDay(date) >= HALF_DAY_CLOSE_MINUTES;
}

export interface MarketDayCheck {
  open: boolean;
  reason: string;
  via: "alpaca" | "fallback";
  date: string; // YYYY-MM-DD in ET
  halfDay: boolean; // true on NYSE 1pm early-close days (still a trading day)
}

/**
 * Async — prefers Alpaca's live clock (authoritative; covers every holiday including ones Alpaca
 * adds later), falls back to the static NYSE holidays + weekday check if Alpaca is unreachable.
 * Returns { open: true } for any trading day (today's slot might be PRE-market, MID-day, or POST-close
 * — the trading day itself is still valid).
 */
export async function isMarketDayToday(): Promise<MarketDayCheck> {
  // halfDay comes from the static early-close calendar regardless of source — Alpaca's clock reports a
  // trading day but doesn't flag the 1pm close in a single field we rely on, so we read it locally.
  const halfDay = isHalfDayET();
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
    return { open: isTradingDay, reason, via: "alpaca", date: today, halfDay };
  }
  // Fallback — Alpaca unreachable. Use the local heuristic.
  const today = dateKeyET();
  if (isWeekendET()) return { open: false, reason: "weekend (fallback)", via: "fallback", date: today, halfDay };
  if (isKnownNyseHoliday()) return { open: false, reason: "NYSE full-close holiday (offline calendar)", via: "fallback", date: today, halfDay };
  return { open: true, reason: "weekday, not a known holiday (fallback)", via: "fallback", date: today, halfDay };
}
