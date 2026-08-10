// Bull v2 — wash-sale engine (design §7; reference semantics: nkouevda/capital-gains). On every
// realized loss, scan ±30 days for replacement buys of the substantially-identical symbol; the
// matched share of the loss is DISALLOWED for tax, moved onto the replacement lot as a basis
// adjustment (kept separate from original basis) with holding-period tacking. Losses stay
// PROVISIONAL for 31 days after the sale — scanWash() re-runs after every ingest/reconcile batch and
// is idempotent (wash_links records what's already matched; only new matches are added).
//
// Economic vs tax truth: disposals.realized9 stays the ECONOMIC P&L (performance reporting);
// wash_disallowed9 is the tax-disallowed portion (tax loss = realized9 + wash_disallowed9). The
// 31-day re-entry blacklist (order gateway) makes real wash events rare — this engine is the
// belt-and-suspenders that keeps the 1099 clean when one slips through (e.g. add-then-stop within
// a month).
import type { DatabaseSync } from "node:sqlite";
import { d9, d9str, abs9, allocate9, min9, type D9 } from "./decimal.js";

const WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;

function isoMinusDays(iso: string, days: number): string {
  return new Date(new Date(iso).getTime() - days * DAY_MS).toISOString();
}
function isoPlusDays(iso: string, days: number): string {
  return new Date(new Date(iso).getTime() + days * DAY_MS).toISOString();
}

export interface WashMatch {
  disposalId: number;
  replacementLotId: number;
  qty9: string;
  disallowed9: string;
}

/** Run the wash-sale scan over the whole ledger. Returns the NEW matches created this run. */
export function scanWash(db: DatabaseSync, nowIso: string = new Date().toISOString()): WashMatch[] {
  const lossDisposals = db
    .prepare("SELECT * FROM disposals WHERE CAST(realized9 AS TEXT) LIKE '-%' ORDER BY close_ts ASC, disposal_id ASC")
    .all() as any[];

  const out: WashMatch[] = [];
  for (const disp of lossDisposals) {
    const dispQty = d9(disp.qty9);
    const loss = abs9(d9(disp.realized9));

    // What's already matched on this disposal (idempotency).
    const prior = db.prepare("SELECT qty9, disallowed9 FROM wash_links WHERE disposal_id=?").all(disp.disposal_id) as any[];
    const matchedQty = prior.reduce((a, r) => a + d9(r.qty9), 0n);
    const matchedLoss = prior.reduce((a, r) => a + d9(r.disallowed9), 0n);
    let remainingQty = dispQty - matchedQty;
    let remainingLoss = loss - matchedLoss;
    if (remainingQty <= 0n || remainingLoss <= 0n) continue;

    // Candidate replacement lots: same symbol, opened in ±30d, NOT the lot the loss came from.
    const lo = isoMinusDays(disp.close_ts, WINDOW_DAYS);
    const hi = isoPlusDays(disp.close_ts, WINDOW_DAYS);
    const candidates = db
      .prepare("SELECT * FROM lots WHERE symbol=? AND lot_id != ? AND open_ts >= ? AND open_ts <= ? ORDER BY open_ts ASC, lot_id ASC")
      .all(disp.symbol, disp.lot_id, lo, hi) as any[];

    for (const lot of candidates) {
      if (remainingQty <= 0n) break;
      // Shares in a lot can only serve as replacement once (across ALL disposals).
      const used = db.prepare("SELECT qty9 FROM wash_links WHERE replacement_lot_id=?").all(lot.lot_id) as any[];
      const usedQty = used.reduce((a: D9, r: any) => a + d9(r.qty9), 0n);
      const avail = d9(lot.qty_open9) - usedQty;
      if (avail <= 0n) continue;

      const match = min9(avail, remainingQty);
      // Exact allocation of the still-unallocated loss over the still-unmatched qty.
      const disallowed = match === remainingQty ? remainingLoss : allocate9(remainingLoss, [match, remainingQty - match])[0];
      if (disallowed <= 0n) continue;

      applyMatch(db, disp, lot, match, disallowed);
      out.push({ disposalId: disp.disposal_id, replacementLotId: lot.lot_id, qty9: d9str(match), disallowed9: d9str(disallowed) });
      remainingQty -= match;
      remainingLoss -= disallowed;
    }
  }
  return out;
}

