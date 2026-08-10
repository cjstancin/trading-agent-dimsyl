// Bull v2 — rituals: America/New_York wall-clock helpers. market-calendar.ts keeps its ET
// primitives private, so the rituals carry the same PATTERNS here (toLocaleDateString en-CA for
// the date key, h23 toLocaleTimeString for minutes) rather than re-deriving timezones ad hoc.
// Everything is pure and injectable — orchestrators take these as deps so tests pin the clock.

/** YYYY-MM-DD in ET for the given date (defaults to now). */
export function etDateKey(date: Date = new Date()): string {
  return date.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

/** "HH:MM" ET wall clock (h23). */
export function etHHMM(date: Date = new Date()): string {
  return date.toLocaleTimeString("en-US", {
    timeZone: "America/New_York", hourCycle: "h23", hour: "2-digit", minute: "2-digit",
  });
}

/** Minutes since ET midnight. 09:30 ET → 570. */
export function etMinutesOfDay(date: Date = new Date()): number {
  const [h, m] = etHHMM(date).split(":").map(Number);
  return h * 60 + m;
}

/** ET day of week: 0 = Sunday … 6 = Saturday (market-calendar.ts pattern). */
export function etWeekday(date: Date = new Date()): number {
  const etString = date.toLocaleString("en-US", { timeZone: "America/New_York" });
  return new Date(etString).getDay();
}

/** "YYYY-MM" of the calendar month BEFORE the given ET date key (statement + momentum signal). */
export function prevMonthKey(dateKey: string): string {
  const [y, m] = dateKey.slice(0, 7).split("-").map(Number);
  const idx = y * 12 + (m - 1) - 1;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

/** Latest calendar-quarter end ≤ the ET date key — the 13F periodOfReport the anchor rituals
 *  watch (Aug 14 → 2026-06-30; Feb 14 → the prior year's 12-31). */
export function latestQuarterEnd(dateKey: string): string {
  const y = Number(dateKey.slice(0, 4));
  const ends = [`${y}-03-31`, `${y}-06-30`, `${y}-09-30`, `${y}-12-31`];
  const past = ends.filter((e) => e <= dateKey);
  return past.length ? past[past.length - 1] : `${y - 1}-12-31`;
}
