// Bill's RANK readout — read-only, places NO orders. Shows EXACTLY how the rotation engine ranks every
// holding right now: strength (the number it sorts "weakest first" by) and its components — entry conviction
// + live-P&L tilt — plus days held, market value, and which name is the weakest (the swap target). The
// rotation cuts the weakest ONLY if today's fresh research finds an idea beating it by ≥ minConvictionEdge.
// Run: npm run rank. The helpers are reused by the rotation ritual to post this ranking to #trade-bot each pass.
import "./load-env.js";
import { paperSnapshot, getActivities } from "./alpaca.js";
import { rulesFor, type Rules } from "./guardrails.js";
import { getProfile } from "./profile.js";
import { readLedger } from "./ledger.js";
import { holdingStrength, DEFAULT_REALLOC, type Holding } from "./reallocate.js";
import { installSafetyNet } from "./http-utils.js";

export interface RankedHolding {
  symbol: string;
  strength: number;
  entryConv: number | null; // entry conviction from the ledger (null → P&L proxy was used)
  pnlPct: number;           // unrealized P&L percent, e.g. -9.4
  tilt: number;             // strength adjustment from live P&L (losses ×2, gains ×1 capped +15)
  marketValue: number;
  ageDays: number | null;   // days held (null if not in the fills window)
  protectedWinner: boolean; // up more than protectWinnersAbovePct → never swapped out
}

const round = (x: number, d = 0) => Math.round(x * 10 ** d) / 10 ** d;

/** Earliest BUY-fill timestamp per symbol → days held (null if not found in the activities window). */
export async function holdingAgesDays(symbols: string[]): Promise<Record<string, number | null>> {
  const out: Record<string, number | null> = {};
  for (const s of symbols) out[s.toUpperCase()] = null;
  try {
    const acts = (await getActivities("FILL")) as Array<Record<string, unknown>>;
    const earliest: Record<string, number> = {};
    for (const a of Array.isArray(acts) ? acts : []) {
      if (String(a.side ?? "").toLowerCase() !== "buy") continue;
      const sym = String(a.symbol ?? "").toUpperCase();
      const t = Date.parse(String(a.transaction_time ?? ""));
      if (!Number.isFinite(t)) continue;
      if (earliest[sym] == null || t < earliest[sym]) earliest[sym] = t;
    }
    const now = Date.now();
    for (const s of symbols) {
      const sym = s.toUpperCase();
      if (earliest[sym] != null) out[sym] = Math.max(0, (now - earliest[sym]) / 86_400_000);
    }
  } catch { /* leave nulls — age unavailable */ }
  return out;
}

/** Rank holdings weakest → strongest, exposing each strength's components (for transparency). */
export function rankHoldings(holdings: Holding[], ages: Record<string, number | null>, cfg = DEFAULT_REALLOC): RankedHolding[] {
  return holdings
    .map((h) => {
      const pnlPct = h.unrealizedPlPct * 100;
      const tilt = pnlPct < 0 ? pnlPct * 2 : Math.min(pnlPct, 15);
      return {
        symbol: h.symbol,
        strength: holdingStrength(h),
        entryConv: typeof h.score === "number" ? h.score : null,
        pnlPct,
        tilt,
        marketValue: h.marketValue,
        ageDays: ages[h.symbol.toUpperCase()] ?? null,
        protectedWinner: h.unrealizedPlPct > cfg.protectWinnersAbovePct,
      };
    })
    .sort((a, b) => a.strength - b.strength);
}

/** Format the ranking as Discord/console lines (weakest first, with each strength broken down). */
export function formatRankingLines(ranked: RankedHolding[], rules: Rules, cfg = DEFAULT_REALLOC): string[] {
  const lines = [
    `🔢 **Bill — holding ranking** (weakest first · ${rules.name})`,
    `_Cuts the weakest only if today's research finds an idea beating it by ≥${cfg.minConvictionEdge}. Winners up >${Math.round(cfg.protectWinnersAbovePct * 100)}% are protected (let them run)._`,
  ];
  ranked.forEach((r, i) => {
    const base = r.entryConv != null ? `conv ${r.entryConv}` : "P&L-proxy";
    const tiltStr = r.tilt === 0 ? "±0" : r.tilt > 0 ? `+${round(r.tilt)}` : `${round(r.tilt)}`;
    const age = r.ageDays == null ? "?" : r.ageDays < 1 ? "<1d" : `${round(r.ageDays)}d`;
    const tag = r.protectedWinner ? " 🛡️ winner (protected)" : i === 0 ? " ⚠️ weakest (next to go)" : "";
    lines.push(`  ${i + 1}. ${r.symbol}  str ${round(r.strength)} = ${base} ${tiltStr} (P&L ${round(r.pnlPct, 1)}%) · held ${age} · $${round(r.marketValue)}${tag}`);
  });
  return lines;
}

// ── CLI (npm run rank) — only when run directly, not when imported by the rotation ritual ──
if (process.argv[1]?.endsWith("run-rank.ts")) {
  installSafetyNet("bill-rank");
  const rules = rulesFor(getProfile());
  const snap = await paperSnapshot();
  if (!snap.connected) { console.error(JSON.stringify({ ok: false, reason: "Alpaca not reachable", error: snap.error })); process.exit(1); }
  const positions = (Array.isArray(snap.positions) ? snap.positions : []) as Array<Record<string, unknown>>;
  const ledger = readLedger();
  const lastConfidence = (sym: string): number | undefined => {
    for (let i = ledger.length - 1; i >= 0; i--) { const r = ledger[i]; if (r.symbol === sym && typeof r.confidence === "number") return r.confidence; }
    return undefined;
  };
  const holdings: Holding[] = positions.map((p) => ({
    symbol: String(p.symbol), marketValue: Number(p.market_value ?? 0),
    unrealizedPlPct: Number(p.unrealized_plpc ?? 0), score: lastConfidence(String(p.symbol)),
  }));
  const ages = await holdingAgesDays(holdings.map((h) => h.symbol));
  const ranked = rankHoldings(holdings, ages);
  const lines = formatRankingLines(ranked, rules);
  // Narrative: contrast the biggest $ loser with the engine's weakest-by-strength (why they can differ).
  const byLoss = [...ranked].sort((a, b) => a.pnlPct - b.pnlPct)[0];
  const weakest = ranked[0];
  if (byLoss && weakest && byLoss.symbol !== weakest.symbol) {
    lines.push("", `ℹ️ Biggest loser is ${byLoss.symbol} (${round(byLoss.pnlPct, 1)}%), but the engine's weakest is ${weakest.symbol} (str ${round(weakest.strength)}). ${byLoss.symbol} ranks higher (str ${round(byLoss.strength)}) because its entry conviction (${byLoss.entryConv ?? "n/a"}) offsets the loss — it cuts the weakest THESIS, not the biggest raw loss.`);
  }
  console.log(lines.join("\n"));
}
