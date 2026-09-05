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
const UNSUPPORTED_GROUP_NAMES = new Set([
  "capital_gains_distributions", "name_changes", "partial_calls", "redemptions", "reorganizations",
  "rights_distributions", "spin_offs", "stock_and_cash_mergers", "stock_dividends", "unit_splits", "worthless_removals",
]);

function authHeaders(): Record<string, string> {
  const id = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_API_SECRET;
  if (!id || !secret) throw new Error("ALPACA_API_KEY / ALPACA_API_SECRET not set");
  return { "APCA-API-KEY-ID": id, "APCA-API-SECRET-KEY": secret };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function actionDate(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || new Date(value + "T00:00:00Z").toISOString().slice(0, 10) !== value) throw new Error("invalid action date");
  return value;
}

function actionRate(value: unknown): number {
  if ((typeof value !== "number" && typeof value !== "string") || String(value).trim() === ""
    || !Number.isFinite(Number(value)) || Number(value) <= 0) throw new Error("invalid action rate");
  return Number(value);
}

/** Real adapter — Alpaca data-host v1 corporate actions. Only a successfully decoded, complete
 *  snapshot can return []. HTTP/network/body/schema failures throw a fixed sanitized error so
 *  callers preserve the old plan and withhold decisions/valuation. Never expose response bodies,
 *  credentials, or underlying errors. Unsupported nonempty groups and pagination also require
 *  review rather than silently certifying an incomplete corporate-action snapshot. */
export const alpacaCorporateActions: CorporateActionsPort = {
  async announcements(symbols, start, end): Promise<CorporateAnnouncement[]> {
    let unsupportedGroup: string | null = null;
    try {
      const qs = new URLSearchParams({ symbols: symbols.join(","), start, end, limit: "1000" });
      const j: unknown = await withTimeout(async (signal) => {
        const r = await fetch(`${DATA_BASE}/v1/corporate-actions?${qs}`, { headers: authHeaders(), signal });
        if (!r.ok) throw new Error("corporate-actions HTTP failure");
        return await r.json(); // body read remains inside the abort deadline
      }, DEFAULT_TIMEOUT_MS);
      if (!isRecord(j) || !isRecord(j.corporate_actions)) throw new Error("invalid corporate-actions envelope");
      if (j.next_page_token != null && j.next_page_token !== "") throw new Error("incomplete corporate-actions snapshot");
      const out: CorporateAnnouncement[] = [];
      for (const [group, rows] of Object.entries(j.corporate_actions)) {
        if (!Array.isArray(rows)) throw new Error("invalid corporate-actions group");
        for (const row of rows) {
          if (!isRecord(row)) throw new Error("invalid corporate-action row");
          const symbol = group === "cash_mergers" || group === "stock_mergers" ? row.acquiree_symbol ?? row.symbol : row.symbol;
          if (typeof symbol !== "string" || !symbol.trim()) throw new Error("invalid action symbol");
          const common = { symbol: symbol.toUpperCase(), raw: row };
          switch (group) {
            case "forward_splits":
            case "reverse_splits": {
              const exDate = actionDate(row.ex_date);
              out.push({ ...common, type: group === "forward_splits" ? "forward_split" : "reverse_split",
                exDate, effectiveDate: exDate, newRate: actionRate(row.new_rate), oldRate: actionRate(row.old_rate) });
              break;
            }
            case "cash_dividends":
              out.push({ ...common, type: "cash_dividend", exDate: actionDate(row.ex_date), cashRate: actionRate(row.rate) });
              break;
            case "cash_mergers":
            case "stock_mergers":
              out.push({ ...common, type: group === "cash_mergers" ? "cash_merger" : "stock_merger", effectiveDate: actionDate(row.effective_date) });
              break;
            default:
              // Only fixed known vocabulary may reach the diagnostic; never echo arbitrary keys.
              unsupportedGroup = UNSUPPORTED_GROUP_NAMES.has(group) ? group : null;
              throw new Error("unsupported corporate-action group");
          }
        }
      }
      return out;
    } catch {
      if (unsupportedGroup) throw new Error(`Alpaca corporate-actions snapshot contains unsupported ${unsupportedGroup}; poll aborted`);
      throw new Error("Alpaca corporate-actions snapshot unavailable, incomplete, or malformed; poll aborted");
    }
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
