// Outcome-feedback loop (Bull learning loop) — PURE render of Bill's OWN closed-trade record into a
// compact prompt block for the SCAN ritual. Bill already MEASURES per-setup expectancy/win-rate
// (attribution.ts over the reconciled ledger) but never READ it back when proposing — so he repeated
// setups regardless of what actually worked. This closes the loop: the scan prompt gets a
// "YOUR TRACK RECORD BY SETUP" block so the model favors proven setups and is wary of
// negative-expectancy ones.
//
// MIN-N GATE (essential): a tag's stat is only surfaced as PROVEN once it has ≥ BULL_MIN_TAG_TRADES
// closed trades (default 8). Below that it renders as "insufficient sample — neutral" so Bill never
// overfits to a 2-trade fluke. ADVISORY ONLY: this informs the model's picks; deterministic sizing
// (risk-engine.ts) is untouched. Reuses attribution.ts — nothing is recomputed here. No network.
import { attribution, type AttributedTrade, type Bucket } from "./attribution.js";

/** Minimum closed trades a setup tag needs before its stats count as signal (below → neutral). */
export const DEFAULT_MIN_TAG_TRADES = 8;

/** Min-N from env (BULL_MIN_TAG_TRADES), defaulting to 8. Garbage / <1 → default. */
export function minTagTrades(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.BULL_MIN_TAG_TRADES);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_MIN_TAG_TRADES;
}

const usd = (n: number) => (n < 0 ? "−$" + Math.abs(n).toFixed(0) : "+$" + n.toFixed(0));

/** Verdict label for a setup bucket under the min-N gate. Pure. */
export function tagVerdict(b: Bucket, minN: number): "proven-positive" | "proven-negative" | "proven-flat" | "insufficient" {
  if (b.count < minN) return "insufficient";
  return b.expectancy > 0 ? "proven-positive" : b.expectancy < 0 ? "proven-negative" : "proven-flat";
}

/**
 * Render the "YOUR TRACK RECORD BY SETUP (closed trades)" prompt block from CLOSED trades (the caller
 * passes reconciled ledger records; open/rejected rows are ignored by attribution()). Returns "" when
 * there is no closed trade yet, so a fresh account adds nothing to the prompt.
 *   • tags with n ≥ minN show win-rate + per-trade expectancy + total P&L and a PROVEN/NEGATIVE verdict
 *   • tags with n < minN show "insufficient sample — treat as neutral" (no stat is actionable)
 *   • a time-of-day line is appended only for entry buckets that also clear min-N
 */
export function renderTrackRecordBlock(trades: AttributedTrade[], minN: number = DEFAULT_MIN_TAG_TRADES): string {
  const attr = attribution(trades ?? []);
  const entries = Object.entries(attr.bySetup);
  if (!entries.length) return "";

  // Proven tags first, best expectancy first; insufficient-sample tags trail (by count desc, then name).
  const rank = (name: string, b: Bucket): [number, number, string] =>
    b.count >= minN ? [0, -b.expectancy, name] : [1, -b.count, name];
  entries.sort((a, b) => {
    const ra = rank(a[0], a[1]), rb = rank(b[0], b[1]);
    return ra[0] - rb[0] || ra[1] - rb[1] || ra[2].localeCompare(rb[2]);
  });

  const lines = entries.map(([name, b]) => {
    const verdict = tagVerdict(b, minN);
    if (verdict === "insufficient") return `• ${name} — ${b.count} closed trade${b.count === 1 ? "" : "s"} (insufficient sample, < ${minN} — NEUTRAL, judge on merit)`;
    const label = verdict === "proven-positive" ? "PROVEN EDGE — favor" : verdict === "proven-negative" ? "NEGATIVE EXPECTANCY — avoid unless exceptional" : "flat — no edge either way";
    return `• ${name} — ${b.count} trades, ${b.winRate}% win, expectancy ${usd(b.expectancy)}/trade, total ${usd(b.totalPnl)}  [${label}]`;
  });

  // Time-of-day (entry, ET) — only buckets that clear the same min-N gate; omit the line entirely otherwise.
  const todParts = Object.entries(attr.byTimeOfDay)
    .filter(([k, b]) => k !== "unknown" && b.count >= minN)
    .sort((a, b) => b[1].expectancy - a[1].expectancy)
    .map(([k, b]) => `${k} ${b.winRate}% win / ${usd(b.expectancy)} per trade (${b.count})`);
  const tod = todParts.length ? `\nBy time-of-day of entry (n ≥ ${minN} only): ${todParts.join(" · ")}` : "";

  return (
    `YOUR TRACK RECORD BY SETUP (closed trades — YOUR OWN results, not opinion). Favor setups with a proven ` +
    `positive expectancy; be wary of proven negative-expectancy ones; "insufficient sample" tags are NEUTRAL ` +
    `(not evidence for or against):\n` + lines.join("\n") + tod
  );
}
