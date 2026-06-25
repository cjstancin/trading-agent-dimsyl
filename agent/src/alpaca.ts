// Alpaca PAPER client. Reads are always allowed; PLACEMENT only happens via placePaperOrder,
// which the execution ritual calls solely in auto mode (double-gated). Hard guard: paper endpoint only.
// Accept the paper host with or without a trailing "/v2" or slash — the client appends "/v2/..." itself.
// Normalize first, then HARD-require the paper host: any live/non-paper host still throws. Bill is paper-only.
import { withTimeout, DEFAULT_TIMEOUT_MS } from "./http-utils.js";
import { randomBytes } from "node:crypto";

/** Generate an Alpaca client_order_id for idempotency. Per the §0 fleet rule:
 *   <service>-<operation>-<uuid>  →  bill-<symbol>-<YYYYMMDD-HHmm>-<8hex>
 * Alpaca rejects duplicate client_order_ids within 24h, so retrying a placement that already filled
 * (network hiccup, harness restart, etc.) returns a 422 "duplicate client_order_id" we treat as a
 * SAFE no-op. Max 48 chars per Alpaca; this template is ~30. */
export function billOrderId(symbol: string, suffix = ""): string {
  const sym = symbol.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  const ts = new Date().toISOString().slice(0, 16).replace(/[-T:]/g, "");
  const r = randomBytes(4).toString("hex");
  return `bill-${sym}-${ts}-${r}${suffix ? "-" + suffix : ""}`.slice(0, 48);
}

const RAW_BASE = process.env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets";
const BASE = RAW_BASE.replace(/\/+$/, "").replace(/\/v2$/, "");
// Reads/writes against Alpaca must time out — a stalled broker cannot pin a trading ritual.
const ALPACA_TIMEOUT_MS = parseInt(process.env.ALPACA_TIMEOUT_MS || String(DEFAULT_TIMEOUT_MS), 10);

if (BASE !== "https://paper-api.alpaca.markets") {
  throw new Error(`Refusing non-paper Alpaca base URL: "${RAW_BASE}". Bill is paper-only (host must be paper-api.alpaca.markets).`);
}

function authHeaders(): Record<string, string> {
  const id = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_API_SECRET;
  if (!id || !secret) throw new Error("ALPACA_API_KEY / ALPACA_API_SECRET not set");
  return { "APCA-API-KEY-ID": id, "APCA-API-SECRET-KEY": secret };
}

async function get(path: string, host = BASE): Promise<unknown> {
  const res = await withTimeout((signal) => fetch(host + path, { headers: authHeaders(), signal }), ALPACA_TIMEOUT_MS);
  if (!res.ok) throw new Error(`Alpaca GET ${path} → ${res.status}`);
  return res.json();
}

/** Sentinel an idempotency dup throws (and that callers catch + treat as success). */
export class DuplicateClientOrderIdError extends Error {
  constructor(public clientOrderId: string, public bodyText: string) {
    super(`duplicate client_order_id (treat as success): ${clientOrderId}`);
    this.name = "DuplicateClientOrderIdError";
  }
}

/** Classifier: does this Alpaca POST response mean the client_order_id was already used?
 *  Alpaca answers a re-used id (within 24h) with HTTP 422 + a body containing "duplicate
 *  client_order_id" — i.e. a PRIOR placement of THIS request already landed. Pure (no I/O) so the
 *  idempotency guard can be unit-tested without a live order. Specific by design: other 422s (e.g.
 *  insufficient buying power) are NOT duplicates and must still surface as errors. */
export function isDuplicateClientOrderIdResponse(status: number, bodyText: string): boolean {
  return status === 422 && /duplicate client_order_id/i.test(bodyText);
}

async function post(path: string, body: unknown): Promise<unknown> {
  const res = await withTimeout((signal) => fetch(BASE + path, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  }), ALPACA_TIMEOUT_MS);
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    // Idempotency win: if Alpaca rejects because the client_order_id already exists, that means a
    // PRIOR placement of THIS request already landed. Don't fail — the desired effect is already in
    // place. Caller catches this sentinel + treats it as success.
    if (isDuplicateClientOrderIdResponse(res.status, t)) {
      const coid = typeof body === "object" && body && "client_order_id" in body ? String((body as any).client_order_id) : "";
      throw new DuplicateClientOrderIdError(coid, t.slice(0, 200));
    }
    throw new Error(`Alpaca POST ${path} → ${res.status}: ${t.slice(0, 160)}`);
  }
  return res.json();
}

