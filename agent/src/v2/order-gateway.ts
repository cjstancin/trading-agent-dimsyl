// Bull v2 — order gateway (design §1/§7). Every v2 order passes through here; the gates run in a
// fixed order and every refusal is RECORDED (order_intents row, status "skipped" + reason) — the v1
// bug class was orders silently 403ing for weeks, so v2's rule is: no order path may fail quietly.
//
// Gates, in order:
//   1. sleeve halt        — reconciliation mismatch froze this sleeve (state halt:<sleeve>)
//   2. notional floor     — Alpaca rejects < $1 notional (the v1 residual-cash bug)
//   3. wash blacklist     — buys of a symbol with a realized-loss exit in the last 31 days
//   4. settled-cash gate  — buys must fit SETTLED cash minus open buy reservations; NEVER
//                           Alpaca buying_power (reports ~2× cash on margin accounts — v1 killer)
//
// Idempotency: deterministic client_order_id {sleeve}:{symbol}:{intent}:{yyyymmdd}:{seq}. An intent
// whose submit outcome was UNKNOWN (timeout) is resolved by querying the broker by coid BEFORE any
// resubmit — and a retried placement REUSES the unknown intent's coid instead of minting a new seq.
import type { DatabaseSync } from "node:sqlite";
import { d9, d9str, mul9, type D9 } from "./decimal.js";
import { getState } from "./db.js";
import { gateBuy } from "./settled-cash.js";
import { lossExitWithin } from "./wash.js";
import type { OrderOwner, OrderIntent, SkipReason } from "./types.js";
import type { BrokerPort, BrokerOrderRequest } from "./broker.js";

const MIN_NOTIONAL9 = d9("1"); // Alpaca's $1 floor — below it the broker rejects (v1 saw these daily)

// ---- Alpaca wire formats (422 code 42210000: "notional value must be limited to 2 decimal
// places"). Internal math stays d9; ONLY the wire payload is rounded, and fills replay the
// broker's actual numbers so the ledger never sees the rounding.
const CENT9 = 10_000_000n; // $0.01 in d9

/** Notional → wire: FLOOR to the cent, so the wire amount never exceeds what the gates approved. */
export function wireNotional(n9: D9): string {
  return d9str(n9 - (n9 % CENT9));
}

/** Limit/stop price → wire: round to the nearest cent (standard equity tick). */
export function wirePrice(p9: D9): string {
  return d9str(((p9 + CENT9 / 2n) / CENT9) * CENT9);
}

export interface PlaceRequest {
  owner: OrderOwner;
  symbol: string;
  intent: OrderIntent;
  side: "buy" | "sell";
  type: "market" | "limit" | "stop";
  tif?: "day" | "gtc";
  qty9?: D9;             // exactly one of qty9 | notional9
  notional9?: D9;
  limitPrice9?: D9;
  stopPrice9?: D9;
  estPrice9?: D9;        // required for qty orders — the floor gate needs a notional estimate
  asOfDate: string;      // ET date key (YYYY-MM-DD) — settled-cash + blacklist as-of
  configVersion: string;
  blacklistExempt?: boolean; // sells and stop placements skip the re-entry blacklist by nature
}

export interface PlaceResult {
  placed: boolean;
  clientOrderId?: string;
  skipped?: SkipReason;
  detail?: string;
  order?: any;
  idempotent?: boolean;  // true when the broker already had this coid (replay)
}

/** Estimated notional for the floor + cash gates. */
function estNotional9(req: PlaceRequest): D9 {
  if (req.notional9 != null) return req.notional9;
  if (req.qty9 != null) {
    const px = req.limitPrice9 ?? req.estPrice9;
    if (px == null) throw new Error("placeOrder: qty order needs estPrice9 or limitPrice9 for the notional gates");
    return mul9(req.qty9, px);
  }
  throw new Error("placeOrder: need qty9 or notional9");
}

/** Open BUY reservations: submitted/unknown buy intents not yet terminal — their notional is spoken
 *  for even though the fill (and its cash event) hasn't landed yet. Same-day double-spend guard. */
export function openBuyReservations9(db: DatabaseSync): D9 {
  const rows = db
    .prepare("SELECT qty9, notional9 FROM order_intents WHERE side='buy' AND status IN ('submitted','unknown')")
    .all() as { qty9: string | null; notional9: string | null }[];
  return rows.reduce((acc, r) => acc + (r.notional9 ? d9(r.notional9) : 0n), 0n);
}

