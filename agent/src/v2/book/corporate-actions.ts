// Bull v2 — corporate actions (design §7). Alpaca PAPER processes NO corporate actions: splits
// corrupt the equity curve silently and dividends never arrive. Unsupported ledger effects are
// quarantined for operator review until execution inventory and economic entitlement are proven:
//   · nightly poll of announcements for HELD symbols
//   · reverse splits / cash+stock mergers → EXIT before the effective date (normal sell path)
//   · forward splits → preserve executable FIFO quantities; halt the book while NAV is uncertified
//   · cash dividends → preserve existing credits; defer new credits pending historical entitlement
// The poll is a port (offline tests inject fixtures); the real adapter reads Alpaca's data-host
// corporate-actions endpoint with the same auth as bars/quotes.
import type { DatabaseSync } from "node:sqlite";
import { withTimeout, DEFAULT_TIMEOUT_MS } from "../../http-utils.js";
import { d9, d9str, type D9 } from "./../decimal.js";
import { ledgerPositions } from "./../lots.js";
import { getState, setState } from "./../db.js";

export interface CorporateAnnouncement {
  symbol: string;
  type: "forward_split" | "reverse_split" | "cash_dividend" | "cash_merger" | "stock_merger" | "unknown";
  exDate?: string;          // YYYY-MM-DD (dividends: entitlement date; splits: effective date proxy)
  effectiveDate?: string;
  newRate?: number;         // splits: new qty per old
  oldRate?: number;
  cashRate?: number;        // cash dividend per share (USD)
  raw?: unknown;
}

export interface CorporateActionsPort {
  announcements(symbols: string[], start: string, end: string): Promise<CorporateAnnouncement[]>;
}

const DATA_BASE = "https://data.alpaca.markets";

function authHeaders(): Record<string, string> {
  const id = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_API_SECRET;
  if (!id || !secret) throw new Error("ALPACA_API_KEY / ALPACA_API_SECRET not set");
  return { "APCA-API-KEY-ID": id, "APCA-API-SECRET-KEY": secret };
}

/** Real adapter — Alpaca data-host v1 corporate actions. Returns [] on any failure (the nightly
 *  poll retries tomorrow; a data blip must not break the evening ritual). Parsing is defensive:
 *  unknown shapes become type "unknown" and are surfaced, never guessed at. */
export const alpacaCorporateActions: CorporateActionsPort = {
  async announcements(symbols, start, end): Promise<CorporateAnnouncement[]> {
    try {
      const qs = new URLSearchParams({ symbols: symbols.join(","), start, end, limit: "1000" });
      const r = await withTimeout((signal) => fetch(`${DATA_BASE}/v1/corporate-actions?${qs}`, {
        headers: authHeaders(), signal,
      }), DEFAULT_TIMEOUT_MS);
      if (!r.ok) return [];
      const j = (await r.json()) as { corporate_actions?: Record<string, any[]> };
      const out: CorporateAnnouncement[] = [];
      const ca = j?.corporate_actions ?? {};
      for (const s of ca.forward_splits ?? []) out.push({ symbol: String(s.symbol).toUpperCase(), type: "forward_split", exDate: s.ex_date, effectiveDate: s.ex_date, newRate: Number(s.new_rate), oldRate: Number(s.old_rate), raw: s });
      for (const s of ca.reverse_splits ?? []) out.push({ symbol: String(s.symbol).toUpperCase(), type: "reverse_split", exDate: s.ex_date, effectiveDate: s.ex_date, newRate: Number(s.new_rate), oldRate: Number(s.old_rate), raw: s });
      for (const dv of ca.cash_dividends ?? []) out.push({ symbol: String(dv.symbol).toUpperCase(), type: "cash_dividend", exDate: dv.ex_date, cashRate: Number(dv.rate), raw: dv });
      for (const m of ca.cash_mergers ?? []) out.push({ symbol: String(m.acquiree_symbol ?? m.symbol).toUpperCase(), type: "cash_merger", effectiveDate: m.effective_date, raw: m });
      for (const m of ca.stock_mergers ?? []) out.push({ symbol: String(m.acquiree_symbol ?? m.symbol).toUpperCase(), type: "stock_merger", effectiveDate: m.effective_date, raw: m });
      return out;
    } catch { return []; }
  },
};