export const getAccount = () => get("/v2/account");
export const getPositions = () => get("/v2/positions");
export const getOpenOrders = () => get("/v2/orders?status=open&limit=100");
export const getOrder = (id: string) => get(`/v2/orders/${encodeURIComponent(id)}`);

/** Place a standalone protective trailing-stop SELL with an idempotency-safe client_order_id.
 *  Used by the backfill script + the post-fill leg of placePaperOrder. trail_percent is a number
 *  (e.g. 20 for 20%); time_in_force is GTC. If a prior call already placed this exact stop, returns
 *  null silently (DuplicateClientOrderIdError swallowed). */
export async function placeTrailingStop(symbol: string, qty: number, trailPercent: number, clientOrderId?: string): Promise<unknown | null> {
  const coid = clientOrderId || billOrderId(symbol, "stop");
  try {
    return await post("/v2/orders", {
      symbol,
      qty,
      side: "sell",
      type: "trailing_stop",
      trail_percent: String(trailPercent),
      time_in_force: "gtc",
      client_order_id: coid,
    });
  } catch (e) {
    if (e instanceof DuplicateClientOrderIdError) return null;
    throw e;
  }
}

/**
 * Poll a specific order until it reaches a TERMINAL state (filled / canceled / expired / rejected /
 * done_for_day). Returns the final order object (or null on timeout). Bounded so an open order
 * can't pin the caller forever. Default poll interval 1s, default timeout 45s.
 */
export async function waitForOrderTerminal(
  orderId: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<any | null> {
  const deadline = Date.now() + (opts.timeoutMs ?? 45_000);
  const interval = opts.intervalMs ?? 1_000;
  const TERMINAL = new Set(["filled", "canceled", "expired", "rejected", "done_for_day", "replaced"]);
  for (;;) {
    let o: any = null;
    try { o = await getOrder(orderId); } catch { /* transient — retry */ }
    if (o && o.status && TERMINAL.has(String(o.status))) return o;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, interval));
  }
}
/** Cancel one open order by id. 404 (gone) / 422 (uncancelable, already terminal) are treated as a
 *  successful no-op — the desired end-state (order not working) already holds. Never throws. */
export async function cancelOrder(orderId: string): Promise<boolean> {
  try {
    const res = await withTimeout((signal) => fetch(`${BASE}/v2/orders/${encodeURIComponent(orderId)}`, {
      method: "DELETE", headers: authHeaders(), signal,
    }), ALPACA_TIMEOUT_MS);
    return res.ok || res.status === 404 || res.status === 422;
  } catch { return false; }
}

/** Liquidate the FULL paper position in `symbol` at market — the rotation/swap SELL leg. First explicitly
 *  cancels the symbol's open orders (the protective trailing stop) so the liquidation can't conflict or
 *  leave an orphan stop, then DELETEs the position (also with cancel_orders=true as a belt-and-suspenders).
 *  404 = already flat (safe no-op). Returns the liquidation order so the caller can poll it via
 *  waitForOrderTerminal before re-buying (freed buying power settles on fill). Paper-guarded by BASE. */
export async function closePosition(symbol: string): Promise<{ ok: boolean; order?: any; alreadyFlat?: boolean; canceledStops: number }> {
  const sym = symbol.toUpperCase();
  let canceledStops = 0;
  try {
    const open = (await getOpenOrders()) as any[];
    for (const o of Array.isArray(open) ? open : []) {
      if (o?.id && String(o.symbol).toUpperCase() === sym) { if (await cancelOrder(String(o.id))) canceledStops++; }
    }
  } catch { /* if listing fails, the DELETE below still requests cancel of related orders */ }
  const res = await withTimeout((signal) => fetch(`${BASE}/v2/positions/${encodeURIComponent(sym)}?cancel_orders=true`, {
    method: "DELETE", headers: authHeaders(), signal,
  }), ALPACA_TIMEOUT_MS);
  if (res.status === 404) return { ok: true, alreadyFlat: true, canceledStops };
  if (!res.ok) { const t = await res.text().catch(() => ""); throw new Error(`Alpaca DELETE position ${sym} → ${res.status}: ${t.slice(0, 160)}`); }
  const order = await res.json().catch(() => null);
  return { ok: true, order, canceledStops };
}

