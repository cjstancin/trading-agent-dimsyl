// One-off recovery ritual: for every OPEN paper position that has NO matching open trailing-stop
// sell order, place one with BILL_TRAIL_PCT (default 20). Idempotent — re-running is safe; orders
// already covered are skipped. Use it after a partial fail (e.g. today's race where the buy was
// still open when the stop was rejected).
//   npm run backfill-stops               # uses BILL_TRAIL_PCT or 20% default
//   BILL_TRAIL_PCT=15 npm run backfill-stops
import "./load-env.js";
import { getPositions, getOpenOrders, placeTrailingStop } from "./alpaca.js";

const trailPct = Number(process.env.BILL_TRAIL_PCT || 20);
if (!(trailPct > 0 && trailPct < 90)) { console.error(`bad BILL_TRAIL_PCT=${trailPct}`); process.exit(2); }

const [positions, openOrders] = await Promise.all([
  getPositions() as Promise<any[]>,
  getOpenOrders() as Promise<any[]>,
]);

const trailingStopsBySymbol = new Map<string, any>();
for (const o of openOrders || []) {
  if (o?.side === "sell" && (o?.type === "trailing_stop" || o?.order_type === "trailing_stop")) {
    trailingStopsBySymbol.set(String(o.symbol).toUpperCase(), o);
  }
}

const results: any[] = [];
for (const p of positions || []) {
  const sym = String(p.symbol).toUpperCase();
  const qty = Math.abs(Number(p.qty || 0));
  const isLong = String(p.side || "").toLowerCase() === "long";
  if (!isLong || qty <= 0) { results.push({ sym, skipped: true, reason: "not long or zero qty" }); continue; }
  if (trailingStopsBySymbol.has(sym)) { results.push({ sym, skipped: true, reason: "already has trailing stop" }); continue; }
  try {
    const stop: any = await placeTrailingStop(sym, qty, trailPct);
    results.push({ sym, ok: true, qty, trailPct, orderId: stop?.id });
  } catch (e: any) {
    results.push({ sym, ok: false, qty, error: String(e?.message || e).slice(0, 200) });
  }
}

console.log(JSON.stringify({ ok: true, trailPct, results }, null, 2));
const failed = results.filter((r) => r.ok === false).length;
process.exitCode = failed > 0 ? 1 : 0;
