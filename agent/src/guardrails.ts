// Pure, testable guardrail checks for proposed orders — no network, no side effects.
// Mirrors the AGGRESSIVE PAPER limits in Trading-Agent/CLAUDE.md. The execution ritual runs every
// proposed order through validateOrders() before anything is placed, in BOTH gated and auto modes.
import type { OrderRequest } from "./alpaca.js";

export interface Rules {
  maxPositionPct: number; // fraction of equity per position
  maxOpen: number;        // max concurrent open positions
  minPrice: number;       // quality floor
  // Descriptive limits — surfaced in the executor's prompt + the dashboard. validateOrders() enforces
  // only the three hard caps above; these guide sizing/stops and differ per risk profile.
  name?: string;
  riskPerTradePct?: number;
  trailPercent?: number;
  dailyHaltPct?: number;
  monthlyKillPct?: number;
  maxDrawdownFromPeakPct?: number; // halt new entries when equity falls this % below the trailing peak
  fractional?: boolean;            // allow fractional/notional sizing (Alpaca: market + TIF=day only; no broker trailing stop → synthetic)
  coreCount?: number;              // # of high-conviction "core" names that take the bulk of capital; the rest are smaller satellites
}

// Fractional + 10-slot book: ~6 high-conviction CORE names take the bulk, up to 4 smaller SATELLITES round it out.
// maxPositionPct is the per-name ceiling for a max-conviction core name; sizeBuyQty scales lower-conviction names down.
export const AGGRESSIVE_PAPER: Rules = { name: "Aggressive", maxPositionPct: 0.20, maxOpen: 10, minPrice: 10, riskPerTradePct: 5, trailPercent: 20, dailyHaltPct: 5, monthlyKillPct: 20, maxDrawdownFromPeakPct: 15, fractional: true, coreCount: 6 };
export const STEADY_PAPER: Rules = { name: "Steady", maxPositionPct: 0.15, maxOpen: 4, minPrice: 5, riskPerTradePct: 4, trailPercent: 10, dailyHaltPct: 5, monthlyKillPct: 15 };

/** Pick the rulebook for a risk profile ("aggressive" | "steady"). Defaults to aggressive. */
export function rulesFor(profile: string): Rules { return profile === "steady" ? STEADY_PAPER : AGGRESSIVE_PAPER; }

/** Deterministic size (shares) for a buy at `live` price: the smaller of the risk-budget size
 *  (riskPerTradePct of equity ÷ the stop distance) and the CONVICTION-scaled position cap. A max-conviction
 *  (100) name gets the full maxPositionPct cap; a 50-conviction satellite gets half, etc. — so the top ~core
 *  names dominate and the 7th–10th are smaller satellites. Shared by the executor AND the reallocator so a buy
 *  sizes identically wherever it originates. Fractional profiles keep 4-dp precision (buy 0.33 of a $900 name);
 *  whole-share profiles floor to integers. Returns ≥ 0. */
export function sizeBuyQty(live: number, equity: number, rules: Rules = AGGRESSIVE_PAPER, conviction = 100): number {
  if (!(live > 0) || !(equity > 0)) return 0;
  const trailPct = (rules.trailPercent ?? 20) / 100;
  const riskPct = (rules.riskPerTradePct ?? 7) / 100;
  const convFactor = Math.max(0, Math.min(1, conviction / 100));
  const riskShares = trailPct > 0 ? (riskPct * equity) / (live * trailPct) : Infinity;
  const capShares = (rules.maxPositionPct * equity * convFactor) / live;
  const raw = Math.max(0, Math.min(riskShares, capShares));
  return rules.fractional ? Math.round(raw * 1e4) / 1e4 : Math.floor(raw);
}

export interface BookState {
  equity: number;
  openCount: number; // current open positions
}

export interface ValidatedOrder {
  order: OrderRequest;
  ok: boolean;
  reasons: string[]; // why it failed (empty if ok)
}

/** Validate a batch of proposed orders against the rulebook + current book. Counts cumulative new buys vs maxOpen. */
export function validateOrders(orders: OrderRequest[], book: BookState, rules: Rules = AGGRESSIVE_PAPER): ValidatedOrder[] {
  let projectedOpen = book.openCount;
  return orders.map((order) => {
    const reasons: string[] = [];

    if (!order.symbol || !/^[A-Z][A-Z0-9.\/-]{0,9}$/.test(order.symbol)) reasons.push("bad symbol");
    if (!(order.qty > 0)) reasons.push("qty must be > 0");
    if (!(order.est_price > 0)) reasons.push("est_price required (> 0)");
    if (order.type && !["market", "limit"].includes(order.type)) reasons.push(`order type "${order.type}" not allowed — equities only (market/limit), no options/derivatives`);

    if (order.side === "buy") {
      if (order.est_price < rules.minPrice) reasons.push(`price < $${rules.minPrice} quality floor`);
      const notional = order.est_price * order.qty;
      if (book.equity > 0 && notional / book.equity > rules.maxPositionPct + 1e-9) {
        reasons.push(`position ${(100 * notional / book.equity).toFixed(0)}% > ${100 * rules.maxPositionPct}% cap`);
      }
      if (order.trail_percent == null) reasons.push("buy needs a protective stop (trail_percent)");
      // Only a buy that clears every other check consumes an open slot. An invalid buy is rejected and
      // never placed, so counting it toward the cap would wrongly push later VALID buys over maxOpen.
      if (reasons.length === 0) {
        projectedOpen += 1;
        if (projectedOpen > rules.maxOpen) reasons.push(`would exceed max ${rules.maxOpen} open positions`);
      }
    }

    if (order.type === "limit" && order.limit_price == null) reasons.push("limit order needs limit_price");

    return { order, ok: reasons.length === 0, reasons };
  });
}

/** Risk-halt context (Bull v3): the numbers that gate whether Bill opens NEW positions this cycle. */
export interface HaltCtx {
  dayPnlPct: number;                   // today's equity change %
  monthPnlPct: number | null;          // month-to-date %; null when unknown
  drawdownFromPeakPct: number | null;  // % below the trailing-window equity peak (≤ 0); null when unknown
}

/**
 * Hard risk halt — returns a reason to STOP opening new positions, or null to proceed. The daily-loss gate
 * (from the account) is always checked and stops a bad day cold; monthly + drawdown are checked only when
 * known (null = data unavailable → skip that gate, never block on a data hiccup). Pure + testable.
 */
export function haltReason(c: HaltCtx, rules: Rules = AGGRESSIVE_PAPER): string | null {
  const daily = -(rules.dailyHaltPct ?? 8);
  const monthly = -(rules.monthlyKillPct ?? 25);
  const dd = -(rules.maxDrawdownFromPeakPct ?? 15);
  if (c.dayPnlPct <= daily) return `daily-loss halt: ${c.dayPnlPct.toFixed(1)}% ≤ ${daily}% today`;
  if (c.monthPnlPct != null && c.monthPnlPct <= monthly) return `monthly kill-switch: ${c.monthPnlPct.toFixed(1)}% MTD ≤ ${monthly}%`;
  if (c.drawdownFromPeakPct != null && c.drawdownFromPeakPct <= dd) return `drawdown halt: ${c.drawdownFromPeakPct.toFixed(1)}% from peak ≤ ${dd}%`;
  return null;
}
