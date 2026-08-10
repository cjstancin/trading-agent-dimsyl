// Bull v2 — FIFO lot engine (design §7). Mirrors Alpaca's FIFO-only 1099-B: buys open lots, sells
// consume the OLDEST lots first, each (sell fill × lot) pair becomes a disposal row with exact basis
// allocation (allocate9 — the parts always sum to the whole; a fully-consumed lot's disposal bases
// sum EXACTLY to its basis). The internal ledger is the source of truth for performance; the Alpaca
// account is the source of truth for positions (reconcile diffs the two).
//
// Fees/slippage honesty ledgers (momentum's 5 bps synthetic) are ANALYTICS, not tax rows — the tax
// ledger records actual paper fills only.
import type { DatabaseSync } from "node:sqlite";
import { d9, d9str, mul9, min9, allocate9, type D9 } from "./decimal.js";
import { setState } from "./db.js";

export interface FillInput {
  id: string;              // Alpaca activity id (or exec id) — the idempotency key
  orderId?: string;
  clientOrderId?: string;
  symbol: string;
  side: "buy" | "sell";
  qty9: D9;                // positive
  price9: D9;              // per share
  ts: string;              // ISO transaction_time
  sleeve?: string | null;  // resolved from client_order_id prefix; null = untagged
  raw?: string;
}

export interface DisposalRow {
  disposal_id: number;
  sell_fill_id: string;
  lot_id: number;
  symbol: string;
  sleeve: string | null;
  qty9: string;
  proceeds9: string;
  basis9: string;
  realized9: string;
  open_ts: string;
  close_ts: string;
  holding_period_start_ts: string;
  term: "short" | "long";
  wash_disallowed9: string;
  wash_provisional_until: string | null;
}

export class OversellError extends Error {
  constructor(public symbol: string, public excess9: D9) {
    super(`FIFO oversell: sell of ${symbol} exceeds ledger position by ${d9str(excess9)} shares — ledger/broker mismatch, halt the sleeve`);
    this.name = "OversellError";
  }
}

/** Long-term if close is STRICTLY more than one year after the holding-period start (tack-aware). */
export function termFor(holdingStartIso: string, closeIso: string): "short" | "long" {
  const start = new Date(holdingStartIso);
  const oneYear = new Date(Date.UTC(start.getUTCFullYear() + 1, start.getUTCMonth(), start.getUTCDate(),
    start.getUTCHours(), start.getUTCMinutes(), start.getUTCSeconds()));
  return new Date(closeIso).getTime() > oneYear.getTime() ? "long" : "short";
}

/** dateKey + n calendar days → dateKey (UTC-safe). */
export function addDays(dateKey: string, n: number): string {
  const d = new Date(dateKey + "T12:00:00Z");
  return new Date(d.getTime() + n * 86_400_000).toISOString().slice(0, 10);
}

/** Ingest one fill. Idempotent by fill id (a replayed fill is a no-op). Buys open a lot; sells
 *  consume lots FIFO and return the created disposal rows. Throws OversellError if the ledger
 *  doesn't hold enough shares — that's a broker/ledger mismatch reconcile must flag, never absorb. */
