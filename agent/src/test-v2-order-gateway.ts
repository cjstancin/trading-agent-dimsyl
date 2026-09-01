// Offline tests — v2 order gateway: gate stack, deterministic coids, unknown-outcome resolution.
// Mock broker only; no network, no env. Also greps the v2 sources for the forbidden buying_power
// read — the v1 killer bug class must be structurally impossible to reintroduce quietly.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openDb, setState } from "./v2/db.js";
import { d9 } from "./v2/decimal.js";
import { seedBook } from "./v2/settled-cash.js";
import { ingestFill } from "./v2/lots.js";
import { placeOrder, openBuyReservations9, markIntentStatus } from "./v2/order-gateway.js";
import { starvedNotVerdict } from "./v2/types.js";
import type { BrokerPort, BrokerOrderRequest, SubmitResult } from "./v2/broker.js";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${detail}`); }
}

function mockBroker(script: { submit?: SubmitResult[]; queryReturns?: (any | null)[] } = {}): BrokerPort & {
  submits: BrokerOrderRequest[]; queries: string[];
} {
  const submits: BrokerOrderRequest[] = [];
  const queries: string[] = [];
  const submitScript = [...(script.submit ?? [])];
  const queryScript = [...(script.queryReturns ?? [])];
  return {
    submits, queries,
    async submit(req) { submits.push(req); return submitScript.shift() ?? { outcome: "accepted", order: { id: `oid-${submits.length}`, status: "accepted" } }; },
    async queryByClientOrderId(coid) { queries.push(coid); return queryScript.length ? queryScript.shift()! : null; },
    async getOpenOrders() { return []; },
    async cancelOrder() { return true; },
  };
}

const CFG = { washBlacklistDays: 31 };
const BASE_REQ = {
  owner: "mom" as const, symbol: "AAPL", intent: "buy" as const, side: "buy" as const,
  type: "market" as const, asOfDate: "2026-08-17", configVersion: "v2c-test+0",
};

console.log("v2 order gateway:");

await (async () => {
  // Happy path: coid deterministic, intent recorded, submitted.
  const db = openDb(":memory:");
  seedBook(db, "5000", "2026-08-17");
  const b = mockBroker();
  const r1 = await placeOrder(db, b, { ...BASE_REQ, notional9: d9("500") }, CFG);
  check("placed", r1.placed === true);
  check("deterministic coid", r1.clientOrderId === "mom:AAPL:buy:20260817:01", r1.clientOrderId);
  check("wire uses notional string", b.submits[0].notional === "500" && b.submits[0].client_order_id === r1.clientOrderId);
  const intent = db.prepare("SELECT * FROM order_intents WHERE client_order_id=?").get(r1.clientOrderId!) as any;
  check("intent row submitted + broker id", intent.status === "submitted" && intent.broker_order_id === "oid-1");
  check("config version stamped", intent.config_version === "v2c-test+0");

  // Second same-key order → seq 02.
  const r2 = await placeOrder(db, b, { ...BASE_REQ, notional9: d9("500") }, CFG);
  check("seq increments", r2.clientOrderId === "mom:AAPL:buy:20260817:02");

  // Reservations: two submitted buys reserve 1000.
  check("open buy reservations", openBuyReservations9(db) === d9("1000"));

  // Settled-cash gate: 5000 − 1000 reserved → a 4500 buy must refuse.
  const r3 = await placeOrder(db, b, { ...BASE_REQ, notional9: d9("4500") }, CFG);
  check("cash gate refuses over-reserve", r3.placed === false && r3.skipped === "NO_SETTLED_CASH", r3.detail);
  // Terminal fill releases the reservation.
  markIntentStatus(db, "mom:AAPL:buy:20260817:01", "terminal:filled");
  check("terminal releases reservation", openBuyReservations9(db) === d9("500"));
})();

await (async () => {
  // Notional floor: the v1 residual bug class.
  const db = openDb(":memory:");
  seedBook(db, "5000", "2026-08-17");
  const b = mockBroker();
  const r = await placeOrder(db, b, { ...BASE_REQ, notional9: d9("0.97") }, CFG);
  check("sub-$1 refused, nothing hit the wire", r.skipped === "BELOW_NOTIONAL_FLOOR" && b.submits.length === 0);
  const qtyReq = await placeOrder(db, b, { ...BASE_REQ, qty9: d9("0.004"), estPrice9: d9("200") }, CFG);
  check("qty orders floor via estPrice", qtyReq.skipped === "BELOW_NOTIONAL_FLOOR");
})();

await (async () => {
  // Halts: sleeve halt blocks the sleeve; book halt blocks everyone.
  const db = openDb(":memory:");
  seedBook(db, "5000", "2026-08-17");
  const b = mockBroker();
  setState(db, "halt:mom", "test halt");
  const r = await placeOrder(db, b, { ...BASE_REQ, notional9: d9("100") }, CFG);
  check("sleeve halt refuses", r.skipped === "SLEEVE_HALTED" && b.submits.length === 0);
  const r2 = await placeOrder(db, b, { ...BASE_REQ, owner: "ins", symbol: "KVHI", notional9: d9("100") }, CFG);
  check("other sleeve unaffected", r2.placed === true);
  setState(db, "halt:book", "global freeze");
  const r3 = await placeOrder(db, b, { ...BASE_REQ, owner: "ins", symbol: "KVHI", notional9: d9("100") }, CFG);
  check("book halt freezes everything", r3.skipped === "SLEEVE_HALTED");
})();

await (async () => {
  // Wash blacklist: loss exit 10 days ago → buy refused; sells exempt.
  const db = openDb(":memory:");
  seedBook(db, "5000", "2026-08-17");
  ingestFill(db, { id: "f1", symbol: "TSLA", side: "buy", qty9: d9("5"), price9: d9("100"), ts: "2026-07-01T15:00:00Z", sleeve: "mom" });
  ingestFill(db, { id: "f2", symbol: "TSLA", side: "sell", qty9: d9("5"), price9: d9("90"), ts: "2026-08-07T15:00:00Z", sleeve: "mom" });
  const b = mockBroker();
  const r = await placeOrder(db, b, { ...BASE_REQ, symbol: "TSLA", notional9: d9("100") }, CFG);
  check("31-day blacklist refuses rebuy", r.skipped === "WASH_BLACKLIST" && b.submits.length === 0);
  const r2 = await placeOrder(db, b, { ...BASE_REQ, symbol: "TSLA", notional9: d9("100"), asOfDate: "2026-09-15" }, CFG);
  check("blacklist expires after 31d", r2.placed === true);
})();

await (async () => {
  // Unknown outcome → intent stays unknown; retry reuses the SAME coid and queries first.
  const db = openDb(":memory:");
  seedBook(db, "5000", "2026-08-17");
  const b1 = mockBroker({ submit: [{ outcome: "unknown", error: "ETIMEDOUT" }] });
  const r1 = await placeOrder(db, b1, { ...BASE_REQ, notional9: d9("500") }, CFG);
  check("unknown not placed", r1.placed === false && r1.clientOrderId === "mom:AAPL:buy:20260817:01");
  const st = db.prepare("SELECT status FROM order_intents WHERE client_order_id=?").get(r1.clientOrderId!) as any;
  check("intent status unknown", st.status === "unknown");

  // Retry A: broker HAS the order → resolved idempotent, NO resubmit.
  const b2 = mockBroker({ queryReturns: [{ id: "oid-77", status: "filled" }] });
  const r2 = await placeOrder(db, b2, { ...BASE_REQ, notional9: d9("500") }, CFG);
  check("retry queried by coid before resubmit", b2.queries[0] === "mom:AAPL:buy:20260817:01");
  check("retry idempotent, no wire order", r2.placed === true && r2.idempotent === true && b2.submits.length === 0);

  // Fresh unknown, retry B: broker does NOT have it → resubmit under the SAME coid.
  const db2 = openDb(":memory:");
  seedBook(db2, "5000", "2026-08-17");
  const b3 = mockBroker({ submit: [{ outcome: "unknown", error: "reset" }] });
  await placeOrder(db2, b3, { ...BASE_REQ, notional9: d9("500") }, CFG);
  const b4 = mockBroker();
  const r4 = await placeOrder(db2, b4, { ...BASE_REQ, notional9: d9("500") }, CFG);
  check("resubmit reuses coid (no seq bump)", r4.placed === true && r4.clientOrderId === "mom:AAPL:buy:20260817:01" && b4.submits[0].client_order_id === "mom:AAPL:buy:20260817:01");

  // Duplicate answer from broker → idempotent success.
  const db3 = openDb(":memory:");
  seedBook(db3, "5000", "2026-08-17");
  const b5 = mockBroker({ submit: [{ outcome: "duplicate", body: "duplicate client_order_id" }], queryReturns: [{ id: "oid-9", status: "accepted" }] });
  const r5 = await placeOrder(db3, b5, { ...BASE_REQ, notional9: d9("500") }, CFG);
  check("duplicate → idempotent success", r5.placed === true && r5.idempotent === true);

  // Rejection is terminal + recorded, never thrown.
  const db4 = openDb(":memory:");
  seedBook(db4, "5000", "2026-08-17");
  const b6 = mockBroker({ submit: [{ outcome: "rejected", status: 403, body: "insufficient buying power" }] });
  const r6 = await placeOrder(db4, b6, { ...BASE_REQ, notional9: d9("500") }, CFG);
  const st6 = db4.prepare("SELECT status FROM order_intents WHERE client_order_id=?").get(r6.clientOrderId!) as any;
  check("rejection recorded terminal", r6.placed === false && st6.status === "terminal:rejected:403");
})();

// Structural rail: no v2 source may read Alpaca's buying_power (comments explaining the rule are fine
// — this greps for property ACCESS patterns).
{
  const dir = fileURLToPath(new URL("./v2/", import.meta.url));
  const offenders: string[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".ts")) continue;
    const src = readFileSync(dir + f, "utf8")
      .split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
    if (/\.buying_power|\bbuying_power\s*[\]:]/.test(src) || /buyingPower/.test(src)) offenders.push(f);
  }
  check("no v2 source reads buying_power", offenders.length === 0, offenders.join(","));
}

// Wire formats: Alpaca rejects >2dp notionals (422 code 42210000 — the launch-week sweep/anchor
// rejections). Notional FLOORS to the cent; limit/stop prices round to the nearest cent.
await (async () => {
  const db = openDb(":memory:");
  seedBook(db, "5000", "2026-08-17");
  const b = mockBroker();
  const r = await placeOrder(db, b, { ...BASE_REQ, notional9: d9("1.520792275") }, CFG);
  check("9dp notional floors to cents on the wire", r.placed === true && b.submits[0].notional === "1.52", String(b.submits[0].notional));
  const r2 = await placeOrder(db, b, { ...BASE_REQ, symbol: "AXP", notional9: d9("114.11784375") }, CFG);
  check("launch-week reject case now wires 2dp", r2.placed === true && b.submits[1].notional === "114.11", String(b.submits[1].notional));
  const r3 = await placeOrder(db, b, {
    ...BASE_REQ, symbol: "ABCL", type: "limit" as const, qty9: d9("10"), estPrice9: d9("60"), limitPrice9: d9("59.996666667"),
  }, CFG);
  check("limit price rounds to nearest cent", r3.placed === true && b.submits[2].limit_price === "60", String(b.submits[2].limit_price));
  check("full-precision notional survives in the intent row",
    (db.prepare("SELECT notional9 FROM order_intents WHERE client_order_id=?").get(r.clientOrderId!) as any).notional9 === "1.520792275");
})();

console.log("gateway — starvedNotVerdict (shared marker-burn guard):");
{
  check("all SLEEVE_HALTED, placed 0 → blocked", starvedNotVerdict(0, ["SLEEVE_HALTED", "SLEEVE_HALTED"]) === true);
  check("all NO_SETTLED_CASH, placed 0 → blocked", starvedNotVerdict(0, ["NO_SETTLED_CASH"]) === true);
  check("mixed blocked + verdict skips, placed 0 → still blocked (keep is the safe side)",
    starvedNotVerdict(0, ["MIN_ORDER", "SLEEVE_HALTED"]) === true);
  check("anything placed → not blocked (marker may burn)", starvedNotVerdict(1, ["SLEEVE_HALTED"]) === false);
  check("placed 0 but only verdict skips → not blocked", starvedNotVerdict(0, ["WASH_BLACKLIST", "MIN_ORDER"]) === false);
  check("placed 0, no skips at all → not blocked", starvedNotVerdict(0, []) === false);
  check("null/undefined skips ignored", starvedNotVerdict(0, [null, undefined]) === false);
}

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("v2 order gateway: all green");
