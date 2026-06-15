// Pure, testable position-swap + reallocation planner — no network, no order placement, no side effects.
// Sister module to guardrails.ts: it answers ONE question deterministically — when the book is full
// (at maxOpen) and the scan surfaces a higher-conviction new idea, which weak holding (if any) should
// we swap out to fund it? It only PROPOSES swaps; sizing + placement stay in the existing executor
// pipeline (run-execute.ts), which still runs every resulting order through validateOrders().
//
// Conservative by design, honoring CLAUDE.md's hard rules:
//   • "Let winners run" → a holding up more than protectWinnersAbovePct is PROTECTED, never swapped out.
//   • Quality over churn → at most maxSwapsPerCycle swaps per cycle.
//   • A new idea must beat the weakest holding's strength by a real margin (minConvictionEdge) — no
//     marginal rotation. If nothing clears the bar, the plan is empty (hold the current book).

export interface Holding {
  symbol: string;
  marketValue: number;     // current $ value of the position (from Alpaca market_value)
  unrealizedPlPct: number; // unrealized P&L as a fraction, e.g. -0.12 for -12% (Alpaca unrealized_plpc)
  score?: number;          // 0–100 strength (original conviction from the ledger). Falls back to a
                           // thesis-health proxy derived from unrealizedPlPct when absent.
}

export interface Candidate {
  symbol: string;
  conviction: number;      // 0–100 conviction of the new idea (from the scan / approved cycle)
  thesis?: string;
  setup?: string;          // setup label, e.g. "momentum breakout"
}

export interface SwapProposal {
  sell: { symbol: string; marketValue: number; score: number };
  buy: { symbol: string; conviction: number; thesis?: string; setup?: string };
  edge: number;            // candidate.conviction − holding.strength (how much stronger the new idea is)
  rationale: string;
}

export interface ReallocationPlan {
  needed: boolean;         // true when the book is full so a swap is the ONLY way to add a name
  swaps: SwapProposal[];   // proposed 1:1 swaps (sell weak → buy strong). Empty = hold current book.
  skipped: Array<{ symbol: string; reason: string }>; // candidates/holdings excluded, with why
  notes: string[];         // human-readable summary lines
}

export interface ReallocConfig {
  minConvictionEdge: number;      // candidate must beat the weakest holding's strength by ≥ this (points)
  maxSwapsPerCycle: number;       // cap churn — at most this many swaps proposed per cycle
  protectWinnersAbovePct: number; // never swap out a holding up more than this (fraction). Let winners run.
}

// Tuned conservative: a new idea needs a clear 15-point conviction edge over the weakest name, no more
// than 2 swaps per cycle, and any holding up >15% is protected (let winners run, per CLAUDE.md).
export const DEFAULT_REALLOC: ReallocConfig = { minConvictionEdge: 15, maxSwapsPerCycle: 2, protectWinnersAbovePct: 0.15 };

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

/** A holding's 0–100 strength. Uses the original conviction (score) when present; otherwise a
 *  thesis-health proxy from unrealized P&L: flat = 50, each +1% = +1 point (so −20% → 30, +30% → 80). */
export function holdingStrength(h: Holding): number {
  if (typeof h.score === "number" && Number.isFinite(h.score) && h.score >= 0) return clamp(h.score, 0, 100);
  return clamp(50 + h.unrealizedPlPct * 100, 0, 100);
}

/**
 * Plan position swaps. Returns a proposal-only plan — it never places or sizes orders.
 *
 * @param holdings    current open positions
 * @param candidates  new ideas competing for a slot (with 0–100 conviction)
 * @param book        { maxOpen } — the active rulebook's position cap
 * @param cfg         thresholds (defaults to DEFAULT_REALLOC)
 */
export function planReallocation(
  holdings: Holding[],
  candidates: Candidate[],
  book: { maxOpen: number },
  cfg: ReallocConfig = DEFAULT_REALLOC,
): ReallocationPlan {
  const notes: string[] = [];
  const swaps: SwapProposal[] = [];
  const skipped: Array<{ symbol: string; reason: string }> = [];

  // NULL: no candidates → nothing to reallocate.
  if (!candidates || candidates.length === 0) {
    return { needed: false, swaps, skipped, notes: ["no candidate ideas — nothing to reallocate"] };
  }

  const held = new Set(holdings.map((h) => h.symbol.toUpperCase()));
  const needed = holdings.length >= book.maxOpen;

  // A candidate we already hold can't be swapped INTO — drop it up front, then rank by conviction.
  const freshCandidates = candidates
    .filter((c) => {
      if (held.has(c.symbol.toUpperCase())) { skipped.push({ symbol: c.symbol, reason: "already held" }); return false; }
      return true;
    })
    .sort((a, b) => b.conviction - a.conviction);

  if (!needed) {
    notes.push(`book has room (${holdings.length}/${book.maxOpen} open) — buy directly, no swap required`);
    return { needed, swaps, skipped, notes };
  }
  notes.push(`book is FULL (${holdings.length}/${book.maxOpen}) — a swap is required to add a new name`);

  // Swap-out pool: weakest first, excluding winners we want to let run.
  const swappable = holdings
    .map((h) => ({ h, strength: holdingStrength(h) }))
    .filter((x) => {
      if (x.h.unrealizedPlPct > cfg.protectWinnersAbovePct) {
        skipped.push({ symbol: x.h.symbol, reason: `winner up ${(x.h.unrealizedPlPct * 100).toFixed(0)}% — let it run (protected)` });
        return false;
      }
      return true;
    })
    .sort((a, b) => a.strength - b.strength);

  const usedHoldings = new Set<string>();
  for (const c of freshCandidates) {
    if (swaps.length >= cfg.maxSwapsPerCycle) { skipped.push({ symbol: c.symbol, reason: `max ${cfg.maxSwapsPerCycle} swaps/cycle reached` }); continue; }
    const weakest = swappable.find((x) => !usedHoldings.has(x.h.symbol.toUpperCase()));
    if (!weakest) { skipped.push({ symbol: c.symbol, reason: "no swappable holding (all protected or already paired)" }); continue; }

    const edge = c.conviction - weakest.strength;
    if (edge < cfg.minConvictionEdge) {
      skipped.push({ symbol: c.symbol, reason: `conviction ${c.conviction} doesn't beat ${weakest.h.symbol} (strength ${weakest.strength.toFixed(0)}) by ≥${cfg.minConvictionEdge}` });
      continue;
    }

    usedHoldings.add(weakest.h.symbol.toUpperCase());
    swaps.push({
      sell: { symbol: weakest.h.symbol, marketValue: round(weakest.h.marketValue), score: round(weakest.strength) },
      buy: { symbol: c.symbol, conviction: c.conviction, thesis: c.thesis, setup: c.setup },
      edge: round(edge),
      rationale: `swap ${weakest.h.symbol} (strength ${weakest.strength.toFixed(0)}) → ${c.symbol} (conviction ${c.conviction}); +${edge.toFixed(0)} conviction edge`,
    });
  }

  if (swaps.length === 0) notes.push("book full but no candidate cleared the swap bar — hold the current book");
  return { needed, swaps, skipped, notes };
}