function applyMatch(db: DatabaseSync, disp: any, lot: any, qty: D9, disallowed: D9): void {
  db.exec("BEGIN");
  try {
    db.prepare("INSERT INTO wash_links(disposal_id, replacement_lot_id, qty9, disallowed9, created_ts) VALUES(?,?,?,?,?)")
      .run(disp.disposal_id, lot.lot_id, d9str(qty), d9str(disallowed), new Date().toISOString());

    db.prepare("UPDATE disposals SET wash_disallowed9=? WHERE disposal_id=?")
      .run(d9str(d9(disp.wash_disallowed9) + disallowed), disp.disposal_id);

    // Holding-period tack: the surrendered shares' holding period is added to the replacement lot —
    // shift its holding start back by the disposed shares' held duration.
    const heldMs = new Date(disp.close_ts).getTime() - new Date(disp.holding_period_start_ts).getTime();
    const tacked = new Date(new Date(lot.open_ts).getTime() - Math.max(0, heldMs)).toISOString();
    const newStart = tacked < lot.holding_period_start_ts ? tacked : lot.holding_period_start_ts;

    const lotRemaining = d9(lot.qty_remaining9);
    if (lotRemaining > 0n) {
      // Adjustment rides the lot's remaining basis — future disposals of it carry the deferred loss.
      db.prepare("UPDATE lots SET wash_adj_basis9=?, basis_remaining9=?, holding_period_start_ts=? WHERE lot_id=?")
        .run(
          d9str(d9(lot.wash_adj_basis9) + disallowed),
          d9str(d9(lot.basis_remaining9) + disallowed),
          newStart,
          lot.lot_id,
        );
    } else {
      // Replacement lot already fully disposed (back-match): amend ITS disposals — allocate the
      // adjustment across them by qty, raising basis and lowering realized.
      db.prepare("UPDATE lots SET wash_adj_basis9=?, holding_period_start_ts=? WHERE lot_id=?")
        .run(d9str(d9(lot.wash_adj_basis9) + disallowed), newStart, lot.lot_id);
      const dispRows = db.prepare("SELECT * FROM disposals WHERE lot_id=? ORDER BY close_ts ASC, disposal_id ASC").all(lot.lot_id) as any[];
      if (dispRows.length) {
        const parts = allocate9(disallowed, dispRows.map((r) => d9(r.qty9)));
        const upd = db.prepare("UPDATE disposals SET basis9=?, realized9=? WHERE disposal_id=?");
        dispRows.forEach((r, i) => {
          upd.run(d9str(d9(r.basis9) + parts[i]), d9str(d9(r.realized9) - parts[i]), r.disposal_id);
        });
      }
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** 31-day re-entry blacklist check (design §7 behavior rail): TRUE if `symbol` had a realized-LOSS
 *  exit within the last `days` calendar days of `asOf` (YYYY-MM-DD) — the order gateway refuses the
 *  buy so the wash engine above rarely has real work. Hard-on across year-end by construction
 *  (pure date math, no tax-year reset). */
export function lossExitWithin(db: DatabaseSync, symbol: string, days: number, asOf: string): boolean {
  const cutoff = new Date(new Date(asOf + "T00:00:00Z").getTime() - days * DAY_MS).toISOString();
  const row = db
    .prepare("SELECT disposal_id FROM disposals WHERE symbol=? AND CAST(realized9 AS TEXT) LIKE '-%' AND close_ts >= ? LIMIT 1")
    .get(symbol, cutoff);
  return !!row;
}
