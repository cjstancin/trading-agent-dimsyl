// Reconcile (Bull v2 — closes the measurement loop): FIFO-match Alpaca fills into closed round-trips,
// compute realized P&L + R-multiple, and back-fill each ledger proposal's outcome. Deterministic; no LLM,
// no orders. No-op safe on a flat/empty account (returns []). Idempotent — already-closed proposals are skipped.
import { getActivities } from "./alpaca.js";
import { readLedger, updateLedger } from "./ledger.js";

const num = (v: unknown): number => { const x = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN; return Number.isFinite(x) ? x : 0; };
const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

export interface ClosedTrade {
  symbol: string; qty: number; entry: number; exit: number; pnlUsd: number; pnlPct: number; rMultiple: number; openedAt: string; closedAt: string;
  // MAE/MFE over the hold window (Bull backlog #12) — per-share $ + % of entry. Attached at journal time
  // from fetched bars; absent when bars were unavailable (offline/no-data) so the journal never blocks.
  maePct?: number; maeUsd?: number; mfePct?: number; mfeUsd?: number;
}

export async function reconcile(): Promise<ClosedTrade[]> {
  let fills: Record<string, unknown>[] = [];
  try { const a = await getActivities("FILL"); fills = Array.isArray(a) ? (a as Record<string, unknown>[]) : []; } catch { return []; }
  if (!fills.length) return [];

  // Group fills by symbol, chronological.
  const bySym: Record<string, Array<{ side: string; qty: number; price: number; time: string }>> = {};
  for (const f of fills) {
    const sym = String(f.symbol ?? ""); if (!sym) continue;
    (bySym[sym] ||= []).push({ side: String(f.side ?? ""), qty: num(f.qty), price: num(f.price), time: String(f.transaction_time ?? f.transactionTime ?? "") });
  }
  for (const s in bySym) bySym[s].sort((a, b) => a.time.localeCompare(b.time));

  // FIFO: match sells against prior buy lots → closed long round-trips.
  const closed: ClosedTrade[] = [];
  for (const sym in bySym) {
    const lots: Array<{ qty: number; price: number; time: string }> = [];
    for (const f of bySym[sym]) {
      if (f.side === "buy") lots.push({ qty: f.qty, price: f.price, time: f.time });
      else if (f.side === "sell") {
        let remaining = f.qty;
        while (remaining > 1e-9 && lots.length) {
          const lot = lots[0];
          const matched = Math.min(remaining, lot.qty);
          closed.push({
            symbol: sym, qty: round(matched, 4), entry: round(lot.price), exit: round(f.price),
            pnlUsd: round((f.price - lot.price) * matched), pnlPct: lot.price ? round((f.price / lot.price - 1) * 100, 1) : 0,
            rMultiple: 0, openedAt: lot.time, closedAt: f.time,
          });
          lot.qty -= matched; remaining -= matched;
          if (lot.qty <= 1e-9) lots.shift();
        }
      }
    }
  }

  // Back-fill ledger outcomes: match each closed trade to the nearest prior open proposal for that symbol.
  const ledger = readLedger();
  for (const ct of closed) {
    const cand = ledger.filter((l) => l.symbol === ct.symbol && (l.status === "proposed" || l.status === "placed") && (l.outcome === "open" || l.outcome == null) && l.ts <= ct.closedAt);
    const prop = cand.length ? cand[cand.length - 1] : null;
    const trail = Number(prop?.trail_percent ?? 18);
    const risk = ct.entry * ct.qty * (trail / 100);
    ct.rMultiple = risk ? round(ct.pnlUsd / risk, 2) : 0;
    if (prop) { prop.outcome = ct.pnlUsd > 0 ? "win" : "loss"; prop.realizedPnlUsd = ct.pnlUsd; prop.rMultiple = ct.rMultiple; }
  }
  updateLedger(ledger);
  return closed;
}
