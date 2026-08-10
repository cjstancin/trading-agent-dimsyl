// Bull v2 — corporate actions (design §7). Alpaca PAPER processes NO corporate actions: splits
// corrupt the equity curve silently and dividends never arrive. So the book handles them itself:
//   · nightly poll of announcements for HELD symbols
//   · reverse splits / cash+stock mergers → EXIT before the effective date (normal sell path)
//   · forward splits → self-adjust the internal ledger (qty×ratio, basis unchanged; broker position
//     flagged stale until reconcile verifies post-effective)
//   · cash dividends → self-credited into the cash ledger at EX-DATE, pro-rated to fractional
//     shares, so the book isn't structurally penalized vs SPY total return
// The poll is a port (offline tests inject fixtures); the real adapter reads Alpaca's data-host
// corporate-actions endpoint with the same auth as bars/quotes.
import type { DatabaseSync } from "node:sqlite";
import { withTimeout, DEFAULT_TIMEOUT_MS } from "../../http-utils.js";
import { d9, d9str, mul9, type D9 } from "./../decimal.js";
import { ledgerPositions, applyForwardSplit } from "./../lots.js";
import { recordCash } from "./../settled-cash.js";
import { setState } from "./../db.js";

export interface CorporateAnnouncement {
  symbol: string;
  type: "forward_split" | "reverse_split" | "cash_dividend" | "cash_merger" | "stock_merger" | "unknown";
  exDate?: string;          // YYYY-MM-DD (dividends: entitlement date; splits: effective date proxy)
  effectiveDate?: string;
  newRate?: number;         // splits: new qty per old
  oldRate?: number;
  cashRate?: number;        // cash dividend per share (USD)
  raw?: unknown;
}

export interface CorporateActionsPort {
  announcements(symbols: string[], start: string, end: string): Promise<CorporateAnnouncement[]>;
}

const DATA_BASE = "https://data.alpaca.markets";

function authHeaders(): Record<string, string> {
  const id = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_API_SECRET;
  if (!id || !secret) throw new Error("ALPACA_API_KEY / ALPACA_API_SECRET not set");
  return { "APCA-API-KEY-ID": id, "APCA-API-SECRET-KEY": secret };
}

/** Real adapter — Alpaca data-host v1 corporate actions. Returns [] on any failure (the nightly
 *  poll retries tomorrow; a data blip must not break the evening ritual). Parsing is defensive:
 *  unknown shapes become type "unknown" and are surfaced, never guessed at. */
export const alpacaCorporateActions: CorporateActionsPort = {
  async announcements(symbols, start, end): Promise<CorporateAnnouncement[]> {
    try {
      const qs = new URLSearchParams({ symbols: symbols.join(","), start, end, limit: "1000" });
      const r = await withTimeout((signal) => fetch(`${DATA_BASE}/v1/corporate-actions?${qs}`, {
        headers: authHeaders(), signal,
      }), DEFAULT_TIMEOUT_MS);
      if (!r.ok) return [];
      const j = (await r.json()) as { corporate_actions?: Record<string, any[]> };
      const out: CorporateAnnouncement[] = [];
      const ca = j?.corporate_actions ?? {};
      for (const s of ca.forward_splits ?? []) out.push({ symbol: String(s.symbol).toUpperCase(), type: "forward_split", exDate: s.ex_date, effectiveDate: s.ex_date, newRate: Number(s.new_rate), oldRate: Number(s.old_rate), raw: s });
      for (const s of ca.reverse_splits ?? []) out.push({ symbol: String(s.symbol).toUpperCase(), type: "reverse_split", exDate: s.ex_date, effectiveDate: s.ex_date, newRate: Number(s.new_rate), oldRate: Number(s.old_rate), raw: s });
      for (const dv of ca.cash_dividends ?? []) out.push({ symbol: String(dv.symbol).toUpperCase(), type: "cash_dividend", exDate: dv.ex_date, cashRate: Number(dv.rate), raw: dv });
      for (const m of ca.cash_mergers ?? []) out.push({ symbol: String(m.acquiree_symbol ?? m.symbol).toUpperCase(), type: "cash_merger", effectiveDate: m.effective_date, raw: m });
      for (const m of ca.stock_mergers ?? []) out.push({ symbol: String(m.acquiree_symbol ?? m.symbol).toUpperCase(), type: "stock_merger", effectiveDate: m.effective_date, raw: m });
      return out;
    } catch { return []; }
  },
};