/** Market-sell a specific (possibly fractional) qty of a long position — used for PARTIAL profit trims
 *  (sell into strength, keep the rest running). Fractional sells are market + TIF=day + marked-long on Alpaca.
 *  Idempotency-keyed; a duplicate within 24h is a safe no-op. Caller must size qty ≤ the held quantity. */
export async function sellQty(symbol: string, qty: number): Promise<{ ok: boolean; order?: any; idempotent?: boolean }> {
  if (!(qty > 0)) return { ok: false };
  const coid = billOrderId(symbol, "trim");
  try {
    const order = await post("/v2/orders", { symbol, qty, side: "sell", type: "market", time_in_force: "day", client_order_id: coid });
    return { ok: true, order };
  } catch (e) {
    if (e instanceof DuplicateClientOrderIdError) return { ok: true, idempotent: true };
    throw e;
  }
}

// For measurement (Bull v2): fills for the blotter + ledger reconciliation, and the equity curve.
export const getActivities = (type = "FILL") => get(`/v2/account/activities/${encodeURIComponent(type)}`);
export const getClosedOrders = (limit = 200) => get(`/v2/orders?status=closed&limit=${limit}&direction=desc`);
export const getPortfolioHistory = (period = "1M", timeframe = "1D") =>
  get(`/v2/account/portfolio/history?period=${encodeURIComponent(period)}&timeframe=${encodeURIComponent(timeframe)}&extended_hours=false`);

// Latest trade price from Alpaca market data (read-only; data host, NOT the trading host — used to size
// orders from the real price so the model's price estimates can't mis-size a position). null on failure.
export async function latestPrice(symbol: string): Promise<number | null> {
  try {
    // feed=iex — free tier for paper accounts (default SIP needs a paid subscription → would 403/empty).
    const r = await withTimeout((signal) => fetch(
      `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol)}/trades/latest?feed=iex`,
      { headers: authHeaders(), signal },
    ), ALPACA_TIMEOUT_MS);
    if (!r.ok) return null;
    const j = (await r.json()) as { trade?: { p?: number } };
    const p = j?.trade?.p;
    return typeof p === "number" && p > 0 ? p : null;
  } catch { return null; }
}

export interface AlpacaBar { t: string; o: number; h: number; l: number; c: number; v: number; }

// Read-only price bars over a hold window from Alpaca market data (data host, NOT the trading host) —
// feeds the closed-trade MAE/MFE excursion math. feed=iex (free paper tier), adjustment=raw, sorted
// ascending. Bounded by withTimeout; NEVER places an order; returns [] on any failure so callers (the
// journal) degrade gracefully. start/end are RFC3339 or YYYY-MM-DD; Alpaca returns bars timestamped in
// [start, end). Mirrors latestPrice — a pure read on the data API, no money rail.
export async function getBars(symbol: string, start: string, end: string, timeframe = "1Day", limit = 1000): Promise<AlpacaBar[]> {
  try {
    const qs = new URLSearchParams({ timeframe, start, end, feed: "iex", adjustment: "raw", sort: "asc", limit: String(limit) });
    const r = await withTimeout((signal) => fetch(
      `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol)}/bars?${qs.toString()}`,
      { headers: authHeaders(), signal },
    ), ALPACA_TIMEOUT_MS);
    if (!r.ok) return [];
    const j = (await r.json()) as { bars?: AlpacaBar[] };
    return Array.isArray(j?.bars) ? j.bars : [];
  } catch { return []; }
}

export interface PaperSnapshot {
  connected: boolean;
  account?: unknown;
  positions?: unknown;
  openOrders?: unknown;
  error?: string;
}

/** Resilient read: returns a snapshot, or { connected:false, error } if keys/endpoint are missing — never throws. */
export async function paperSnapshot(): Promise<PaperSnapshot> {
  try {
    const [account, positions, openOrders] = await Promise.all([getAccount(), getPositions(), getOpenOrders()]);
    return { connected: true, account, positions, openOrders };
  } catch (err) {
    return { connected: false, error: String(err instanceof Error ? err.message : err) };
  }
}

export interface OrderRequest {
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  type: "market" | "limit";
  limit_price?: number;
  est_price: number;        // agent's expected fill price — used for guardrail sizing checks
  trail_percent?: number;   // protective stop %. Whole-share → broker trailing stop; fractional → SYNTHETIC (refresh monitor)
  thesis?: string;
  confidence?: number;      // 0–100 conviction (Bull v2 #5)
  setup?: string;           // setup label, e.g. "momentum breakout" (Bull v2 #5)
  fractional?: boolean;     // fractional/notional qty → place market+day, NO broker stop (Alpaca limit); synthetic stop protects
}

