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
}

export const AGGRESSIVE_PAPER: Rules = { name: "Aggressive", maxPositionPct: 0.30, maxOpen: 8, minPrice: 10, riskPerTradePct: 7, trailPercent: 20, dailyHaltPct: 8, monthlyKillPct: 25 };
export const STEADY_PAPER: Rules = { name: "Steady", maxPositionPct: 0.15, maxOpen: 4, minPrice: 5, riskPerTradePct: 4, trailPercent: 10, dailyHaltPct: 5, monthlyKillPct: 15 };

/** Pick the rulebook for a risk profile ("aggressive" | "steady"). Defaults to aggressive. */
export function rulesFor(profile: string): Rules { return profile === "steady" ? STEADY_PAPER : AGGRESSIVE_PAPER; }

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

    if (order.side === "buy") {
      if (order.est_price < rules.minPrice) reasons.push(`price < $${rules.minPrice} quality floor`);
      const notional = order.est_price * order.qty;
      if (book.equity > 0 && notional / book.equity > rules.maxPositionPct + 1e-9) {
        reasons.push(`position ${(100 * notional / book.equity).toFixed(0)}% > ${100 * rules.maxPositionPct}% cap`);
      }
      if (order.trail_percent == null) reasons.push("buy needs a protective stop (trail_percent)");
      projectedOpen += 1;
      if (projectedOpen > rules.maxOpen) reasons.push(`would exceed max ${rules.maxOpen} open positions`);
    }

    if (order.type === "limit" && order.limit_price == null) reasons.push("limit order needs limit_price");

    return { order, ok: reasons.length === 0, reasons };
  });
}
