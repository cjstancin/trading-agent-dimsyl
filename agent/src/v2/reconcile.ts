// Bull v2 — boot reconciliation (design §7): account → positions → open orders → FILL replay from
// the last stored activity id → diff vs the internal ledger. A mismatch HALTS the affected sleeve(s)
// and flags — never a silent auto-correct. The internal ledger is the performance truth; the Alpaca
// account is the position truth; this file is where the two must agree before anything trades.
//
// Also owns: resolving stale UNKNOWN order intents (query by coid), the stuck-order watchdog
// (marketable order sitting `new` past N minutes → alert + cancel), and the fill→cash replay that
// keeps the settled-cash ledger true (buys debit same-day, sells credit T+1 via the calendar).
import type { DatabaseSync } from "node:sqlite";
import { d9, d9str, mul9, type D9 } from "./decimal.js";
import { getState, setState } from "./db.js";
import { ingestFill, ledgerPositions } from "./lots.js";
import { scanWash } from "./wash.js";
import { recordCash, nextTradingDay } from "./settled-cash.js";
import { markIntentStatus } from "./order-gateway.js";
import type { BrokerPort, ReadPort } from "./broker.js";

const FILLS_CURSOR_KEY = "fills_cursor";

export interface ReconcileReport {
  ok: boolean;                       // false → at least one halt was set
  newFills: number;
  newDisposals: number;
  washMatches: number;
  untaggedFills: string[];           // fill ids with no resolvable sleeve (manual/dashboard orders)
  mismatches: { symbol: string; ledger9: string; broker9: string; haltedSleeves: string[] }[];
  cashLedger9: string;               // internal total cash
  brokerCash9: string;               // Alpaca account cash
  cashDelta9: string;
  resolvedUnknownIntents: number;
  stuckOrders: { id: string; symbol: string; ageMinutes: number; canceled: boolean }[];
  notes: string[];
}

/** Sleeve for a broker order id, resolved through the order_intents audit trail. */
function sleeveForOrderId(db: DatabaseSync, orderId: string | undefined): string | null {
  if (!orderId) return null;
  const row = db.prepare("SELECT sleeve FROM order_intents WHERE broker_order_id=?").get(String(orderId)) as
    | { sleeve: string }
    | undefined;
  return row ? row.sleeve : null;
}

/** Replay new FILL activities into the tax + cash ledgers. Idempotent (fill id PK, cash ref unique). */
export async function replayFills(
  db: DatabaseSync,
  read: ReadPort,
  opts: { sessions?: string[] } = {},
): Promise<{ newFills: number; newDisposals: number; untagged: string[] }> {
  const cursor = getState(db, FILLS_CURSOR_KEY) ?? undefined;
  const activities = await read.getFillActivities(cursor);
  let newFills = 0;
  let newDisposals = 0;
  const untagged: string[] = [];

  for (const a of activities) {
    const side = String(a.side ?? "").toLowerCase();
    if (side !== "buy" && side !== "sell") continue; // sell_short etc. can't exist in this book — flagged by the diff below
    const qty = d9(String(a.qty));
    const price = d9(String(a.price));
    const sleeve = sleeveForOrderId(db, a.order_id ? String(a.order_id) : undefined);
    const ts = String(a.transaction_time);
    const dateKey = ts.slice(0, 10);

    const { inserted, disposals } = ingestFill(db, {
      id: String(a.id),
      orderId: a.order_id ? String(a.order_id) : undefined,
      symbol: String(a.symbol).toUpperCase(),
      side,
      qty9: qty,
      price9: price,
      ts,
      sleeve,
      raw: JSON.stringify(a).slice(0, 1000),
    });
    if (inserted) {
      newFills++;
      newDisposals += disposals.length;
      if (!sleeve) untagged.push(String(a.id));
      const gross = mul9(qty, price);
      if (side === "buy") {
        recordCash(db, { ts, kind: "buy", symbol: String(a.symbol).toUpperCase(), amount9: -gross, settlesOn: dateKey, ref: String(a.id) });
      } else {
        recordCash(db, {
          ts, kind: "sell", symbol: String(a.symbol).toUpperCase(), amount9: gross,
          settlesOn: nextTradingDay(dateKey, opts.sessions), ref: String(a.id),
        });
      }
      setState(db, FILLS_CURSOR_KEY, String(a.id));
    }
  }
  return { newFills, newDisposals, untagged };
}

/** Full boot reconciliation. Sets halt:<sleeve> / halt:book on mismatch; clearing a halt is an
 *  OPERATOR action (dashboard/CLI), deliberately not automatic. */