/** Place a PAPER entry order and (for buys) attach a protective trailing stop. Paper-guarded by BASE check above.
 *
 * Important: Alpaca rejects a sell order while the matching buy is still OPEN (error 40310000:
 * "cannot open a short sell while a long buy order is open"). The buy needs to reach a terminal state
 * (typically `filled`) before the protective trailing-stop sell can be placed. We poll the buy via
 * waitForOrderTerminal, then submit the stop only if the buy actually filled. If the buy times out
 * (long limit order) or doesn't fill (canceled/rejected), the stop is skipped and the position note
 * captures the unprotected state — the execute ritual logs this so the EOD report surfaces it.
 */
export async function placePaperOrder(o: OrderRequest): Promise<{ entry: any; stop?: any; stopSkippedReason?: string; idempotent?: boolean }> {
  // Idempotency: every buy gets a client_order_id derived from symbol + minute-precision timestamp +
  // 8 hex chars of randomness. If the harness retries (network blip, restart), the SECOND submission
  // returns a Duplicate sentinel we treat as success — Alpaca already has the order.
  const entryCoid = billOrderId(o.symbol, "buy");

  // FRACTIONAL path: Alpaca only accepts fractional/notional qty as a MARKET order with TIF=day, and will
  // NOT attach a broker trailing stop to it. So place the market order and skip the stop — protection is the
  // SYNTHETIC trailing stop in the refresh ritual (peak-tracked, market-sell on breach). Idempotent on replay.
  if (o.fractional) {
    let fEntry: any;
    let fIdempotent = false;
    try {
      fEntry = await post("/v2/orders", { symbol: o.symbol, qty: o.qty, side: o.side, type: "market", time_in_force: "day", client_order_id: entryCoid });
    } catch (e) {
      if (e instanceof DuplicateClientOrderIdError) { fIdempotent = true; fEntry = { client_order_id: entryCoid, status: "duplicate" }; }
      else throw e;
    }
    return { entry: fEntry, stopSkippedReason: "fractional — protected by the synthetic trailing stop (no broker stop)", idempotent: fIdempotent };
  }

  let entry: any;
  let idempotent = false;
  try {
    entry = await post("/v2/orders", {
      symbol: o.symbol,
      qty: o.qty,
      side: o.side,
      type: o.type,
      time_in_force: "day",
      client_order_id: entryCoid,
      ...(o.type === "limit" && o.limit_price != null ? { limit_price: o.limit_price } : {}),
    });
  } catch (e) {
    if (e instanceof DuplicateClientOrderIdError) {
      // Already placed earlier — fetch the original order so we can still attach a stop if needed.
      idempotent = true;
      try {
        const list = await get(`/v2/orders?status=all&limit=20&direction=desc`) as any[];
        entry = list?.find?.((x: any) => x.client_order_id === entryCoid) || { client_order_id: entryCoid, status: "unknown" };
      } catch { entry = { client_order_id: entryCoid, status: "unknown" }; }
    } else throw e;
  }
  let stop: any | undefined;
  let stopSkippedReason: string | undefined;
  if (o.side === "buy" && o.trail_percent != null && !entry?.id) {
    // Idempotent replay where the original order couldn't be re-fetched: entry has no id, so polling
    // would hit /v2/orders/undefined and spin until timeout. Skip the wait — the prior placement already
    // landed; reconcile() backfills the protective stop from fills.
    stopSkippedReason = "idempotent replay: original order id unavailable — stop must be backfilled by reconcile";
  } else if (o.side === "buy" && o.trail_percent != null) {
    // Wait for the buy to reach terminal status before placing the protective stop.
    const final = await waitForOrderTerminal(entry.id, { timeoutMs: 45_000, intervalMs: 1_000 });
    if (!final) {
      stopSkippedReason = "buy did not fill within 45s — no trailing stop placed (position UNPROTECTED until follow-up reconcile)";
    } else if (final.status !== "filled") {
      stopSkippedReason = `buy reached terminal status "${final.status}" (not filled) — no trailing stop placed`;
    } else {
      // Buy filled — safe to place the trailing-stop sell now. Use the actual filled qty in case of partial fill.
      const fillQty = Number(final.filled_qty || final.qty || o.qty);
      stop = await placeTrailingStop(o.symbol, fillQty, o.trail_percent);
    }
  }
  return { entry, stop, stopSkippedReason, idempotent };
}
