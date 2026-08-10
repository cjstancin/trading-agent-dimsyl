// Offline tests — v2 boot reconciliation: fill replay → ledgers, cursor idempotency, mismatch
// halting (sleeve vs book), unknown-intent resolution, stuck-order watchdog. Mock ports only.
import { openDb, getState, setState } from "./v2/db.js";
import { d9, d9str } from "./v2/decimal.js";
import { seedBook, settledCash } from "./v2/settled-cash.js";
import { ledgerPosition } from "./v2/lots.js";
import { reconcileBoot } from "./v2/reconcile.js";
import { placeOrder } from "./v2/order-gateway.js";
import type { BrokerPort, ReadPort, SubmitResult } from "./v2/broker.js";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${detail}`); }
}

interface MockWorld {
  account: any;
  positions: any[];
  fills: any[];
  openOrders: any[];
  ordersByCoid: Record<string, any>;
}

function ports(w: MockWorld): { broker: BrokerPort & { canceled: string[] }; read: ReadPort } {
  const canceled: string[] = [];
  return {
    broker: {
      canceled,
      async submit(): Promise<SubmitResult> { return { outcome: "accepted", order: { id: "oid-live", status: "accepted" } }; },
      async queryByClientOrderId(coid) { return w.ordersByCoid[coid] ?? null; },
      async getOpenOrders() { return w.openOrders; },
      async cancelOrder(id) { canceled.push(id); return true; },
    },
    read: {
      async getAccount() { return w.account; },
      async getPositions() { return w.positions; },
      async getFillActivities(afterId?: string) { return w.fills.filter((f) => !afterId || String(f.id) > afterId); },
      async getSessions() { return ["2026-08-17", "2026-08-18", "2026-08-19", "2026-08-20", "2026-08-21", "2026-08-24"]; },
    },
  };
}

console.log("v2 reconcile:");

await (async () => {
  // Clean world: an intent-tagged buy fill replays into lots + cash; positions agree; ok=true.
  const db = openDb(":memory:");
  seedBook(db, "5000", "2026-08-17");
  const world: MockWorld = {
    account: { cash: "3000" },
    positions: [{ symbol: "AAPL", qty: "10" }],
    fills: [],
    openOrders: [],
    ordersByCoid: {},
  };
  const { broker, read } = ports(world);

  // Place through the gateway so the intent carries the broker order id → sleeve resolution works.
  const placed = await placeOrder(db, broker, {
    owner: "mom", symbol: "AAPL", intent: "buy", side: "buy", type: "market",
    notional9: d9("2000"), asOfDate: "2026-08-17", configVersion: "t",
  }, { washBlacklistDays: 31 });
  check("setup: order placed", placed.placed === true);

  world.fills = [{ id: "act-001", order_id: "oid-live", symbol: "AAPL", side: "buy", qty: "10", price: "200", transaction_time: "2026-08-17T14:31:00Z" }];
  world.ordersByCoid[placed.clientOrderId!] = { id: "oid-live", status: "filled" };

  const rep = await reconcileBoot(db, broker, read);
  check("clean reconcile ok", rep.ok === true, JSON.stringify(rep.mismatches));
  check("fill replayed into lots", d9str(ledgerPosition(db, "AAPL")) === "10");
  check("fill tagged with sleeve", (db.prepare("SELECT sleeve FROM fills WHERE id='act-001'").get() as any).sleeve === "mom");
  check("cash debited", d9str(settledCash(db, "2026-08-17")) === "3000");
  check("cash matches broker", rep.cashDelta9 === "0");
  check("intent went terminal", (db.prepare("SELECT status FROM order_intents").get() as any).status === "terminal:filled");
  check("no halts", getState(db, "halt:mom") === null && getState(db, "halt:book") === null);

  // Second run: cursor makes replay idempotent.
  const rep2 = await reconcileBoot(db, broker, read);
  check("cursor: no re-replay", rep2.newFills === 0 && d9str(ledgerPosition(db, "AAPL")) === "10");

  // Sell fill: proceeds settle T+1 per injected sessions.
  world.fills.push({ id: "act-002", order_id: "oid-live", symbol: "AAPL", side: "sell", qty: "4", price: "210", transaction_time: "2026-08-18T15:00:00Z" });
  world.positions = [{ symbol: "AAPL", qty: "6" }];
  world.account = { cash: "3840" };
  const rep3 = await reconcileBoot(db, broker, read);
  check("sell replayed, disposal created", rep3.newDisposals === 1);
  check("proceeds unsettled same day", d9str(settledCash(db, "2026-08-18")) === "3000");
  check("proceeds settled T+1", d9str(settledCash(db, "2026-08-19")) === "3840");
  check("still ok", rep3.ok === true);
})();

await (async () => {
  // Mismatch on a sleeve-owned symbol → that sleeve halts (not the book).
  const db = openDb(":memory:");
  seedBook(db, "5000", "2026-08-17");
  const world: MockWorld = {
    account: { cash: "5000" }, positions: [{ symbol: "TSLA", qty: "7" }], fills: [], openOrders: [], ordersByCoid: {},
  };
  const { broker, read } = ports(world);
  // Ledger thinks 5 TSLA under insider (hand-planted lot via a tagged fill).
  db.prepare("INSERT INTO fills(id,symbol,side,qty9,price9,ts,sleeve,raw) VALUES('m1','TSLA','buy','5','100','2026-08-10T14:00:00Z','ins','{}')").run();
  db.prepare(`INSERT INTO lots(symbol,sleeve,open_fill_id,open_ts,holding_period_start_ts,qty_open9,qty_remaining9,basis_total9,basis_remaining9)
              VALUES('TSLA','ins','m1','2026-08-10T14:00:00Z','2026-08-10T14:00:00Z','5','5','500','500')`).run();
  const rep = await reconcileBoot(db, broker, read);
  check("mismatch flagged", rep.ok === false && rep.mismatches.length === 1);
  check("owning sleeve halted", rep.mismatches[0].haltedSleeves.join(",") === "ins" && getState(db, "halt:ins") !== null);
  check("book NOT halted for sleeve mismatch", getState(db, "halt:book") === null);
})();

await (async () => {
  // Unexplained broker position + untagged fill → BOOK halt (cash truth suspect).
  const db = openDb(":memory:");
  seedBook(db, "5000", "2026-08-17");
  const world: MockWorld = {
    account: { cash: "4000" },
    positions: [{ symbol: "GME", qty: "3" }],
    fills: [{ id: "act-x", order_id: "manual-1", symbol: "GME", side: "buy", qty: "3", price: "333.333333333", transaction_time: "2026-08-17T15:00:00Z" }],
    openOrders: [], ordersByCoid: {},
  };
  const { broker, read } = ports(world);
  const rep = await reconcileBoot(db, broker, read);
  check("untagged fill detected", rep.untaggedFills.length === 1);
  check("book halted", rep.ok === false && getState(db, "halt:book") !== null);
})();

await (async () => {
  // Unknown intent resolution + stuck-order watchdog.
  const db = openDb(":memory:");
  seedBook(db, "5000", "2026-08-17");
  db.prepare(`INSERT INTO order_intents(client_order_id,sleeve,symbol,intent,date,seq,side,notional9,order_type,status,config_version)
              VALUES('mom:NVDA:buy:20260817:01','mom','NVDA','buy','2026-08-17',1,'buy','500','market','unknown','t')`).run();
  const world: MockWorld = {
    account: { cash: "5000" }, positions: [], fills: [],
    openOrders: [
      { id: "stuck-1", symbol: "NVDA", status: "new", type: "market", submitted_at: "2026-08-17T14:00:00Z" },
      { id: "fresh-1", symbol: "AMD", status: "new", type: "market", submitted_at: "2026-08-17T14:29:30Z" },
      { id: "limit-1", symbol: "MSFT", status: "new", type: "limit", submitted_at: "2026-08-17T10:00:00Z" },
    ],
    ordersByCoid: { "mom:NVDA:buy:20260817:01": { id: "oid-42", status: "canceled" } },
  };
  const { broker, read } = ports(world);
  const rep = await reconcileBoot(db, broker, read, { now: new Date("2026-08-17T14:30:00Z"), stuckOrderMinutes: 10 });
  check("unknown intent resolved via coid", rep.resolvedUnknownIntents === 1);
  const st = db.prepare("SELECT status, broker_order_id FROM order_intents WHERE client_order_id='mom:NVDA:buy:20260817:01'").get() as any;
  check("resolved to terminal:canceled + broker id", st.status === "terminal:canceled" && st.broker_order_id === "oid-42");
  check("stuck market order canceled", rep.stuckOrders.length === 1 && rep.stuckOrders[0].id === "stuck-1" && (broker as any).canceled.includes("stuck-1"));
  check("fresh + limit orders untouched", !(broker as any).canceled.includes("fresh-1") && !(broker as any).canceled.includes("limit-1"));
})();

await (async () => {
  // Operator clears a halt → trading resumes (the clear path exists and is manual by design).
  const db = openDb(":memory:");
  setState(db, "halt:book", "test");
  db.prepare("DELETE FROM state WHERE key='halt:book'").run();
  check("halt clear is a plain state delete", getState(db, "halt:book") === null);
})();

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("v2 reconcile: all green");
