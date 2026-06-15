// SUCCESS / FAIL / NULL tests for the market-calendar half-day logic (no network — pure date math).
// Run: npm run test:market-calendar
import { isHalfDayET, isPastHalfDayCloseET, isKnownNyseHoliday } from "./market-calendar.js";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean) => { (cond ? pass++ : fail++); console.log(`${cond ? "PASS" : "FAIL"} — ${name}`); };

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