export interface CorporateActionsPlan {
  exitBefore: { symbol: string; type: string; effectiveDate: string }[]; // sell via the owning sleeve's normal path
  forwardSplits: { symbol: string; num: bigint; den: bigint; exDate: string }[];
  dividends: { symbol: string; exDate: string; perShare9: D9 }[];
  unknown: CorporateAnnouncement[];
}

/** Pure decision core over announcements × current holdings. */
export function planCorporateActions(announcements: CorporateAnnouncement[], held: Set<string>): CorporateActionsPlan {
  const plan: CorporateActionsPlan = { exitBefore: [], forwardSplits: [], dividends: [], unknown: [] };
  for (const a of announcements) {
    if (!held.has(a.symbol)) continue;
    switch (a.type) {
      case "reverse_split":
      case "cash_merger":
      case "stock_merger":
        if (a.effectiveDate) plan.exitBefore.push({ symbol: a.symbol, type: a.type, effectiveDate: a.effectiveDate });
        else plan.unknown.push(a);
        break;
      case "forward_split": {
        const num = Math.round(a.newRate ?? 0);
        const den = Math.round(a.oldRate ?? 0);
        if (num > 0 && den > 0 && a.exDate) plan.forwardSplits.push({ symbol: a.symbol, num: BigInt(num), den: BigInt(den), exDate: a.exDate });
        else plan.unknown.push(a);
        break;
      }
      case "cash_dividend":
        if (a.exDate && Number.isFinite(a.cashRate) && (a.cashRate ?? 0) > 0) {
          plan.dividends.push({ symbol: a.symbol, exDate: a.exDate, perShare9: d9(String(a.cashRate)) });
        }
        break;
      default:
        plan.unknown.push(a);
    }
  }
  return plan;
}

/** Apply the ledger-side effects that are due as of `today`:
 *  forward splits at ex-date (self-adjust + broker-stale flag) and dividends at ex-date
 *  (self-credit, idempotent by ref div:{symbol}:{exDate}). Exits are NOT executed here — the
 *  evening ritual routes them through the owning sleeve's sell path and Discord-notes them. */
export function applyDueActions(db: DatabaseSync, plan: CorporateActionsPlan, today: string): {
  splitsApplied: number; dividendsCredited: number;
} {
  let splits = 0;
  let divs = 0;
  const positions = ledgerPositions(db);
  for (const s of plan.forwardSplits) {
    if (s.exDate > today) continue;
    applyForwardSplit(db, s.symbol, s.num, s.den, today + "T00:00:00Z");
    splits++;
  }
  for (const dv of plan.dividends) {
    if (dv.exDate > today) continue;
    const qty = positions.get(dv.symbol);
    if (!qty || qty <= 0n) continue;
    const amount = mul9(qty, dv.perShare9); // pro-rated to fractional shares by construction
    const inserted = recordCash(db, {
      ts: dv.exDate + "T00:00:00Z", kind: "dividend", symbol: dv.symbol, amount9: amount,
      settlesOn: dv.exDate, ref: `div:${dv.symbol}:${dv.exDate}`,
      note: `self-credited ${d9str(dv.perShare9)}/sh (paper pays no dividends)`,
    });
    if (inserted) divs++;
  }
  if (plan.unknown.length) {
    setState(db, "corp_actions_unknown", JSON.stringify(plan.unknown.slice(0, 10)));
  }
  return { splitsApplied: splits, dividendsCredited: divs };
}
