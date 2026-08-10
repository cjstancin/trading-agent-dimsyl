// Bull v2 — rituals: shared dep types + small helpers the orchestrators lean on.
//   · step(): the v1 lesson made law — EVERY ritual sub-step runs inside step(); a failure posts a
//     Discord note and the ritual CONTINUES. A ritual must never die silently.
//   · sleeve equity: SLEEVE_SPLIT × current book equity (equityCurve last mark; before launch /
//     no marks → config book.equityUsd) — the cross-cutting rule every sleeve call sizes from.
//   · numToD9 / priceMap9: broker floats cross into d9 space exactly once, at this boundary.
import type { DatabaseSync } from "node:sqlite";
import { d9, mul9, div9, type D9 } from "../decimal.js";
import type { EffectiveConfig } from "../config.js";
import type { BrokerPort, ReadPort } from "../broker.js";
import type { Mode } from "../../mode.js";
import type { OrderOwner, Sleeve } from "../types.js";
import { equityCurve } from "../book/equity.js";
import { dayTradeGuard } from "../book/equity.js";
import { sleeveValue9 } from "../book/trims.js";
import { totalCash } from "../settled-cash.js";
import type { ExtraGuard } from "../order-gateway.js";

export type PostFn = (text: string) => Promise<unknown>;
export type LatestPriceFn = (symbol: string) => Promise<number | null>;

/** Daily OHLCV bar as v1 alpaca.getBars returns it (and wildcard/types Bar mirrors it). */
export interface AlpacaBarLike { t: string; o: number; h: number; l: number; c: number; v: number }
export type DailyBarsFn = (symbol: string, lookbackDays: number) => Promise<AlpacaBarLike[]>;

/** Shared slice every ritual needs. Real wiring in real-deps.ts; tests inject everything. */
export interface CoreDeps {
  db: DatabaseSync;
  eff: EffectiveConfig;
  mode: Mode;                 // trades place ONLY in "auto"; "gated" computes + notes; "off" exits
  today: string;              // ET date key (YYYY-MM-DD)
  post: PostFn;               // injectable Discord sender (tests capture; real = postBill)
  latestPrice: LatestPriceFn;
}

export interface StepResult { name: string; ok: boolean; detail?: string }

/** Run one ritual sub-step. A throw posts a warn note and returns false — never rethrows, never
 *  silent. The step's return string lands in the ritual's structured result for the wrapper log. */
export async function step(
  steps: StepResult[], post: PostFn, name: string, fn: () => Promise<string | void>,
): Promise<boolean> {
  try {
    const detail = await fn();
    steps.push({ name, ok: true, ...(detail ? { detail } : {}) });
    return true;
  } catch (e) {
    const msg = (e instanceof Error ? (e.stack ?? e.message) : String(e)).slice(0, 300);
    steps.push({ name, ok: false, detail: msg });
    try { await post(`⚠️ [Book] ritual step "${name}" failed: ${msg} — continuing`); } catch { /* Discord never breaks a ritual */ }
    return false;
  }
}

/** Broker float → d9 (6 dp exact-string path — mirrors anchor/prices.ts numToD9). */
export function numToD9(x: number): D9 {
  if (!Number.isFinite(x)) throw new Error(`rituals: non-finite price ${x}`);
  return d9(x.toFixed(6));
}

/** Current book equity: last equity-curve mark, else the config seed (pre-launch / no marks). */
export function bookEquity9(db: DatabaseSync, eff: EffectiveConfig): D9 {
  const curve = equityCurve(db);
  return curve.length ? curve[curve.length - 1].equity9 : d9(String(eff.config.book.equityUsd));
}

/** Sleeve equity = sleeveSplit × book equity (config sleeveSplit is a non-tunable mirror of
 *  types.SLEEVE_SPLIT). */
export function sleeveEquityFor9(db: DatabaseSync, eff: EffectiveConfig, sleeve: Sleeve): D9 {
  return mul9(bookEquity9(db, eff), d9(String(eff.config.book.sleeveSplit[sleeve])));
}

/** Sleeve NAV for kill-switch math: marked sleeve positions + the sleeve's split share of total
 *  cash (the book does not attribute cash per-sleeve any finer than the split). */
export function sleeveNavFor9(db: DatabaseSync, eff: EffectiveConfig, sleeve: Sleeve, prices: Map<string, D9>): D9 {
  return sleeveValue9(db, sleeve, prices).value9
    + mul9(totalCash(db), d9(String(eff.config.book.sleeveSplit[sleeve])));
}

/** Fetch latest prices for a symbol set into a d9 map. Missing prices are simply absent — callers
 *  decide whether absence blocks (trims skip unpriced names by design). */
export async function priceMap9(symbols: Iterable<string>, latest: LatestPriceFn): Promise<Map<string, D9>> {
  const out = new Map<string, D9>();
  for (const s of new Set(symbols)) {
    const p = await latest(s);
    if (p != null && p > 0) out.set(s, numToD9(p));
  }
  return out;
}

/** Symbols a sleeve currently holds (ledger truth). */
export function sleeveSymbols(db: DatabaseSync, sleeve: string): string[] {
  const rows = db.prepare(
    "SELECT symbol, SUM(CAST(qty_remaining9 AS REAL)) AS q FROM lots WHERE sleeve=? GROUP BY symbol HAVING q > 0",
  ).all(sleeve) as { symbol: string; q: number }[];
  return rows.map((r) => r.symbol);
}

/** Owning sleeve for a held symbol (first lot owner), else "book" (unowned = book's problem). */
export function ownerSleeveFor(db: DatabaseSync, symbol: string): OrderOwner {
  const row = db.prepare(
    "SELECT sleeve FROM lots WHERE symbol=? AND sleeve IS NOT NULL AND CAST(qty_remaining9 AS TEXT) != '0' LIMIT 1",
  ).get(symbol) as { sleeve: string } | undefined;
  return (row?.sleeve as OrderOwner) ?? "book";
}

/** Average entry price for a sleeve's open lots in a symbol (Σ basis / Σ qty_open), or null. */
export function avgEntryPrice9(db: DatabaseSync, sleeve: string, symbol: string): D9 | null {
  const rows = db.prepare(
    "SELECT basis_total9, qty_open9 FROM lots WHERE sleeve=? AND symbol=? AND CAST(qty_remaining9 AS TEXT) != '0'",
  ).all(sleeve, symbol) as { basis_total9: string; qty_open9: string }[];
  let basis = 0n, qty = 0n;
  for (const r of rows) { basis += d9(r.basis_total9); qty += d9(r.qty_open9); }
  return qty > 0n ? div9(basis, qty) : null;
}

/** One "needs your call" approvals row (shared table, design §9). bigint-safe payload stringify. */
export function queueApprovalRow(db: DatabaseSync, kind: string, title: string, payload: unknown): number {
  const res = db.prepare(
    "INSERT INTO approvals(ts, kind, title, payload, status) VALUES(?,?,?,?,'pending')",
  ).run(new Date().toISOString(), kind, title,
    JSON.stringify(payload, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  return Number(res.lastInsertRowid);
}

/** The day-trade guard as a gateway extraGuard, dialed from config. Rituals attach this to every
 *  placeOrder THEY make directly (sleeve-internal placeOrder calls don't take extraGuards — a
 *  known seam the supervisor owns). */
export function dtGuard(eff: EffectiveConfig): ExtraGuard {
  return dayTradeGuard(Number(eff.config.book.dayTradeGuard.maxDayTradesPer5Days)) as ExtraGuard;
}
