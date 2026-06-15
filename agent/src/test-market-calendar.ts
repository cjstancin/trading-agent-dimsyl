// SUCCESS / FAIL / NULL tests for the market-calendar guard (no network — pure date math).
// Covers the two closed-market signals Bill relies on to skip dead days: weekend + NYSE full-close
// holiday, plus the 1pm early-close half-day logic. Run: npm run test:market-calendar
import { isHalfDayET, isPastHalfDayCloseET, isKnownNyseHoliday, isWeekendET } from "./market-calendar.js";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean) => { (cond ? pass++ : fail++); console.log(`${cond ? "PASS" : "FAIL"} — ${name}`); };

// --- isWeekendET --------------------------------------------------------------------------------
// 14:00Z keeps the ET wall-clock day on the same calendar date (well clear of the UTC↔ET offset), so
// the weekday these assert is unambiguous. 2026-06-13 = Sat, 2026-06-14 = Sun, 2026-06-15..19 = Mon..Fri.
check("WEEKEND: 2026-06-13 (Saturday) is a weekend", isWeekendET(new Date("2026-06-13T14:00:00Z")) === true);
check("WEEKEND: 2026-06-14 (Sunday) is a weekend", isWeekendET(new Date("2026-06-14T14:00:00Z")) === true);
check("WEEKEND: 2026-06-15 (Monday) is NOT a weekend", isWeekendET(new Date("2026-06-15T14:00:00Z")) === false);
check("WEEKEND: 2026-06-17 (Wednesday) is NOT a weekend", isWeekendET(new Date("2026-06-17T14:00:00Z")) === false);
check("WEEKEND: 2026-06-19 (Friday) is NOT a weekend", isWeekendET(new Date("2026-06-19T14:00:00Z")) === false);

// --- isKnownNyseHoliday: every hardcoded 2026/2027 full-close holiday ----------------------------
// Each must be recognized; if one drops out of the set (or the date is mistyped), its assertion fails.
// All stamped 15:00Z = mid-session ET so the calendar date is never ambiguous.
const FULL_CLOSE_2026: Array<[string, string]> = [
  ["2026-01-01", "New Year's Day"],
  ["2026-01-19", "MLK Day"],
  ["2026-02-16", "Presidents Day"],
  ["2026-04-03", "Good Friday"],
  ["2026-05-25", "Memorial Day"],
  ["2026-06-19", "Juneteenth"],
  ["2026-09-07", "Labor Day"],
  ["2026-11-26", "Thanksgiving"],
  ["2026-12-25", "Christmas"],
];
const FULL_CLOSE_2027: Array<[string, string]> = [
  ["2027-01-01", "New Year's Day"],
  ["2027-01-18", "MLK Day"],
  ["2027-02-15", "Presidents Day"],
  ["2027-03-26", "Good Friday"],
  ["2027-05-31", "Memorial Day"],
  ["2027-06-18", "Juneteenth observed"],
  ["2027-07-05", "Independence Day observed"],
  ["2027-09-06", "Labor Day"],
  ["2027-11-25", "Thanksgiving"],
  ["2027-12-24", "Christmas observed"],
];
for (const [iso, label] of [...FULL_CLOSE_2026, ...FULL_CLOSE_2027]) {
  check(`FULL-CLOSE: ${iso} (${label}) is a full holiday`, isKnownNyseHoliday(new Date(`${iso}T15:00:00Z`)) === true);
}
// Regular trading days are NOT full-close holidays (guard against a too-broad set).
check("FULL-CLOSE: 2026-06-15 (regular Mon) is NOT a holiday", isKnownNyseHoliday(new Date("2026-06-15T15:00:00Z")) === false);
check("FULL-CLOSE: 2026-12-23 (regular Wed) is NOT a holiday", isKnownNyseHoliday(new Date("2026-12-23T15:00:00Z")) === false);

// --- isHalfDayET --------------------------------------------------------------------------------
// Acceptance: day after Thanksgiving 2026 is a 1pm early close. 18:00Z = 13:00 ET (EST), date 2026-11-27.
check("HALF-DAY: 2026-11-27 (day after Thanksgiving) is a half-day", isHalfDayET(new Date("2026-11-27T18:00:00Z")) === true);
check("HALF-DAY: 2026-12-24 (Christmas Eve) is a half-day", isHalfDayET(new Date("2026-12-24T18:00:00Z")) === true);
check("HALF-DAY: 2027-11-26 (day after Thanksgiving) is a half-day", isHalfDayET(new Date("2027-11-26T18:00:00Z")) === true);
// c63ee1d correction: Jul 4 2026 is a Saturday → Jul 3 is a 1pm EARLY close, NOT a full closure.
check("HALF-DAY: 2026-07-03 (Independence Day observed) is a half-day", isHalfDayET(new Date("2026-07-03T15:00:00Z")) === true);
check("HALF-DAY: 2026-07-03 is NOT a full-close holiday (corrected from c63ee1d)", isKnownNyseHoliday(new Date("2026-07-03T15:00:00Z")) === false);
// A regular trading day is not a half-day.
check("HALF-DAY: 2026-06-15 (regular Mon) is NOT a half-day", isHalfDayET(new Date("2026-06-15T14:00:00Z")) === false);

// --- full-close calendar still intact (don't regress c63ee1d) -----------------------------------
check("FULL-CLOSE: 2026-05-25 (Memorial Day) still a full holiday", isKnownNyseHoliday(new Date("2026-05-25T15:00:00Z")) === true);
check("FULL-CLOSE: 2026-06-19 (Juneteenth) still a full holiday", isKnownNyseHoliday(new Date("2026-06-19T15:00:00Z")) === true);
check("FULL-CLOSE: 2027-12-24 (Christmas observed) still a full holiday", isKnownNyseHoliday(new Date("2027-12-24T15:00:00Z")) === true);
check("FULL-CLOSE: 2027-12-24 is NOT a half-day (it's a full close)", isHalfDayET(new Date("2027-12-24T15:00:00Z")) === false);

// --- isPastHalfDayCloseET (time-of-day only) ----------------------------------------------------
// 17:30Z on 2026-11-27 (EST, UTC-5) = 12:30 ET → before close.
check("TIME: 12:30 ET is before the 13:00 ET half-day close", isPastHalfDayCloseET(new Date("2026-11-27T17:30:00Z")) === false);
// 18:00Z = exactly 13:00 ET → at close (inclusive).
check("TIME: 13:00 ET is at/after the half-day close", isPastHalfDayCloseET(new Date("2026-11-27T18:00:00Z")) === true);
// 18:30Z = 13:30 ET → after close.
check("TIME: 13:30 ET is past the half-day close", isPastHalfDayCloseET(new Date("2026-11-27T18:30:00Z")) === true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
