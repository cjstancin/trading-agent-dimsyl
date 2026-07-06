// Bill's market-day guard. Bill's systemd timers fire Mon..Fri 09:15/09:30/12:30/16:00 ET, but NYSE has
// 10 full-close holidays a year. Without this guard, Bill burns SDK turns + posts useless Discord briefs
// on Juneteenth, Memorial Day, etc.
//
// Strategy: ask Alpaca's `/v2/calendar` whether TODAY is a trading session — it's authoritative (every
// holiday + half-day) and, unlike `/v2/clock`, answers "is today a trading day?" independently of the
// time of day. (The clock's next_open/next_close roll forward to TOMORROW the instant the 16:00 close
// hits, so a clock-based "is today a session" check returned a false "closed all day" for anything
// running at/after the close — which is exactly when the EOD wrap fires, so it skipped EVERY day. Fixed
// 2026-06-26.) Fall back to a hardcoded NYSE calendar + weekday check if Alpaca is unreachable.
import { withTimeout, DEFAULT_TIMEOUT_MS } from "./http-utils.js";

export interface CalendarDay {
  date: string;  // YYYY-MM-DD (ET session date)
  open: string;  // "HH:MM" ET session open  (e.g. "09:30")
  close: string; // "HH:MM" ET session close (e.g. "16:00", or "13:00" on half-days)
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

// Probe Alpaca's calendar for TODAY (ET). `reachable` distinguishes "API down" from "not a session":
// reachable=false → couldn't reach Alpaca (caller falls back to the offline calendar); reachable=true
// with day=null → Alpaca confirms today is NOT a trading session (weekend/holiday). Time-independent.
async function getCalendarToday(): Promise<{ reachable: boolean; day: CalendarDay | null }> {
  try {
    const today = dateKeyET();
    const r = await withTimeout(
      (signal) => fetch(`${ALPACA_BASE}/v2/calendar?start=${today}&end=${today}`, { headers: authHeaders(), signal }),
      DEFAULT_TIMEOUT_MS,
    );
    if (!r.ok) return { reachable: false, day: null };
    const arr = (await r.json()) as CalendarDay[];
    if (!Array.isArray(arr)) return { reachable: false, day: null };
    return { reachable: true, day: arr.find((d) => d?.date === today) ?? null };
  } catch {
    return { reachable: false, day: null };
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

/** True if the ET wall-clock time is inside the regular session (09:30–16:00, or 09:30–13:00 on half-days).
 *  Time-of-day only — pair with isMarketDayToday() to know whether TODAY is a trading day at all. */
export function isDuringSessionET(halfDay = false, date: Date = new Date()): boolean {
  const m = etMinutesOfDay(date);
  return m >= 9 * 60 + 30 && m < (halfDay ? HALF_DAY_CLOSE_MINUTES : 16 * 60);
}

/** True if an Alpaca calendar close time ("HH:MM" ET) is before the regular 16:00 ET close → a half-day.
 *  Fails safe to false (treat as a normal full session) if the string can't be parsed. */
export function isEarlyCloseET(closeHHMM: string): boolean {
  const m = /^(\d{1,2}):(\d{2})$/.exec((closeHHMM || "").trim());
  if (!m) return false;
  return Number(m[1]) * 60 + Number(m[2]) < 16 * 60;
}

export interface MarketDayCheck {
  open: boolean;
  reason: string;
  via: "alpaca" | "fallback";
  date: string; // YYYY-MM-DD in ET
  halfDay: boolean; // true on NYSE 1pm early-close days (still a trading day)
}

export interface CalProbe { reachable: boolean; day: CalendarDay | null; }

/**
 * Pure decision core (unit-tested, no network). Given a calendar probe + the offline signals, decide
 * whether TODAY is a trading session. The calendar is authoritative when reachable; otherwise the static
 * weekend/holiday calendar is the fallback. Returns { open: true } for the WHOLE trading day — pre-market,
 * mid-session, or post-close — so the 16:00 ET EOD wrap correctly sees the day it just finished.
 */
export function decideMarketDay(opts: {
  today: string; cal: CalProbe; weekend: boolean; holiday: boolean; halfDayStatic: boolean;
}): MarketDayCheck {
  const { today, cal, weekend, holiday, halfDayStatic } = opts;
  if (cal.reachable) {
    if (cal.day) {
      const halfDay = halfDayStatic || isEarlyCloseET(cal.day.close);
      return { open: true, reason: `Alpaca calendar: trading day (session ${cal.day.open}–${cal.day.close} ET)`, via: "alpaca", date: today, halfDay };
    }
    return { open: false, reason: "Alpaca calendar: not a trading session (weekend/holiday)", via: "alpaca", date: today, halfDay: false };
  }
  // Alpaca unreachable — offline heuristic.
  if (weekend) return { open: false, reason: "weekend (offline calendar)", via: "fallback", date: today, halfDay: halfDayStatic };
  if (holiday) return { open: false, reason: "NYSE full-close holiday (offline calendar)", via: "fallback", date: today, halfDay: halfDayStatic };
  return { open: true, reason: "weekday, not a known holiday (offline calendar)", via: "fallback", date: today, halfDay: halfDayStatic };
}

/**
 * Async — asks Alpaca's calendar whether TODAY (ET) is a trading session; authoritative + time-of-day
 * independent (covers every holiday/half-day Alpaca knows). Falls back to the static NYSE holidays +
 * weekday check if Alpaca is unreachable.
 */
export async function isMarketDayToday(): Promise<MarketDayCheck> {
  return decideMarketDay({
    today: dateKeyET(),
    cal: await getCalendarToday(),
    weekend: isWeekendET(),
    holiday: isKnownNyseHoliday(),
    halfDayStatic: isHalfDayET(),
  });
}
