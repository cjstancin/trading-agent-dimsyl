// Unit tests for the PURE excursion (MAE/MFE) reporting analytics. node:test + a small synthetic journal set
// only — NO network, NO orders. Covers presence detection (entries without MAE/MFE fields are excluded), the
// averaging math, the capture-ratio formula (sum pnlPct / sum mfePct over favorable trades, integer %), the
// divide-by-zero guard, the empty case, and both renderers. Run: npm run test:excursion-stats
import { test } from "node:test";
import assert from "node:assert/strict";
import { excursionSummary, hasExcursion, renderExcursionFooter, renderExcursionLines } from "./excursion-stats.js";

// Three closed trades WITH excursion data + one journaled close WITHOUT (bars were unavailable → no fields).
const TRADES = [
  { symbol: "TSLA", closedAt: "2026-06-15T20:00:00Z", pnlPct: 3.0, maePct: -1.0, maeUsd: -2.0, mfePct: 4.0, mfeUsd: 8.0 },
  { symbol: "NVDA", closedAt: "2026-06-16T20:00:00Z", pnlPct: -2.0, maePct: -3.0, maeUsd: -1.5, mfePct: 2.0, mfeUsd: 1.0 },
  { symbol: "AAPL", closedAt: "2026-06-17T20:00:00Z", pnlPct: 1.0, maePct: -0.5, maeUsd: -0.5, mfePct: 4.0, mfeUsd: 4.0 },
  { symbol: "MSFT", closedAt: "2026-06-14T20:00:00Z", pnlPct: 0.5 }, // no excursion fields — EXCLUDED
];

test("hasExcursion: true iff at least one MAE/MFE field is finite", () => {
  assert.equal(hasExcursion(TRADES[0]), true);
  assert.equal(hasExcursion(TRADES[3]), false);
  assert.equal(hasExcursion({ symbol: "X", maePct: 0 }), true); // a literal 0 is real data, not "absent"
  assert.equal(hasExcursion(null), false);
});

test("excursionSummary: averages only excursion-bearing trades, capture = ΣpnlPct/ΣmfePct over favorable", () => {
  const s = excursionSummary(TRADES);
  assert.equal(s.trades, 3);                       // MSFT excluded
  assert.equal(s.avgMaePct, -1.5);                 // mean(-1, -3, -0.5)
  assert.equal(s.avgMaeUsd, -1.33);                // mean(-2, -1.5, -0.5) = -1.333 → -1.33
  assert.equal(s.avgMfePct, 3.33);                 // mean(4, 2, 4) = 3.333 → 3.33
  assert.equal(s.avgMfeUsd, 4.33);                 // mean(8, 1, 4) = 4.333 → 4.33
  // capture: ΣpnlPct=(3-2+1)=2 over ΣmfePct=(4+2+4)=10 → 20%
  assert.equal(s.captureRatio, 20);
});

test("capture ratio guards against zero favorable room (no divide blow-up)", () => {
  const flat = [{ symbol: "Z", pnlPct: 1, maePct: -1, maeUsd: -1, mfePct: 0, mfeUsd: 0 }];
  const s = excursionSummary(flat);
  assert.equal(s.trades, 1);
  assert.equal(s.captureRatio, 0);                 // ΣmfePct = 0 → 0, not NaN/Infinity
});

test("empty / no-excursion input → fully zeroed summary (no crash)", () => {
  assert.deepEqual(excursionSummary([]), { trades: 0, avgMaePct: 0, avgMaeUsd: 0, avgMfePct: 0, avgMfeUsd: 0, captureRatio: 0 });
  assert.equal(excursionSummary([TRADES[3]]).trades, 0); // only the field-less entry → excluded
});

test("renderExcursionFooter: empty when no data, formatted summary line otherwise", () => {
  assert.equal(renderExcursionFooter(excursionSummary([])), "");
  const footer = renderExcursionFooter(excursionSummary(TRADES));
  assert.match(footer, /^🎯 Excursion \(MAE\/MFE\): /);
  assert.match(footer, /avg MAE −1\.5% \/ MFE \+3\.3%/);
  assert.match(footer, /capture 20% \(3 trades\)/);
});

test("renderExcursionLines: one line per excursion-bearing trade, field-less excluded, limit respected", () => {
  const lines = renderExcursionLines(TRADES);
  assert.equal(lines.length, 3);                   // MSFT (no fields) excluded
  assert.equal(lines[0], "   • TSLA: MAE −1.0% (−$2.00) / MFE +4.0% (+$8.00)");
  assert.equal(renderExcursionLines(TRADES, 1).length, 1);
  assert.deepEqual(renderExcursionLines([]), []);
});