export interface CorporateActionsPlan {
  exitBefore: { symbol: string; type: string; effectiveDate: string }[]; // sell via the owning sleeve's normal path
  forwardSplits: { symbol: string; num: bigint; den: bigint; exDate: string }[];
  dividends: { symbol: string; exDate: string; perShare9: D9 }[];
  unknown: CorporateAnnouncement[];
}

/** Pure decision core over announcements × current holdings. */
export function planCorporateActions(announcements: CorporateAnnouncement[], held: Set<string>): CorporateActionsPlan {
  const plan: CorporateActionsPlan = { exitBefore: [], forwardSplits: [], dividends: [], unknown: [] };
  for (const a of announcements) {
    if (!held.has(a.symbol)) continue;
    switch (a.type) {
      case "reverse_split":
      case "cash_merger":
      case "stock_merger":
        if (a.effectiveDate) plan.exitBefore.push({ symbol: a.symbol, type: a.type, effectiveDate: a.effectiveDate });
        else plan.unknown.push(a);
        break;
      case "forward_split": {
        const num = Math.round(a.newRate ?? 0);
        const den = Math.round(a.oldRate ?? 0);
        if (num > 0 && den > 0 && a.exDate) plan.forwardSplits.push({ symbol: a.symbol, num: BigInt(num), den: BigInt(den), exDate: a.exDate });
        else plan.unknown.push(a);
        break;
      }
      case "cash_dividend":
        if (a.exDate && Number.isFinite(a.cashRate) && (a.cashRate ?? 0) > 0) {
          plan.dividends.push({ symbol: a.symbol, exDate: a.exDate, perShare9: d9(String(a.cashRate)) });
        }
        break;
      default:
        plan.unknown.push(a);
    }
  }
  return plan;
}

export interface DeferredCorporateAction {
  symbol: string;
  exDate: string;
}

export interface DueActionsResult {
  splitsApplied: number;
  dividendsCredited: number;
  splitsDeferred: number;
  dividendsDeferred: number;
  deferredSplits: DeferredCorporateAction[];
  deferredDividends: DeferredCorporateAction[];
  halted: boolean;
}

/** Persist evidence and its operator card atomically. A repeat, including after the card is
 *  acknowledged, must not create another card or silently resolve the underlying accounting issue. */
function deferAction(db: DatabaseSync, key: string, title: string, evidence: Record<string, unknown>, halt: boolean): void {
  db.exec("SAVEPOINT corp_containment");
  try {
    if (halt && getState(db, "halt:book") === null) {
      setState(db, "halt:book", `corporate action unresolved: ${title}; economic NAV uncertified — operator review required`);
    }
    if (getState(db, key) === null) {
      const payload = JSON.stringify({ status: "pending", ...evidence });
      setState(db, key, payload);
      db.prepare("INSERT INTO approvals(ts,kind,title,payload) VALUES(?,?,?,?)")
        .run(new Date().toISOString(), "corporate-action-deferred", title, payload);
    }
    db.exec("RELEASE corp_containment");
  } catch (e) {
    db.exec("ROLLBACK TO corp_containment");
    db.exec("RELEASE corp_containment");
    throw e;
  }
}

/** Contain due unsupported accounting effects. An announcement is not a broker position update,
 *  and current holdings do not establish historical dividend entitlement. This deliberately writes
 *  neither lots nor cash. Existing legacy split mutations/credits require separate reviewed repair.
 *  Also scans durable split evidence, so an empty/replaced nightly plan cannot erase containment. */
