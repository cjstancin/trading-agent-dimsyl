// Bull v2 — Wildcard churn engine (design §6). PURE and CODE-ENFORCED — the model proposes, this
// module disposes. The four locked rules:
//   · min 4-week hold ABSENT INVALIDATION — a held name can't be swapped out before minHoldWeeks
//     unless its own pre-written invalidation level is breached (breach overrides the clock: the
//     model told us at pick time what price voids the thesis, and we believe it).
//   · 4-week re-entry cooldown — a sold name can't be rebought for reentryCooldownWeeks. Sleeve-
//     level and P&L-blind (the gateway's 31-day wash blacklist is the separate loss-only rail).
//   · held names re-checked ONLY against their OWN invalidation — never re-litigated. They were
//     excluded from the pool sent to the model; here the ONLY question code asks about a held name
//     is "price vs its original invalidation_level". Absence from this week's picks is NOT a sell
//     signal by itself.
//   · max 1 DISCRETIONARY change/week — a model response demanding 3 swaps executes exactly the
//     single highest-ranked one; the rest land in `blocked` for the audit row.
//
// What counts against the change budget: rank-driven SWAPS (sell a healthy held name to make room
// for a new pick). What doesn't: invalidation-breach exits (safety exits must never queue behind a
// churn budget) and slot-FILLS into open capacity (bootstrap, count growth, refilling a freed slot
// — blocking those would leave the sleeve structurally under-deployed; the anti-churn rule is about
// swapping holdings, not about being invested at all).
import { addDays } from "../../lots.js";
import type { ValidatedPick } from "./types.js";

/** Whole weeks between two ET date keys (floor). Noon-UTC anchors — immune to DST date-shift. */
export function weeksBetween(fromKey: string, toKey: string): number {
  const a = new Date(fromKey + "T12:00:00Z").getTime();
  const b = new Date(toKey + "T12:00:00Z").getTime();
  return Math.floor((b - a) / (7 * 86_400_000));
}

/** Date key `weeks` back from `dateKey` — the cooldown window's left edge. */
export function weeksAgo(dateKey: string, weeks: number): string {
  return addDays(dateKey, -7 * weeks);
}

export interface HeldInput {
  symbol: string;
  enteredOn: string;             // ET date key
  invalidationLevel: number;     // ORIGINAL, from the pick
  latestPrice: number | null;    // broker API at call time; null = unknown → treated as NOT breached
                                 // (fail-safe: never sell on missing data; the ATR stop is the backstop)
}

export interface SoldInput { symbol: string; exitedOn: string }

export interface ChurnConfig {
  minHoldWeeks: number;
  reentryCooldownWeeks: number;
  maxChangesPerWeek: number;
}

export interface ChurnInput {
  asOfDate: string;              // ET date key of this weekly run
  held: HeldInput[];             // ACTIVE positions only (no pendingExit / stopFired rows)
  picks: ValidatedPick[];        // validated, rank-sorted, new names only (pool excluded held)
  recentSells: SoldInput[];      // exits inside (at least) the cooldown window
  targetCount: number;           // pickCount(config, sleeve equity)
  cfg: ChurnConfig;
}

export interface ChurnPlan {
  sells: { symbol: string; reason: "invalidation_breach" | "swap" }[];
  buys: { pick: ValidatedPick; slot: "fill" | "swap" }[];
  blocked: { symbol: string; why: string }[];   // every refused model demand, for the audit row
}

export function planChurn(input: ChurnInput): ChurnPlan {
  const { asOfDate, cfg } = input;
  const plan: ChurnPlan = { sells: [], buys: [], blocked: [] };

  // --- 1. Forced exits: invalidation breach (price at/below the pre-written level). Overrides
  //        min-hold, exempt from the change budget — the model's own exit line fired.
  const survivors: HeldInput[] = [];
  for (const h of input.held) {
    if (h.latestPrice !== null && h.latestPrice <= h.invalidationLevel) {
      plan.sells.push({ symbol: h.symbol, reason: "invalidation_breach" });
    } else {
      survivors.push(h);
    }
  }

  // --- 2. Eligible incoming picks: not held, not inside the re-entry cooldown. Names sold THIS run
  //        (breach exits above) enter cooldown immediately — no same-run round trip.
  const heldSyms = new Set(input.held.map((h) => h.symbol));
  const cooldownEdge = weeksAgo(asOfDate, cfg.reentryCooldownWeeks);
  const cooling = new Set(
    input.recentSells
      .filter((s) => s.exitedOn > cooldownEdge && weeksBetween(s.exitedOn, asOfDate) < cfg.reentryCooldownWeeks)
      .map((s) => s.symbol),
  );
  for (const s of plan.sells) cooling.add(s.symbol);

  const eligible: ValidatedPick[] = [];
  for (const p of input.picks) {
    if (heldSyms.has(p.ticker)) { plan.blocked.push({ symbol: p.ticker, why: "already held" }); continue; }
    if (cooling.has(p.ticker)) { plan.blocked.push({ symbol: p.ticker, why: "re-entry cooldown" }); continue; }
    eligible.push(p);   // already rank-sorted by the validator
  }

  // --- 3. Fill open capacity (bootstrap / freed slots / count growth) — best rank first, unlimited.
  let slotsOpen = input.targetCount - survivors.length;
  while (slotsOpen > 0 && eligible.length > 0) {
    plan.buys.push({ pick: eligible.shift()!, slot: "fill" });
    slotsOpen--;
  }

  // --- 4. Discretionary swaps, budget-capped. Displace the survivor with the WEAKEST claim to its
  //        slot: smallest headroom above its own invalidation (fraction of price), ties → oldest.
  //        Only survivors past min-hold are displaceable — the 4-week clock is absolute here.
  let budget = cfg.maxChangesPerWeek;
  const displaceable = survivors
    .filter((h) => weeksBetween(h.enteredOn, asOfDate) >= cfg.minHoldWeeks)
    .sort((a, b) => headroom(a) - headroom(b) || (a.enteredOn < b.enteredOn ? -1 : 1));

  for (const p of eligible) {
    if (budget <= 0) { plan.blocked.push({ symbol: p.ticker, why: "max changes/week reached" }); continue; }
    const out = displaceable.shift();
    if (!out) { plan.blocked.push({ symbol: p.ticker, why: "no held name past min-hold to displace" }); continue; }
    plan.sells.push({ symbol: out.symbol, reason: "swap" });
    plan.buys.push({ pick: p, slot: "swap" });
    budget--;
  }

  return plan;
}

/** Fractional distance of price above the invalidation level. Unknown price → +∞ (never the first
 *  choice to displace — we don't evict a name we can't currently price). */
function headroom(h: HeldInput): number {
  if (h.latestPrice === null || h.latestPrice <= 0) return Infinity;
  return (h.latestPrice - h.invalidationLevel) / h.latestPrice;
}
