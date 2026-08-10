// Bull v2 — broker port (Alpaca paper REST). The ONE file that talks to the trading host for v2
// order placement. Hard paper assertion at module load (v1 rail carried forward — design §0): any
// non-paper host throws before a single request can be built. Sizing/room decisions NEVER live here
// and NEVER read Alpaca's buying-power field — the settled-cash ledger is the only cash truth.
//
// Outcome classification matters more than success: a thrown fetch (timeout, reset) is UNKNOWN —
// the order may have reached Alpaca — so the gateway must query by client_order_id before any
// resubmit. An HTTP response is KNOWN: 2xx = accepted, 422 duplicate-coid = already placed
// (idempotent success), other 4xx/5xx = rejected with the body kept for the audit row.
import { withTimeout, DEFAULT_TIMEOUT_MS } from "../http-utils.js";
import { isDuplicateClientOrderIdResponse } from "../alpaca.js";

const RAW_BASE = process.env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets";
const BASE = RAW_BASE.replace(/\/+$/, "").replace(/\/v2$/, "");
if (BASE !== "https://paper-api.alpaca.markets") {
  throw new Error(`Refusing non-paper Alpaca base URL: "${RAW_BASE}". Bull v2 is paper-only.`);
}
const TIMEOUT_MS = parseInt(process.env.ALPACA_TIMEOUT_MS || String(DEFAULT_TIMEOUT_MS), 10);

function authHeaders(): Record<string, string> {
  const id = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_API_SECRET;
  if (!id || !secret) throw new Error("ALPACA_API_KEY / ALPACA_API_SECRET not set");
  return { "APCA-API-KEY-ID": id, "APCA-API-SECRET-KEY": secret };
}

export interface BrokerOrderRequest {
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit" | "stop";
  time_in_force: "day" | "gtc";
  client_order_id: string;
  qty?: string;        // decimal string (fractional ok)
  notional?: string;   // decimal string USD (market+day only)
  limit_price?: string;
  stop_price?: string;
}

export type SubmitResult =
  | { outcome: "accepted"; order: any }
  | { outcome: "duplicate"; body: string }          // idempotent success — already placed
  | { outcome: "rejected"; status: number; body: string }
  | { outcome: "unknown"; error: string };          // MUST query by coid before any resubmit

export interface BrokerPort {
  submit(req: BrokerOrderRequest): Promise<SubmitResult>;
  queryByClientOrderId(coid: string): Promise<any | null>;
  getOpenOrders(): Promise<any[]>;
  cancelOrder(orderId: string): Promise<boolean>;
}

/** Read surface for reconciliation (design §7): account, positions, FILL replay, trading calendar. */
export interface ReadPort {
  getAccount(): Promise<any>;
  getPositions(): Promise<any[]>;
  /** FILL activities ASCENDING, strictly after `afterId` when given (pages internally). */
  getFillActivities(afterId?: string): Promise<any[]>;
  /** Trading sessions (YYYY-MM-DD ascending) for [start, end] — feeds T+1 settlement. */
  getSessions(start: string, end: string): Promise<string[]>;
}

export const alpacaBroker: BrokerPort = {
  async submit(req: BrokerOrderRequest): Promise<SubmitResult> {
    try {
      const res = await withTimeout((signal) => fetch(`${BASE}/v2/orders`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(req),
        signal,
      }), TIMEOUT_MS);
      const body = await res.text().catch(() => "");
      if (res.ok) return { outcome: "accepted", order: JSON.parse(body || "{}") };
      if (isDuplicateClientOrderIdResponse(res.status, body)) return { outcome: "duplicate", body: body.slice(0, 300) };
      return { outcome: "rejected", status: res.status, body: body.slice(0, 300) };
    } catch (e) {
      return { outcome: "unknown", error: e instanceof Error ? e.message : String(e) };
    }
  },

  async queryByClientOrderId(coid: string): Promise<any | null> {
    try {
      const res = await withTimeout((signal) => fetch(
        `${BASE}/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(coid)}`,
        { headers: authHeaders(), signal },
      ), TIMEOUT_MS);
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  },

  async getOpenOrders(): Promise<any[]> {
    const res = await withTimeout((signal) => fetch(`${BASE}/v2/orders?status=open&limit=200`, {
      headers: authHeaders(), signal,
    }), TIMEOUT_MS);
    if (!res.ok) throw new Error(`Alpaca GET /v2/orders → ${res.status}`);
    const j = await res.json();
    return Array.isArray(j) ? j : [];
  },

  async cancelOrder(orderId: string): Promise<boolean> {
    try {
      const res = await withTimeout((signal) => fetch(`${BASE}/v2/orders/${encodeURIComponent(orderId)}`, {
        method: "DELETE", headers: authHeaders(), signal,
      }), TIMEOUT_MS);
      return res.ok || res.status === 404 || res.status === 422;
    } catch { return false; }
  },
};

async function getJson(path: string): Promise<any> {
  const res = await withTimeout((signal) => fetch(BASE + path, { headers: authHeaders(), signal }), TIMEOUT_MS);
  if (!res.ok) throw new Error(`Alpaca GET ${path} → ${res.status}`);
  return res.json();
}

export const alpacaReadPort: ReadPort = {
  getAccount: () => getJson("/v2/account"),
  async getPositions() {
    const j = await getJson("/v2/positions");
    return Array.isArray(j) ? j : [];
  },
  async getFillActivities(afterId?: string): Promise<any[]> {
    // Ascending pages via page_token; `after` filters by TIME, so we page from the start and cut on
    // the id cursor client-side (activity ids are time-prefixed and strictly ordered).
    const out: any[] = [];
    let token: string | null = null;
    for (let page = 0; page < 50; page++) {
      const qs = new URLSearchParams({ direction: "asc", page_size: "100" });
      if (token) qs.set("page_token", token);
      const j = await getJson(`/v2/account/activities/FILL?${qs.toString()}`);
      const arr: any[] = Array.isArray(j) ? j : [];
      if (!arr.length) break;
      for (const a of arr) if (!afterId || String(a.id) > afterId) out.push(a);
      if (arr.length < 100) break;
      token = String(arr[arr.length - 1].id);
    }
    return out;
  },
  async getSessions(start: string, end: string): Promise<string[]> {
    const j = await getJson(`/v2/calendar?start=${start}&end=${end}`);
    return (Array.isArray(j) ? j : []).map((d: any) => String(d.date)).sort();
  },
};
