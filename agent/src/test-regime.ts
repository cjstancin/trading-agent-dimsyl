// Unit tests for the PURE 200-DMA regime classification + risk-off entry gate. node:test + synthetic
// close series only — NO network, NO orders. Covers: risk-on / risk-off / neutral classification,
// insufficient-data fail-open, the gate blocking a non-counter-trend long in risk-off, the explicit
// counter-trend exemption, sells untouched, and the BULL_IGNORE_REGIME override.
// Run: npm run test:regime
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeRegime, regimeBlockReason, ignoreRegime, neutralRegime, renderRegimeLine, regimePill, SLOPE_LOOKBACK, type Regime } from "./regime.js";

const N = 200 + SLOPE_LOOKBACK + 10; // enough closes for MA200 + slope
// Steadily rising market: price above a rising 200-DMA → risk-on.
const RISING = Array.from({ length: N }, (_, i) => 100 + i * 0.5);
// Steadily falling market: price below a falling 200-DMA → CONFIRMED risk-off.
const FALLING = Array.from({ length: N }, (_, i) => 300 - i * 0.5);
// Falling market with a sharp final spike: price pops ABOVE the still-falling MA → mixed → neutral.
const SPIKE = [...FALLING.slice(0, N - 1), 400];

test("computeRegime: price ≥ rising 200-DMA → risk-on (with real price/MA values)", () => {
  const r = computeRegime(RISING);
  assert.equal(r.state, "risk-on");
  assert.equal(r.slopeUp, true);
  assert.ok(r.price != null && r.ma200 != null && r.price > r.ma200);
});

test("computeRegime: price < falling 200-DMA → confirmed risk-off", () => {
  const r = computeRegime(FALLING);
  assert.equal(r.state, "risk-off");
  assert.equal(r.slopeUp, false);
  assert.ok(r.price != null && r.ma200 != null && r.price < r.ma200);
});

test("computeRegime: mixed signals (price above a falling MA) → neutral, never blocks", () => {
  const r = computeRegime(SPIKE);
  assert.equal(r.state, "neutral");
  assert.equal(r.slopeUp, false);
  assert.equal(regimeBlockReason({ side: "buy", setup: "momentum breakout" }, r), null);
});

test("computeRegime: insufficient data / empty → neutral fail-open (null MA)", () => {
  for (const closes of [[], RISING.slice(0, 100), [0, -5, NaN] as number[]]) {
    const r = computeRegime(closes);
    assert.equal(r.state, "neutral");
    assert.equal(r.ma200, null);
    assert.equal(regimeBlockReason({ side: "buy" }, r), null);
  }
});

const RISK_OFF: Regime = computeRegime(FALLING);
const RISK_ON: Regime = computeRegime(RISING);

test("regime gate BLOCKS a non-counter-trend long in confirmed risk-off (with an actionable reason)", () => {
  const reason = regimeBlockReason({ side: "buy", setup: "momentum breakout" }, RISK_OFF);
  assert.ok(reason, "expected a block reason");
  assert.match(reason!, /risk-off/);
  assert.match(reason!, /200-DMA/);
  assert.match(reason!, /counter-trend/); // tells the operator how to exempt deliberately
  // untagged setups are blocked too — the exemption must be EXPLICIT
  assert.ok(regimeBlockReason({ side: "buy" }, RISK_OFF));
  assert.ok(regimeBlockReason({ side: "buy", setup: null }, RISK_OFF));
});

test("regime gate ALLOWS the same long in risk-on (and in neutral)", () => {
  assert.equal(regimeBlockReason({ side: "buy", setup: "momentum breakout" }, RISK_ON), null);
  assert.equal(regimeBlockReason({ side: "buy", setup: "momentum breakout" }, neutralRegime()), null);
});

test("explicitly counter-trend-tagged setups pass even in risk-off (spelling variants)", () => {
  for (const setup of ["counter-trend", "Counter Trend bounce", "countertrend mean-revert"]) {
    assert.equal(regimeBlockReason({ side: "buy", setup }, RISK_OFF), null, `expected "${setup}" to pass`);
  }
});

test("sells / exits are NEVER touched by the regime gate (stops keep protecting positions)", () => {
  assert.equal(regimeBlockReason({ side: "sell", setup: "momentum breakout" }, RISK_OFF), null);
});

test("BULL_IGNORE_REGIME override: gate skipped when ignore=true; env parsed strictly", () => {
  assert.equal(regimeBlockReason({ side: "buy", setup: "momentum breakout" }, RISK_OFF, true), null);
  assert.equal(ignoreRegime({ BULL_IGNORE_REGIME: "1" }), true);
  assert.equal(ignoreRegime({ BULL_IGNORE_REGIME: "0" }), false);
  assert.equal(ignoreRegime({}), false);
});

test("renderRegimeLine + regimePill surface the computed value (and fail-open wording)", () => {
  assert.match(renderRegimeLine(RISK_OFF), /^risk-off — SPY \$[\d.]+ below its falling 200-DMA \(\$[\d.]+\)$/);
  assert.match(renderRegimeLine(RISK_ON), /^risk-on — SPY \$[\d.]+ above its rising 200-DMA/);
  assert.match(renderRegimeLine(neutralRegime()), /unavailable \(fail-open/);
  assert.equal(regimePill(RISK_OFF), "Risk-off");
  assert.equal(regimePill(RISK_ON), "Risk-on");
  assert.equal(regimePill(neutralRegime()), "Neutral");
});
