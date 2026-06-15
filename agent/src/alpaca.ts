// Alpaca PAPER client. Reads are always allowed; PLACEMENT only happens via placePaperOrder,
// which the execution ritual calls solely in auto mode (double-gated). Hard guard: paper endpoint only.
// Accept the paper host with or without a trailing "/v2" or slash — the client appends "/v2/..." itself.
// Normalize first, then HARD-require the paper host: any live/non-paper host still throws. Bill is paper-only.
import { withTimeout, DEFAULT_TIMEOUT_MS } from "./http-utils.js";

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

async function post(path: string, body: unknown): Promise<unknown> {
  const res = await withTimeout((signal) => fetch(BASE + path, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  }), ALPACA_TIMEOUT_MS);
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Alpaca POST ${path} → ${res.status}: ${t.slice(0, 160)}`);
  }
  return res.json();
}

export const getAccount = () => get("/v2/account");
export const getPositions = () => get("/v2/positions");
export const getOpenOrders = () => get("/v2/orders?status=open&limit=100");
export const getOrder = (id: string) => get(`/v2/orders/${encodeURIComponent(id)}`);

/** Place a standalone protective trailing-stop SELL. Used by the backfill script + the post-fill leg
 *  of placePaperOrder. trail_percent is a number (e.g. 20 for 20%); time_in_force is GTC. */
export async function placeTrailingStop(symbol: string, qty: number, trailPercent: number): Promise<unknown> {
  return post("/v2/orders", {
    symbol,
    qty,
    side: "sell",
    type: "trailing_stop",
    trail_percent: String(trailPercent),
    time_in_force: "gtc",
  });
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
  trail_percent?: number;   // protective trailing stop attached on buys
  thesis?: string;
  confidence?: number;      // 0–100 conviction (Bull v2 #5)
  setup?: string;           // setup label, e.g. "momentum breakout" (Bull v2 #5)
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
export async function placePaperOrder(o: OrderRequest): Promise<{ entry: any; stop?: any; stopSkippedReason?: string }> {
  const entry: any = await post("/v2/orders", {
    symbol: o.symbol,
    qty: o.qty,
    side: o.side,
    type: o.type,
    time_in_force: "day",
    ...(o.type === "limit" && o.limit_price != null ? { limit_price: o.limit_price } : {}),
  });
  let stop: any | undefined;
  let stopSkippedReason: string | undefined;
  if (o.side === "buy" && o.trail_percent != null) {
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
  return { entry, stop, stopSkippedReason };
}
