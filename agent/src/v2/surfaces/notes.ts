// Bull v2 — per-trade Discord notes (design §9). One line per action, sleeve-tagged, with the
// honest one-liner thesis and the protection state. Pure formatters — the ritual pipes them to
// postBill after fills confirm (a note NEVER claims an order that didn't verify; the v1 lesson).
import { SLEEVE_NAMES, type OrderOwner } from "./../types.js";

export interface TradeNoteInput {
  sleeve: OrderOwner;
  symbol: string;
  side: "buy" | "sell";
  intent: string;               // buy | sell | trim | stop | sweep
  qty?: string;                 // decimal string (display)
  notional?: string;            // decimal string USD
  fillPrice?: string;
  thesis?: string;              // one-liner
  protection?: string;          // e.g. "ATR stop 8.42 (ratchets)" | "−25% floor 7.50" | "rank-out exit"
  reason?: string;              // exits: rank_out | horizon | reversal | thesis_break | dial-trim …
}

const ACTION_EMOJI: Record<string, string> = { buy: "🟢", sell: "🔴", trim: "✂️", stop: "🛡️", sweep: "💤" };

export function tradeNote(t: TradeNoteInput): string {
  const tag = `[${SLEEVE_NAMES[t.sleeve] ?? t.sleeve}]`;
  const emoji = ACTION_EMOJI[t.intent] ?? (t.side === "buy" ? "🟢" : "🔴");
  const size = t.notional ? `$${t.notional}` : t.qty ? `${t.qty} sh` : "";
  const px = t.fillPrice ? ` @ ${t.fillPrice}` : "";
  const head = `${emoji} ${tag} ${t.side.toUpperCase()} ${t.symbol} ${size}${px}`.trim();
  const why = t.reason ? ` — ${t.reason.replace(/_/g, " ")}` : t.thesis ? ` — ${t.thesis}` : "";
  const prot = t.protection ? ` · ${t.protection}` : "";
  return `${head}${why}${prot}`;
}

export interface EscalationInput {
  kind: string;                 // brake-tier3 | thesis-escalation | anchor-drift | mom-universe-delta …
  title: string;
  detail?: string;
}

/** "Needs your call" ping — every approvals-queue insert gets one of these. */
export function escalationNote(e: EscalationInput): string {
  return `🚨 **Needs your call** (${e.kind}): ${e.title}${e.detail ? `\n> ${e.detail}` : ""}\n> Resolve in the Bull console approvals queue.`;
}

/** Skipped-order transparency line (the v1 failure mode was silent 403 storms — never again). */
export function skipNote(sleeve: OrderOwner, symbol: string, skip: string, detail?: string): string {
  return `⚠️ [${SLEEVE_NAMES[sleeve] ?? sleeve}] skipped ${symbol}: ${skip}${detail ? ` (${detail})` : ""}`;
}