export function ingestFill(db: DatabaseSync, f: FillInput): { inserted: boolean; disposals: DisposalRow[] } {
  const exists = db.prepare("SELECT id FROM fills WHERE id=?").get(f.id);
  if (exists) return { inserted: false, disposals: [] };

  const insertAll = db.prepare(
    `INSERT INTO fills(id, order_id, client_order_id, symbol, side, qty9, price9, ts, sleeve, raw)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
  );
  db.exec("BEGIN");
  try {
    insertAll.run(f.id, f.orderId ?? null, f.clientOrderId ?? null, f.symbol, f.side,
      d9str(f.qty9), d9str(f.price9), f.ts, f.sleeve ?? null, f.raw ?? "{}");

    let disposals: DisposalRow[] = [];
    if (f.side === "buy") {
      const basis = mul9(f.qty9, f.price9);
      db.prepare(
        `INSERT INTO lots(symbol, sleeve, open_fill_id, open_ts, holding_period_start_ts,
           qty_open9, qty_remaining9, basis_total9, basis_remaining9)
         VALUES(?,?,?,?,?,?,?,?,?)`,
      ).run(f.symbol, f.sleeve ?? null, f.id, f.ts, f.ts, d9str(f.qty9), d9str(f.qty9), d9str(basis), d9str(basis));
    } else {
      disposals = consumeFifo(db, f);
    }
    db.exec("COMMIT");
    return { inserted: true, disposals };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

function consumeFifo(db: DatabaseSync, f: FillInput): DisposalRow[] {
  const lots = db
    .prepare("SELECT * FROM lots WHERE symbol=? AND CAST(qty_remaining9 AS TEXT) != '0' ORDER BY open_ts ASC, lot_id ASC")
    .all(f.symbol) as any[];

  // Plan consumption first (FIFO), then write. Proceeds allocated across consumed lots by qty.
  let toSell = f.qty9;
  const plan: { lot: any; qty: D9 }[] = [];
  for (const lot of lots) {
    if (toSell <= 0n) break;
    const rem = d9(lot.qty_remaining9);
    const take = min9(rem, toSell);
    plan.push({ lot, qty: take });
    toSell -= take;
  }
  if (toSell > 0n) throw new OversellError(f.symbol, toSell);

  const totalProceeds = mul9(f.qty9, f.price9);
  const proceedsParts = allocate9(totalProceeds, plan.map((p) => p.qty));

  const out: DisposalRow[] = [];
  const updLot = db.prepare("UPDATE lots SET qty_remaining9=?, basis_remaining9=? WHERE lot_id=?");
  const insDisp = db.prepare(
    `INSERT INTO disposals(sell_fill_id, lot_id, symbol, sleeve, qty9, proceeds9, basis9, realized9,
       open_ts, close_ts, holding_period_start_ts, term, wash_disallowed9, wash_provisional_until)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'0',?)`,
  );

  for (let i = 0; i < plan.length; i++) {
    const { lot, qty } = plan[i];
    const rem = d9(lot.qty_remaining9);
    const basisRem = d9(lot.basis_remaining9);
    // Exact basis: full consumption takes ALL remaining basis; partial takes its allocate9 share.
    const basisUsed = qty === rem ? basisRem : allocate9(basisRem, [qty, rem - qty])[0];
    const proceeds = proceedsParts[i];
    const realized = proceeds - basisUsed;
    const term = termFor(lot.holding_period_start_ts, f.ts);
    // Loss → provisional wash window: 31 calendar days after the close date (design §7).
    const provisionalUntil = realized < 0n ? addDays(f.ts.slice(0, 10), 31) : null;

    updLot.run(d9str(rem - qty), d9str(basisRem - basisUsed), lot.lot_id);
    const res = insDisp.run(f.id, lot.lot_id, f.symbol, f.sleeve ?? lot.sleeve ?? null,
      d9str(qty), d9str(proceeds), d9str(basisUsed), d9str(realized),
      lot.open_ts, f.ts, lot.holding_period_start_ts, term, provisionalUntil);
    out.push({
      disposal_id: Number(res.lastInsertRowid),
      sell_fill_id: f.id, lot_id: lot.lot_id, symbol: f.symbol,
      sleeve: (f.sleeve ?? lot.sleeve ?? null) as string | null,
      qty9: d9str(qty), proceeds9: d9str(proceeds), basis9: d9str(basisUsed), realized9: d9str(realized),
      open_ts: lot.open_ts, close_ts: f.ts, holding_period_start_ts: lot.holding_period_start_ts,
      term, wash_disallowed9: "0", wash_provisional_until: provisionalUntil,
    });
  }
  return out;
}

/** Ledger position for a symbol: Σ qty_remaining across its lots. */
export function ledgerPosition(db: DatabaseSync, symbol: string): D9 {
  const rows = db.prepare("SELECT qty_remaining9 FROM lots WHERE symbol=?").all(symbol) as { qty_remaining9: string }[];
  return rows.reduce((a, r) => a + d9(r.qty_remaining9), 0n);
}

/** All symbols with a non-zero ledger position. */
export function ledgerPositions(db: DatabaseSync): Map<string, D9> {
  const rows = db.prepare("SELECT symbol, qty_remaining9 FROM lots").all() as { symbol: string; qty_remaining9: string }[];
  const out = new Map<string, D9>();
  for (const r of rows) out.set(r.symbol, (out.get(r.symbol) ?? 0n) + d9(r.qty_remaining9));
  for (const [k, v] of out) if (v === 0n) out.delete(k);
  return out;
}

/** Self-adjust a FORWARD split in the internal ledger (design §7): qty × num/den, total basis
 *  unchanged (per-share basis scales down). Alpaca paper processes NO corporate actions, so the
 *  broker position is flagged stale until reconcile verifies it post-effective. */
export function applyForwardSplit(db: DatabaseSync, symbol: string, num: bigint, den: bigint, ts: string): number {
  if (num <= 0n || den <= 0n) throw new Error("applyForwardSplit: ratio parts must be positive");
  const lots = db.prepare("SELECT lot_id, qty_open9, qty_remaining9 FROM lots WHERE symbol=?").all(symbol) as any[];
  const upd = db.prepare("UPDATE lots SET qty_open9=?, qty_remaining9=? WHERE lot_id=?");
  db.exec("BEGIN");
  try {
    for (const l of lots) {
      upd.run(
        d9str((d9(l.qty_open9) * num) / den),
        d9str((d9(l.qty_remaining9) * num) / den),
        l.lot_id,
      );
    }
    setState(db, `split_stale:${symbol}`, JSON.stringify({ num: String(num), den: String(den), ts }));
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return lots.length;
}