export function applyDueActions(db: DatabaseSync, plan: CorporateActionsPlan, today: string): DueActionsResult {
  const positions = ledgerPositions(db);
  const splits = new Map<string, Record<string, unknown> & DeferredCorporateAction>();
  for (const s of plan.forwardSplits) {
    if (s.exDate > today || (positions.get(s.symbol) ?? 0n) <= 0n) continue;
    if (getState(db, `corp:applied:${s.symbol}:${s.exDate}`) !== null) continue;
    splits.set(`${s.symbol}:${s.exDate}`, {
      symbol: s.symbol, exDate: s.exDate, num: String(s.num), den: String(s.den), source: "announcement",
    });
  }
  const stale = db.prepare("SELECT key,value FROM state WHERE key LIKE 'split_stale:%'").all() as { key: string; value: string }[];
  for (const row of stale) {
    const symbol = row.key.slice("split_stale:".length);
    if ((positions.get(symbol) ?? 0n) <= 0n) continue;
    let marker: Record<string, unknown> = {};
    try { marker = JSON.parse(row.value) ?? {}; } catch { /* malformed evidence still requires a halt */ }
    const exDate = typeof marker.ts === "string" && /^\d{4}-\d{2}-\d{2}T/.test(marker.ts) ? marker.ts.slice(0, 10) : "unknown";
    splits.set(`${symbol}:${exDate}`, {
      symbol, exDate, num: marker.num ?? null, den: marker.den ?? null,
      source: "legacy-split-stale", staleMarker: row.value,
    });
  }
  const pending = db.prepare("SELECT value FROM state WHERE key LIKE 'corp:pending:split:%'").all() as { value: string }[];
  for (const row of pending) {
    const evidence = JSON.parse(row.value) as Record<string, unknown> & DeferredCorporateAction;
    splits.set(`${evidence.symbol}:${evidence.exDate}`, evidence);
  }
  for (const [id, evidence] of splits) {
    deferAction(db, `corp:pending:split:${id}`, `split ${evidence.symbol} ${evidence.num ?? "?"}:${evidence.den ?? "?"} (ex ${evidence.exDate}) deferred`, {
      ...evidence, kind: "forward_split", detectedOn: today,
      ledgerQty9: d9str(positions.get(evidence.symbol) ?? 0n),
      lots: db.prepare("SELECT lot_id,open_fill_id,open_ts,qty_open9,qty_remaining9,basis_remaining9 FROM lots WHERE symbol=?").all(evidence.symbol),
      brokerPosition: "not observed by containment; fresh broker reconciliation required",
      reason: "Paper split normalization is unverified. Preserve executable quantities and existing fills; economic NAV is uncertified. No automatic repair or halt clearing.",
    }, true);
  }
  const dividends = new Map<string, DeferredCorporateAction>();
  for (const dv of plan.dividends) {
    if (dv.exDate > today) continue;
    const ref = `div:${dv.symbol}:${dv.exDate}`;
    if (db.prepare("SELECT id FROM cash_events WHERE kind='dividend' AND ref=?").get(ref)) continue;
    dividends.set(ref, dv);
    deferAction(db, `corp:pending:${ref}`, `dividend ${dv.symbol} (ex ${dv.exDate}) deferred`, {
      kind: "cash_dividend", symbol: dv.symbol, exDate: dv.exDate, perShare9: d9str(dv.perShare9), detectedOn: today,
      currentQty9: d9str(positions.get(dv.symbol) ?? 0n), entitlementQty9: null,
      reason: "Historical ex-date entitlement has not been established. Current holdings are not evidence of entitlement; no cash was credited.",
    }, false);
  }
  if (plan.unknown.length) {
    setState(db, "corp_actions_unknown", JSON.stringify(plan.unknown.slice(0, 10)));
  }
  return {
    splitsApplied: 0, dividendsCredited: 0, splitsDeferred: splits.size, dividendsDeferred: dividends.size,
    deferredSplits: [...splits.values()].map(({ symbol, exDate }) => ({ symbol, exDate })),
    deferredDividends: [...dividends.values()].map(({ symbol, exDate }) => ({ symbol, exDate })),
    halted: getState(db, "halt:book") !== null,
  };
}
