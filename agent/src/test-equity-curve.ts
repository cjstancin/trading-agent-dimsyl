// Unit tests for the PURE daily equity-curve builder. node:test + synthetic Alpaca portfolio-history
// payloads only — NO network, NO orders. Covers the happy path (dates + day-over-day P&L), duplicate-date
// collapsing, filtering of null/zero equity and bad timestamps, mismatched array lengths, the single-point
// dayPnl=0 case, and empty/null input. Run: npm run test:equity-curve
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEquityCurve } from "./equity-curve.js";

// Epoch SECONDS for a few UTC dates (Date.UTC is deterministic — no clock read).
const sec = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) / 1000;

test("SUCCESS: builds a dated series with day-over-day P&L", () => {
  const ph = {
    timestamp: [sec(2026, 6, 10), sec(2026, 6, 11), sec(2026, 6, 12)],
    equity: [100000, 101500, 100800],
  };
  const series = buildEquityCurve(ph);
  assert.deepEqual(series, [
    { date: "2026-06-10", equity: 100000, dayPnl: 0 },     // first point → 0
    { date: "2026-06-11", equity: 101500, dayPnl: 1500 },  // +1500
    { date: "2026-06-12", equity: 100800, dayPnl: -700 },  // −700
  ]);
  // dayPnl values sum to the total equity change over the window (internal consistency).
  const total = series.reduce((s, p) => s + p.dayPnl, 0);
  assert.equal(total, 100800 - 100000);
});

test("rounds equity and dayPnl to cents", () => {
  const ph = { timestamp: [sec(2026, 6, 10), sec(2026, 6, 11)], equity: [100000.005, 100100.114] };
  const series = buildEquityCurve(ph);
  assert.equal(series[0].equity, 100000.01);
  assert.equal(series[1].equity, 100100.11);
  assert.equal(series[1].dayPnl, 100.1); // r2(100100.11 − 100000.01)
});

test("collapses duplicate dates, keeping the last equity that day", () => {
  const ph = {
    timestamp: [sec(2026, 6, 10), sec(2026, 6, 10), sec(2026, 6, 11)],
    equity: [100000, 100250, 101000],
  };
  const series = buildEquityCurve(ph);
  assert.equal(series.length, 2);
  assert.deepEqual(series[0], { date: "2026-06-10", equity: 100250, dayPnl: 0 }); // last reading wins
  assert.deepEqual(series[1], { date: "2026-06-11", equity: 101000, dayPnl: 750 });
});

test("sorts ascending by date regardless of input order", () => {
  const ph = {
    timestamp: [sec(2026, 6, 12), sec(2026, 6, 10), sec(2026, 6, 11)],
    equity: [100800, 100000, 101500],
  };
  const series = buildEquityCurve(ph);
  assert.deepEqual(series.map((p) => p.date), ["2026-06-10", "2026-06-11", "2026-06-12"]);
  assert.equal(series[0].dayPnl, 0);
  assert.equal(series[1].dayPnl, 1500);
});

test("FAIL: skips null/zero/negative equity and non-positive timestamps", () => {
  const ph = {
    timestamp: [sec(2026, 6, 10), sec(2026, 6, 11), 0, sec(2026, 6, 13)],
    equity: [100000, null, 99000, -5],
  };
  // only index 0 survives (1 null equity, 2 zero ts, 3 negative equity)
  const series = buildEquityCurve(ph);
  assert.deepEqual(series, [{ date: "2026-06-10", equity: 100000, dayPnl: 0 }]);
});

test("uses only the overlapping length when arrays are mismatched", () => {
  const ph = {
    timestamp: [sec(2026, 6, 10), sec(2026, 6, 11), sec(2026, 6, 12)],
    equity: [100000, 101000], // shorter — third timestamp has no equity
  };
  const series = buildEquityCurve(ph);
  assert.equal(series.length, 2);
  assert.deepEqual(series.map((p) => p.date), ["2026-06-10", "2026-06-11"]);
});

test("single point → dayPnl 0", () => {
  const series = buildEquityCurve({ timestamp: [sec(2026, 6, 10)], equity: [100000] });
  assert.deepEqual(series, [{ date: "2026-06-10", equity: 100000, dayPnl: 0 }]);
});

test("NULL: empty / missing / null input → [] (no crash)", () => {
  assert.deepEqual(buildEquityCurve({ timestamp: [], equity: [] }), []);
  assert.deepEqual(buildEquityCurve({}), []);
  assert.deepEqual(buildEquityCurve(null), []);
  assert.deepEqual(buildEquityCurve(undefined), []);
  assert.deepEqual(buildEquityCurve({ equity: [100000] }), []);     // no timestamps → undatable
  assert.deepEqual(buildEquityCurve({ timestamp: [sec(2026, 6, 10)] }), []); // no equity
});
