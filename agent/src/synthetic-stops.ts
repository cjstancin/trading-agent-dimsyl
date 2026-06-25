// Synthetic trailing stop (Bull v4) — software-side protection for FRACTIONAL positions, since Alpaca won't
// attach a broker trailing stop to fractional qty. The refresh ritual calls runSyntheticStops() every ~5 min
// during market hours: it tracks each position's high-water mark in memory/stops.json and, if a position falls
// trailPct below its peak, MARKET-sells it (auto mode + trading day only). Coarser than a broker stop (5-min
// cadence, can gap on a fast move) but works on fractional and survives overnight. Whole-share positions that
// still carry a broker stop are covered too as a redundant backstop — whichever fires first (closePosition
// cancels the broker stop), so no double-sell.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { closePosition } from "./alpaca.js";
import { autoExecAllowed } from "./mode.js";

const STATE = fileURLToPath(new URL("../../memory/stops.json", import.meta.url));
const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

export interface StopPosition { symbol: string; price: number; entry: number; qty: number; }
export type StopState = Record<string, { peak: number }>;
export interface StopBreach { symbol: string; price: number; peak: number; qty: number; dropPct: number; }

/** Pure: roll each position's high-water mark forward and flag any that fell ≥ trailPct below its peak.
 *  `next` contains ONLY the current symbols, so sold/closed names are pruned from the state automatically. */
export function evaluateStops(positions: StopPosition[], prev: StopState, trailPct: number): { breaches: StopBreach[]; next: StopState } {
  const next: StopState = {};
  const breaches: StopBreach[] = [];
  const trail = Math.max(0, trailPct) / 100;
  for (const p of positions) {
    if (!(p.price > 0)) continue;
    const sym = p.symbol.toUpperCase();
    const seed = prev[sym]?.peak ?? Math.max(p.entry || 0, p.price); // first sighting: seed peak at entry/price
    const peak = Math.max(seed, p.price);
    next[sym] = { peak };
    if (trail > 0 && peak > 0 && p.price <= peak * (1 - trail)) {
      breaches.push({ symbol: p.symbol, price: p.price, peak, qty: p.qty, dropPct: round(((p.price - peak) / peak) * 100, 1) });
    }
  }
  return { breaches, next };
}

export const readState = (): StopState => { try { return JSON.parse(readFileSync(STATE, "utf8")) as StopState; } catch { return {}; } };

/** Per-position summary line: bought-at, current, unrealized %, and the live synthetic stop level
 *  (peak × (1−trail)). Used by the pre-market brief + notifications so CJ sees entry / now / stop at a glance. */
export function positionLines(rawPositions: Array<Record<string, unknown>>, state: StopState, trailPct: number): string[] {
  const trail = Math.max(0, trailPct) / 100;
  const fmt = (x: number) => (x >= 100 ? x.toFixed(0) : x.toFixed(2));
  return rawPositions.map((p) => {
    const sym = String(p.symbol ?? "");
    const entry = Number(p.avg_entry_price ?? 0);
    const cur = Number(p.current_price ?? 0);
    const plpc = Number(p.unrealized_plpc ?? 0) * 100;
    const peak = Math.max(state[sym.toUpperCase()]?.peak ?? entry, cur, entry);
    const stop = peak * (1 - trail);
    return `${sym}: in $${fmt(entry)} · now $${fmt(cur)} (${plpc >= 0 ? "+" : ""}${plpc.toFixed(1)}%) · stop $${fmt(stop)}`;
  });
}

/** One synthetic-stop pass: peak-track every holding and (auto mode + market open) market-sell breaches. */
export async function runSyntheticStops(opts: {
  rawPositions: Array<Record<string, unknown>>;
  trailPct: number;
  mode: string;
  marketOpen: boolean;
  alert: (msg: string) => Promise<unknown>;
}): Promise<{ tracked: number; breaches: StopBreach[]; sold: string[] }> {
  const positions: StopPosition[] = opts.rawPositions
    .map((p) => ({ symbol: String(p.symbol ?? ""), price: Number(p.current_price ?? 0), entry: Number(p.avg_entry_price ?? 0), qty: Number(p.qty ?? 0) }))
    .filter((p) => p.symbol && p.price > 0);

  const { breaches, next } = evaluateStops(positions, readState(), opts.trailPct);
  const sold: string[] = [];
  const canSell = opts.marketOpen && opts.mode === "auto" && autoExecAllowed();

  for (const b of breaches) {
    if (canSell) {
      try {
        await closePosition(b.symbol);
        sold.push(b.symbol);
        delete next[b.symbol.toUpperCase()]; // closed → drop from state so a re-buy starts a fresh peak
        await opts.alert(`🛑 **Synthetic stop HIT — sold ${b.symbol}** (${b.dropPct}% from peak $${round(b.peak)}, last $${round(b.price)}).`);
      } catch (e) {
        await opts.alert(`⚠️ Synthetic stop tried to sell ${b.symbol} but FAILED: ${String(e instanceof Error ? e.message : e)} — position may be unprotected.`);
      }
    } else {
      await opts.alert(`⚠️ ${b.symbol} breached its synthetic stop (${b.dropPct}% from peak $${round(b.peak)}) — ${opts.marketOpen ? "not in auto mode → NOT sold" : "market closed → will sell at the open"}.`);
    }
  }
  try { writeFileSync(STATE, JSON.stringify(next, null, 2)); } catch { /* best effort */ }
  return { tracked: positions.length, breaches, sold };
}
