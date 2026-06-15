// Unit tests for the PURE maeMfe excursion math (Bull backlog #12). node:test + mocked bars only — NO
// network, NO orders. Covers long, short, gap-up/down, and degenerate inputs. Run: npm run test:mae-mfe
import { test } from "node:test";
import assert from "node:assert/strict";
import { maeMfe } from "./mae-mfe.js";

test("long: MAE = entry→lowest low, MFE = entry→highest high", () => {
  // entry 100; window low 90, high 120.
  const bars = [{ h: 110, l: 95 }, { h: 120, l: 90 }, { h: 115, l: 98 }];
  const ex = maeMfe(100, "long", bars);
  assert.equal(ex.maeUsd, -10);   // 90 - 100
  assert.equal(ex.maePct, -10);
  assert.equal(ex.mfeUsd, 20);    // 120 - 100
  assert.equal(ex.mfePct, 20);
});

test("short: adverse is the high, favorable is the low (signs mirror the long)", () => {
  const bars = [{ h: 110, l: 95 }, { h: 120, l: 90 }];
  const ex = maeMfe(100, "short", bars);
  assert.equal(ex.maeUsd, -20);   // 100 - 120 (price rose against the short)
  assert.equal(ex.maePct, -20);
  assert.equal(ex.mfeUsd, 10);    // 100 - 90 (price fell in favor)
  assert.equal(ex.mfePct, 10);
});

test("long gap-up: never trades below entry → MAE is the least-favorable extreme (> 0)", () => {
  // entry 100, whole window gapped above: lows 102/105, highs up to 115.
  const bars = [{ h: 108, l: 102 }, { h: 115, l: 105 }];
  const ex = maeMfe(100, "long", bars);
  assert.equal(ex.maeUsd, 2);     // 102 - 100 — position never went underwater
  assert.equal(ex.mfeUsd, 15);    // 115 - 100
});

test("short gap-down: never trades above entry → adverse extreme is still favorable (MAE > 0)", () => {
  // entry 100, window gapped below (good for a short): highs 95/98, lows 88/90.
  const bars = [{ h: 95, l: 90 }, { h: 98, l: 88 }];
  const ex = maeMfe(100, "short", bars);
  assert.equal(ex.maeUsd, 2);     // 100 - 98 — worst (highest) price still below entry
  assert.equal(ex.mfeUsd, 12);    // 100 - 88
});

test("empty bars → zeros (no data, no excursion)", () => {
  assert.deepEqual(maeMfe(100, "long", []), { maePct: 0, maeUsd: 0, mfePct: 0, mfeUsd: 0 });
});

test("zero/invalid entry → zeros (no division by zero)", () => {
  assert.deepEqual(maeMfe(0, "long", [{ h: 110, l: 90 }]), { maePct: 0, maeUsd: 0, mfePct: 0, mfeUsd: 0 });
});

test("non-finite/zero bar fields are ignored; the clean bar drives the result", () => {
  const bars = [{ h: NaN as unknown as number, l: 0 }, { h: 120, l: 90 }];
  const ex = maeMfe(100, "long", bars);
  assert.equal(ex.mfeUsd, 20);
  assert.equal(ex.maeUsd, -10);
});
