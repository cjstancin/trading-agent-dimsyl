// Bull v2 — settled-cash ledger (design §1). THE v1 killer bug was sizing off equity with no cash
// cap; the v2 rail is the opposite extreme and deliberate: the bot maintains its OWN cash truth and
// sizing NEVER reads Alpaca's buying_power (which reports ~2× cash on margin accounts). Paper
// behaves like a strict live cash account:
//   · buys debit spendable cash IMMEDIATELY (settles_on = trade date)
//   · sale proceeds credit at T+1 (settles_on = next trading day via /v2/calendar)
//   · buys are GATED on settled cash — spending unsettled proceeds is a Good-Faith-Violation in a
//     real cash account, so a blocked attempt increments the GFV counter instead of trading.
// All amounts are d9 strings in cash_events; math is bigint end-to-end.
import type { DatabaseSync } from "node:sqlite";
import { d9, d9str, type D9 } from "./decimal.js";
import { getState, setState } from "./db.js";
import { isWeekendET, isKnownNyseHoliday } from "../market-calendar.js";

export type CashKind = "seed" | "buy" | "sell" | "dividend" | "fee" | "sweep_buy" | "sweep_sell" | "adjust";

export interface CashEvent {
  ts: string;         // ISO event time
  kind: CashKind;
  symbol?: string;
  amount9: D9;        // signed: buys/fees/sweep_buy negative, sells/dividends/sweep_sell/seed positive
  settlesOn: string;  // YYYY-MM-DD (ET) the cash becomes spendable
  ref?: string;       // fill/activity id → idempotent replay (unique per kind)
  note?: string;
}

/** Next trading day AFTER dateKey. `sessions` (ascending YYYY-MM-DD from Alpaca /v2/calendar) is
 *  authoritative when provided; offline fallback walks weekdays minus the static NYSE holiday set.
 *  Pure — unit-testable without network. */
export function nextTradingDay(dateKey: string, sessions?: string[]): string {
  if (sessions && sessions.length) {
    for (const s of sessions) if (s > dateKey) return s;
    // fall through to the offline walk if the provided window ended
  }
  let d = new Date(dateKey + "T12:00:00Z"); // noon UTC — immune to DST date-shift
  for (let i = 0; i < 10; i++) {
    d = new Date(d.getTime() + 86_400_000);
    if (!isWeekendET(d) && !isKnownNyseHoliday(d)) return d.toISOString().slice(0, 10);
  }
  throw new Error(`nextTradingDay: no trading day within 10 days of ${dateKey}`);
}

/** Record one cash event. Fill-driven events (ref set) are idempotent: a replayed fill is a no-op.
 *  Returns true if the row was inserted, false if it already existed. */
export function recordCash(db: DatabaseSync, e: CashEvent): boolean {
  const res = db
    .prepare(
      `INSERT INTO cash_events(ts, kind, symbol, amount9, settles_on, ref, note)
       VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(kind, ref) WHERE ref IS NOT NULL DO NOTHING`,
    )
    .run(e.ts, e.kind, e.symbol ?? null, d9str(e.amount9), e.settlesOn, e.ref ?? null, e.note ?? null);
  return Number(res.changes) > 0;
}

/** Seed the fresh book (one-time $5,000; settles immediately). Idempotent via ref="seed". */
export function seedBook(db: DatabaseSync, amountUsd: string, dateKey: string): boolean {
  return recordCash(db, {
    ts: dateKey + "T00:00:00.000Z",
    kind: "seed",
    amount9: d9(amountUsd),
    settlesOn: dateKey,
    ref: "seed",
    note: "book inception",
  });
}

/** Spendable (settled) cash as of an ET date key: Σ amount9 where settles_on ≤ asOf. */
export function settledCash(db: DatabaseSync, asOf: string): D9 {
  const rows = db.prepare("SELECT amount9 FROM cash_events WHERE settles_on <= ?").all(asOf) as { amount9: string }[];
  return rows.reduce((acc, r) => acc + d9(r.amount9), 0n);
}

/** Total cash including unsettled sale proceeds (the number that must reconcile to Alpaca's cash). */
export function totalCash(db: DatabaseSync): D9 {
  const rows = db.prepare("SELECT amount9 FROM cash_events").all() as { amount9: string }[];
  return rows.reduce((acc, r) => acc + d9(r.amount9), 0n);
}

/** Gate a proposed buy of `notional9` on settled cash as of `asOf`. On refusal, increments the GFV
 *  counter (state key gfv_attempts) — the design's honesty telemetry for "we would have violated". */
export function gateBuy(db: DatabaseSync, notional9: D9, asOf: string): { ok: boolean; settled9: D9 } {
  const settled = settledCash(db, asOf);
  if (notional9 <= settled) return { ok: true, settled9: settled };
  const n = parseInt(getState(db, "gfv_attempts") ?? "0", 10) + 1;
  setState(db, "gfv_attempts", String(n));
  return { ok: false, settled9: settled };
}