function recordIntent(db: DatabaseSync, req: PlaceRequest, coid: string, seq: number, status: string, extra: {
  skipReason?: string; submittedTs?: string; raw?: string;
} = {}): void {
  db.prepare(
    `INSERT INTO order_intents(client_order_id, sleeve, symbol, intent, date, seq, side, qty9, notional9,
       order_type, status, skip_reason, submitted_ts, last_checked_ts, config_version, raw_response)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(client_order_id) DO UPDATE SET
       status=excluded.status, skip_reason=excluded.skip_reason,
       submitted_ts=COALESCE(order_intents.submitted_ts, excluded.submitted_ts),
       last_checked_ts=excluded.last_checked_ts, raw_response=excluded.raw_response`,
  ).run(
    coid, req.owner, req.symbol, req.intent, req.asOfDate, seq, req.side,
    req.qty9 != null ? d9str(req.qty9) : null,
    req.notional9 != null ? d9str(req.notional9) : (req.qty9 != null ? d9str(estNotional9(req)) : null),
    req.type, status, extra.skipReason ?? null, extra.submittedTs ?? null,
    new Date().toISOString(), req.configVersion, extra.raw ?? null,
  );
}

export function markIntentStatus(db: DatabaseSync, coid: string, status: string, raw?: string, brokerOrderId?: string): void {
  db.prepare(
    "UPDATE order_intents SET status=?, last_checked_ts=?, raw_response=COALESCE(?, raw_response), broker_order_id=COALESCE(?, broker_order_id) WHERE client_order_id=?",
  ).run(status, new Date().toISOString(), raw ?? null, brokerOrderId ?? null, coid);
}

/** Mint (or reuse) the deterministic coid for this intent. If an UNKNOWN-status intent already
 *  exists for the same (sleeve,symbol,intent,date) key, its coid is returned for resolution/reuse
 *  instead of minting seq+1 — the resubmit-after-timeout path must not double-order. */
function mintCoid(db: DatabaseSync, req: PlaceRequest): { coid: string; seq: number; reusedUnknown: boolean } {
  const sym = req.symbol.toUpperCase();
  const unknown = db
    .prepare("SELECT client_order_id, seq FROM order_intents WHERE sleeve=? AND symbol=? AND intent=? AND date=? AND status='unknown' ORDER BY seq DESC LIMIT 1")
    .get(req.owner, sym, req.intent, req.asOfDate) as { client_order_id: string; seq: number } | undefined;
  if (unknown) return { coid: unknown.client_order_id, seq: unknown.seq, reusedUnknown: true };
  const row = db
    .prepare("SELECT COALESCE(MAX(seq),0) AS m FROM order_intents WHERE sleeve=? AND symbol=? AND intent=? AND date=?")
    .get(req.owner, sym, req.intent, req.asOfDate) as { m: number };
  const seq = Number(row.m) + 1;
  const coid = `${req.owner}:${sym}:${req.intent}:${req.asOfDate.replace(/-/g, "")}:${String(seq).padStart(2, "0")}`;
  if (coid.length > 48) throw new Error(`client_order_id too long (${coid.length} > 48): ${coid}`);
  return { coid, seq, reusedUnknown: false };
}

/** Pluggable extra gate (e.g. the book layer's day-trade guard). Non-null return = refuse. */
export type ExtraGuard = (db: DatabaseSync, req: PlaceRequest) => { skip: SkipReason; detail?: string } | null;

/** Place one order through the full gate stack. Never throws on a broker refusal — every outcome
 *  lands in order_intents and the returned PlaceResult. */