export async function reconcileBoot(
  db: DatabaseSync,
  broker: BrokerPort,
  read: ReadPort,
  opts: { stuckOrderMinutes?: number; now?: Date } = {},
): Promise<ReconcileReport> {
  const now = opts.now ?? new Date();
  const notes: string[] = [];

  // 1 — sessions window for T+1 settlement of replayed sells.
  let sessions: string[] | undefined;
  try {
    const start = now.toISOString().slice(0, 10);
    const end = new Date(now.getTime() + 14 * 86_400_000).toISOString().slice(0, 10);
    sessions = await read.getSessions(start, end);
  } catch {
    notes.push("calendar unreachable — T+1 settlement falls back to the offline NYSE calendar");
  }

  // 2 — replay fills into the ledgers, then the wash scan.
  const replay = await replayFills(db, read, { sessions });
  const washMatches = scanWash(db, now.toISOString()).length;

  // 3 — resolve stale UNKNOWN intents by coid (never resubmit here — the gateway owns resubmits).
  const unknowns = db.prepare("SELECT client_order_id FROM order_intents WHERE status='unknown'").all() as { client_order_id: string }[];
  let resolvedUnknown = 0;
  for (const u of unknowns) {
    const o = await broker.queryByClientOrderId(u.client_order_id);
    if (o) {
      const st = String(o.status ?? "");
      const terminal = ["filled", "canceled", "expired", "rejected", "done_for_day", "replaced"].includes(st);
      markIntentStatus(db, u.client_order_id, terminal ? `terminal:${st}` : "submitted", undefined, o.id ? String(o.id) : undefined);
      resolvedUnknown++;
    }
  }

  // 4 — sync submitted intents that have since gone terminal (releases buy reservations).
  const submitted = db.prepare("SELECT client_order_id FROM order_intents WHERE status='submitted'").all() as { client_order_id: string }[];
  for (const s of submitted) {
    const o = await broker.queryByClientOrderId(s.client_order_id);
    const st = String(o?.status ?? "");
    if (o && ["filled", "canceled", "expired", "rejected", "done_for_day", "replaced"].includes(st)) {
      markIntentStatus(db, s.client_order_id, `terminal:${st}`, undefined, o.id ? String(o.id) : undefined);
    }
  }

  // 5 — position diff: ledger vs broker, exact d9 compare. Mismatch halts the owning sleeve(s);
  //     a position the ledger can't explain (or untagged fills) halts the BOOK — cash truth suspect.
  const brokerPositions = await read.getPositions();
  const brokerMap = new Map<string, D9>();
  for (const p of brokerPositions) brokerMap.set(String(p.symbol).toUpperCase(), d9(String(p.qty)));
  const ledgerMap = ledgerPositions(db);

  const mismatches: ReconcileReport["mismatches"] = [];
  const symbols = new Set([...brokerMap.keys(), ...ledgerMap.keys()]);
  for (const sym of symbols) {
    const led = ledgerMap.get(sym) ?? 0n;
    const bro = brokerMap.get(sym) ?? 0n;
    if (led === bro) continue;
    const owners = db.prepare("SELECT DISTINCT sleeve FROM lots WHERE symbol=? AND sleeve IS NOT NULL").all(sym) as { sleeve: string }[];
    const halted: string[] = [];
    if (owners.length) {
      for (const o of owners) {
        setState(db, `halt:${o.sleeve}`, `reconcile mismatch ${sym}: ledger ${d9str(led)} vs broker ${d9str(bro)} @ ${now.toISOString()}`);
        halted.push(o.sleeve);
      }
    } else {
      setState(db, "halt:book", `unexplained broker position ${sym}: ledger ${d9str(led)} vs broker ${d9str(bro)} @ ${now.toISOString()}`);
      halted.push("book");
    }
    mismatches.push({ symbol: sym, ledger9: d9str(led), broker9: d9str(bro), haltedSleeves: halted });
  }
  if (replay.untagged.length) {
    setState(db, "halt:book", `untagged fills (manual/dashboard orders?): ${replay.untagged.slice(0, 5).join(",")} @ ${now.toISOString()}`);
    notes.push(`${replay.untagged.length} fill(s) have no resolvable sleeve — book halted pending operator review`);
  }

  // 6 — cash diff (informational; the position diff owns halting). Internal total cash should track
  //     Alpaca's cash for a no-margin, no-shorting book once dividends are self-credited.
  const account = await read.getAccount().catch(() => null);
  const brokerCash = account ? d9(String(account.cash ?? "0")) : 0n;
  const rows = db.prepare("SELECT amount9 FROM cash_events").all() as { amount9: string }[];
  const internalCash = rows.reduce((a, r) => a + d9(r.amount9), 0n);
  const cashDelta = internalCash - brokerCash;
  if (account && cashDelta !== 0n) notes.push(`cash delta (internal − broker): ${d9str(cashDelta)} — expected only from pending self-credited dividends/fees`);

  // 7 — stuck-order watchdog: a marketable order still `new` past N minutes → alert + cancel.
  const stuckMin = opts.stuckOrderMinutes ?? 10;
  const stuck: ReconcileReport["stuckOrders"] = [];
  try {
    const open = await broker.getOpenOrders();
    for (const o of open) {
      const status = String(o.status ?? "");
      const isMarketable = String(o.type ?? "") === "market";
      const submittedAt = o.submitted_at ? new Date(String(o.submitted_at)).getTime() : NaN;
      const ageMin = Number.isFinite(submittedAt) ? (now.getTime() - submittedAt) / 60_000 : 0;
      if (status === "new" && isMarketable && ageMin >= stuckMin) {
        const canceled = await broker.cancelOrder(String(o.id));
        stuck.push({ id: String(o.id), symbol: String(o.symbol), ageMinutes: Math.round(ageMin), canceled });
      }
    }
  } catch {
    notes.push("open-orders read failed — stuck-order watchdog skipped this run");
  }

  return {
    ok: mismatches.length === 0 && replay.untagged.length === 0,
    newFills: replay.newFills,
    newDisposals: replay.newDisposals,
    washMatches,
    untaggedFills: replay.untagged,
    mismatches,
    cashLedger9: d9str(internalCash),
    brokerCash9: d9str(brokerCash),
    cashDelta9: d9str(cashDelta),
    resolvedUnknownIntents: resolvedUnknown,
    stuckOrders: stuck,
    notes,
  };
}