export async function placeOrder(db: DatabaseSync, broker: BrokerPort, req: PlaceRequest, cfg: {
  washBlacklistDays: number;
  extraGuards?: ExtraGuard[];
}): Promise<PlaceResult> {
  const sym = req.symbol.toUpperCase();
  const { coid, seq, reusedUnknown } = mintCoid(db, req);

  // Resolve a prior UNKNOWN before anything else: if the broker has it, we're done (idempotent).
  if (reusedUnknown) {
    const existing = await broker.queryByClientOrderId(coid);
    if (existing) {
      markIntentStatus(db, coid, "submitted", JSON.stringify(existing).slice(0, 500), existing?.id ? String(existing.id) : undefined);
      return { placed: true, clientOrderId: coid, order: existing, idempotent: true };
    }
    // Broker never saw it — fall through and resubmit under the SAME coid.
  }

  // Gate 1 — halts. halt:book is the GLOBAL freeze (reconciliation found fills/positions the
  // ledger can't explain → the cash truth is suspect → nothing trades until an operator clears it);
  // halt:<sleeve> freezes one sleeve.
  const halt = getState(db, "halt:book") ?? getState(db, `halt:${req.owner}`);
  if (halt) {
    recordIntent(db, req, coid, seq, "skipped", { skipReason: "SLEEVE_HALTED" });
    return { placed: false, clientOrderId: coid, skipped: "SLEEVE_HALTED", detail: halt };
  }

  // Gate 2 — $1 notional floor.
  const notional = estNotional9(req);
  if (notional < MIN_NOTIONAL9) {
    recordIntent(db, req, coid, seq, "skipped", { skipReason: "BELOW_NOTIONAL_FLOOR" });
    return { placed: false, clientOrderId: coid, skipped: "BELOW_NOTIONAL_FLOOR", detail: d9str(notional) };
  }

  // Gate 3 — 31-day re-entry blacklist (buys only; sells/stops exempt).
  if (req.side === "buy" && !req.blacklistExempt && lossExitWithin(db, sym, cfg.washBlacklistDays, req.asOfDate)) {
    recordIntent(db, req, coid, seq, "skipped", { skipReason: "WASH_BLACKLIST" });
    return { placed: false, clientOrderId: coid, skipped: "WASH_BLACKLIST" };
  }

  // Gate 4 — settled cash (buys only), net of open buy reservations.
  if (req.side === "buy") {
    const reserved = openBuyReservations9(db);
    const gate = gateBuy(db, notional + reserved, req.asOfDate);
    if (!gate.ok) {
      recordIntent(db, req, coid, seq, "skipped", { skipReason: "NO_SETTLED_CASH" });
      return {
        placed: false, clientOrderId: coid, skipped: "NO_SETTLED_CASH",
        detail: `need ${d9str(notional)} + reserved ${d9str(reserved)} > settled ${d9str(gate.settled9)}`,
      };
    }
  }

  // Gate 5 — pluggable extra guards (book layer: day-trade counter, brake hooks).
  for (const guard of cfg.extraGuards ?? []) {
    const verdict = guard(db, req);
    if (verdict) {
      recordIntent(db, req, coid, seq, "skipped", { skipReason: verdict.skip });
      return { placed: false, clientOrderId: coid, skipped: verdict.skip, detail: verdict.detail };
    }
  }

  // Submit. Record the intent BEFORE the wire call so an UNKNOWN outcome leaves a resolvable row.
  recordIntent(db, req, coid, seq, "unknown", { submittedTs: new Date().toISOString() });
  const wire: BrokerOrderRequest = {
    symbol: sym,
    side: req.side,
    type: req.type,
    time_in_force: req.tif ?? "day",
    client_order_id: coid,
    ...(req.qty9 != null ? { qty: d9str(req.qty9) } : {}),
    ...(req.notional9 != null ? { notional: wireNotional(req.notional9) } : {}),
    ...(req.limitPrice9 != null ? { limit_price: wirePrice(req.limitPrice9) } : {}),
    ...(req.stopPrice9 != null ? { stop_price: wirePrice(req.stopPrice9) } : {}),
  };
  const res = await broker.submit(wire);

  switch (res.outcome) {
    case "accepted":
      markIntentStatus(db, coid, "submitted", JSON.stringify(res.order).slice(0, 500), res.order?.id ? String(res.order.id) : undefined);
      return { placed: true, clientOrderId: coid, order: res.order };
    case "duplicate": {
      const existing = await broker.queryByClientOrderId(coid);
      markIntentStatus(db, coid, "submitted", res.body, existing?.id ? String(existing.id) : undefined);
      return { placed: true, clientOrderId: coid, order: existing ?? undefined, idempotent: true };
    }
    case "rejected":
      markIntentStatus(db, coid, `terminal:rejected:${res.status}`, res.body);
      return { placed: false, clientOrderId: coid, detail: `broker rejected ${res.status}: ${res.body}` };
    case "unknown":
      // Leave status=unknown — next run reuses this coid and queries before resubmitting.
      return { placed: false, clientOrderId: coid, detail: `outcome unknown: ${res.error}` };
  }
}
