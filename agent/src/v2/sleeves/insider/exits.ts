// Bull v2 insider sleeve — exits engine (design: fixed 126-trading-day horizon + two early
// triggers). The horizon is the base case; the early triggers are:
//   (a) REVERSAL — ≥2 cluster participants file open-market S-sales, OR any participant sells
//       >50% of their cluster shares → straight exit (the insiders un-said what they said).
//   (b) ATR STOP — price-based stop fires → we do NOT sell. We emit a stop_fired event (state key
//       + position_meta) for the judgment layer to run its thesis-check. The −25% hard floor is
//       code the judgment layer owns; nothing here auto-liquidates on price alone.
// A NEW qualifying cluster mid-hold resets the horizon clock ONCE (max 9 months from the original
// entry, no added capital). A 4/A amendment that kills the underlying cluster raises an
// 'ins-thesis-review' approvals row and NEVER auto-sells — the design is explicit about that.
import type { DatabaseSync } from "node:sqlite";
import { d9, d9str, d9num, type D9 } from "../../decimal.js";
import { setState } from "../../db.js";
import { placeOrder, type PlaceResult } from "../../order-gateway.js";
import type { BrokerPort } from "../../broker.js";
import { evaluateWindow, type ClusterCfg } from "./cluster.js";
import { getCluster, setClusterStatus, ownerHistoryFn, participantSells, qualifiedBuyEvents } from "./store.js";
import type { DailyBar } from "./ports.js";

export interface ExitCfg {
  horizonTradingDays: number;
  reversalMinSellers: number;
  reversalSellFrac: number;      // 0.5 → ">50% of their cluster shares"
  clusterResetMaxMonths: number; // 9 → hard cap on clock resets
}

/** Per-position metadata (position_meta row, sleeve 'ins'). The judgment layer and dashboard read
 *  this JSON — keep the shape stable. */
export interface InsPositionMeta {
  clusterId: string;
  entryDate: string;              // ET session date of the funded entry
  horizonTradingDays: number;
  clockResets: number;            // 0 or 1 — one reset max, ever
  resetDate?: string;             // horizon re-anchors here after a reset
  maxExitDate: string;            // entryDate + clusterResetMaxMonths — resets never push past this
  sector: string | null;
  participants: { cik: string; name: string; shares9: string }[]; // cluster shares (reversal math)
  stopFired?: { ts: string; price9: string; stop9: string };
  thesisReview?: { ts: string; reason: string };
}

const SLEEVE = "ins";

export function readMeta(db: DatabaseSync, symbol: string): InsPositionMeta | null {
  const row = db.prepare("SELECT meta FROM position_meta WHERE sleeve=? AND symbol=?").get(SLEEVE, symbol) as { meta: string } | undefined;
  return row ? (JSON.parse(row.meta) as InsPositionMeta) : null;
}

export function writeMeta(db: DatabaseSync, symbol: string, meta: InsPositionMeta): void {
  db.prepare(
    `INSERT INTO position_meta(sleeve, symbol, meta, updated_ts) VALUES(?,?,?,?)
     ON CONFLICT(sleeve, symbol) DO UPDATE SET meta=excluded.meta, updated_ts=excluded.updated_ts`,
  ).run(SLEEVE, symbol, JSON.stringify(meta), new Date().toISOString());
}

export function listMetas(db: DatabaseSync): { symbol: string; meta: InsPositionMeta }[] {
  const rows = db.prepare("SELECT symbol, meta FROM position_meta WHERE sleeve=?").all(SLEEVE) as { symbol: string; meta: string }[];
  return rows.map((r) => ({ symbol: r.symbol, meta: JSON.parse(r.meta) as InsPositionMeta }));
}

/** dateKey + n calendar months, day-clamped (May 31 + 9mo → Feb 28, not Mar 3). */
export function addMonths(dateKey: string, n: number): string {
  const [y, m, d] = dateKey.split("-").map((s) => parseInt(s, 10));
  const total = (m - 1) + n;
  const ty = y + Math.floor(total / 12);
  const tm = (total % 12) + 1;
  const lastDay = new Date(Date.UTC(ty, tm, 0)).getUTCDate(); // day 0 of next month = last of tm
  const td = Math.min(d, lastDay);
  return `${ty}-${String(tm).padStart(2, "0")}-${String(td).padStart(2, "0")}`;
}

/** Horizon check. `sessions` = ascending trading-day list (Alpaca calendar — Phase 4/5 supplies).
 *  Held sessions count STRICTLY AFTER the anchor (entry or reset date): due on the horizon-th
 *  session after entry. The 9-month calendar cap fires regardless of the trading-day count. */
export function horizonDue(meta: InsPositionMeta, sessions: string[], asOf: string): boolean {
  if (asOf >= meta.maxExitDate) return true;
  const anchor = meta.resetDate ?? meta.entryDate;
  const held = sessions.filter((s) => s > anchor && s <= asOf).length;
  return held >= meta.horizonTradingDays;
}

export interface ReversalVerdict { triggered: boolean; reasons: string[] }

/** Reversal detection — pure over (participants, their later open-market sells). */
export function detectReversal(
  participants: { cik: string; shares9: string }[],
  sells: { ownerCik: string; shares9: D9 }[],
  cfg: ExitCfg,
): ReversalVerdict {
  const reasons: string[] = [];
  const soldByCik = new Map<string, D9>();
  for (const s of sells) soldByCik.set(s.ownerCik, (soldByCik.get(s.ownerCik) ?? 0n) + s.shares9);

  const sellers = participants.filter((p) => (soldByCik.get(p.cik) ?? 0n) > 0n);
  if (sellers.length >= cfg.reversalMinSellers) reasons.push(`sellers:${sellers.length}`);

  for (const p of participants) {
    const sold = soldByCik.get(p.cik) ?? 0n;
    const clusterShares = d9(p.shares9); // d9str decimal string from the participants JSON
    if (clusterShares > 0n && d9num(sold) > cfg.reversalSellFrac * d9num(clusterShares))
      reasons.push(`participant:${p.cik}:sold>${cfg.reversalSellFrac * 100}%`);
  }
  return { triggered: reasons.length > 0, reasons };
}

/** One clock reset, ever, and never past maxExitDate. Returns the updated meta or null (refused). */
export function tryClockReset(meta: InsPositionMeta, newClusterDate: string): InsPositionMeta | null {
  if (meta.clockResets >= 1) return null;
  if (newClusterDate >= meta.maxExitDate) return null; // reset can't extend past the 9-month cap
  return { ...meta, clockResets: 1, resetDate: newClusterDate };
}

/** Raise an 'ins-thesis-review' approvals row (design §9 queue) + stamp the meta. NEVER sells. */
export function flagThesisReview(db: DatabaseSync, symbol: string, meta: InsPositionMeta, reason: string, payload: Record<string, unknown> = {}): void {
  const ts = new Date().toISOString();
  db.prepare(
    "INSERT INTO approvals(ts, kind, title, payload, status) VALUES(?,?,?,?,'pending')",
  ).run(ts, "ins-thesis-review", `Insider thesis review: ${symbol} — ${reason}`,
    JSON.stringify({ sleeve: SLEEVE, symbol, clusterId: meta.clusterId, reason, ...payload }));
  writeMeta(db, symbol, { ...meta, thesisReview: { ts, reason } });
}

/** Emit the stop_fired event for the judgment layer: state key ins:stop_fired:{SYM} + meta stamp.
 *  Emits ONCE per position (re-fires while the flag stands are noise, not information). */
export function emitStopFired(db: DatabaseSync, symbol: string, meta: InsPositionMeta, price9: D9, stop9: D9, ts: string): boolean {
  if (meta.stopFired) return false;
  const evt = { ts, price9: d9str(price9), stop9: d9str(stop9) };
  setState(db, `ins:stop_fired:${symbol}`, JSON.stringify(evt));
  writeMeta(db, symbol, { ...meta, stopFired: evt });
  return true;
}

/** Trailing ATR stop level from daily bars: highest close since entry − mult × ATR(n). True-range
 *  ATR needs high/low; DailyBar carries closes only, so this uses the close-to-close proxy —
 *  documented deviation, conservative enough for an EVENT emitter (the judgment layer re-checks
 *  with its own data before any action). Params are caller-supplied: the insider config carries no
 *  ATR dials (the design leaves the stop's consequences to the judgment layer). */
export function atrStopLevel9(bars: DailyBar[], entryDate: string, atrDays: number, multiple: number): D9 | null {
  const since = bars.filter((b) => b.date >= entryDate);
  if (since.length < 2 || bars.length < atrDays + 1) return null;
  const closes = bars.map((b) => d9num(b.close9));
  let atrSum = 0;
  for (let i = closes.length - atrDays; i < closes.length; i++) atrSum += Math.abs(closes[i] - closes[i - 1]);
  const atr = atrSum / atrDays;
  const highClose = Math.max(...since.map((b) => d9num(b.close9)));
  const level = highClose - multiple * atr;
  return level > 0 ? d9(level.toFixed(6)) : 0n;
}

/** Amendment aftermath: re-run the cluster gates over the stored cluster's window using only
 *  LIVE rows (superseded ones are out). If the cluster no longer qualifies: mark it dead, and if
 *  a live position rides on it → thesis-review flag (never auto-sell). */
export function requalifyCluster(db: DatabaseSync, clusterId: string, clusterCfg: ClusterCfg): "alive" | "dead" | "missing" {
  const row = getCluster(db, clusterId);
  if (!row) return "missing";
  const buys = qualifiedBuyEvents(db, { symbol: row.symbol })
    .filter((b) => b.tradeDate >= row.window_start && b.tradeDate <= row.window_end);
  const history = ownerHistoryFn(db, row.issuer_cik, row.window_start);
  const ev = evaluateWindow(buys, history, clusterCfg);
  if (ev.qualifies) return "alive";

  setClusterStatus(db, clusterId, "dead");
  const held = db.prepare(
    "SELECT COALESCE(SUM(CAST(qty_remaining9 AS REAL)),0) AS q FROM lots WHERE sleeve=? AND symbol=?",
  ).get(SLEEVE, row.symbol) as { q: number };
  if (held.q > 0) {
    const meta = readMeta(db, row.symbol);
    if (meta && meta.clusterId === clusterId && !meta.thesisReview) {
      flagThesisReview(db, row.symbol, meta, "amendment-killed-cluster", { failReason: ev.failReason });
    }
  }
  return "dead";
}

export interface ExitAction {
  symbol: string;
  action: "sell-horizon" | "sell-reversal" | "stop-fired" | "hold";
  detail?: string;
  place?: PlaceResult;
}

/** Nightly/exit-window pass over every ins position. Sells go through the ONE order path
 *  (order-gateway) as whole-position market sells, blacklistExempt (sells are exempt by nature).
 *  A position already under thesis review is left for the judgment layer. */
export async function runExits(db: DatabaseSync, broker: BrokerPort, cfg: {
  exit: ExitCfg; washBlacklistDays: number; configVersion: string;
  asOfDate: string; sessions: string[];
  latestPrice9: (symbol: string) => Promise<D9 | null>;
  bars?: (symbol: string) => Promise<DailyBar[]>;
  atr?: { days: number; multiple: number };
}): Promise<ExitAction[]> {
  const out: ExitAction[] = [];
  for (const { symbol, meta } of listMetas(db)) {
    const qtyRow = db.prepare(
      "SELECT qty_remaining9 FROM lots WHERE sleeve=? AND symbol=?",
    ).all(SLEEVE, symbol) as { qty_remaining9: string }[];
    const qty9 = qtyRow.reduce((a, r) => a + d9(r.qty_remaining9), 0n);
    if (qty9 <= 0n) continue; // closed — reconcile owns clearing the meta row

    if (meta.thesisReview) { out.push({ symbol, action: "hold", detail: "thesis-review-pending" }); continue; }

    const sellAll = async (why: "sell-horizon" | "sell-reversal", detail: string): Promise<void> => {
      const est = await cfg.latestPrice9(symbol);
      const place = await placeOrder(db, broker, {
        owner: SLEEVE, symbol, intent: "sell", side: "sell", type: "market", tif: "day",
        qty9, estPrice9: est ?? d9("1"), asOfDate: cfg.asOfDate, configVersion: cfg.configVersion,
        blacklistExempt: true,
      }, { washBlacklistDays: cfg.washBlacklistDays });
      out.push({ symbol, action: why, detail, place });
    };

    if (horizonDue(meta, cfg.sessions, cfg.asOfDate)) {
      await sellAll("sell-horizon", `held ≥ ${meta.horizonTradingDays} sessions (or ${meta.maxExitDate} cap)`);
      continue;
    }

    const cluster = getCluster(db, meta.clusterId);
    const sells = participantSells(db, symbol, cluster?.window_end ?? meta.entryDate,
      meta.participants.map((p) => p.cik));
    const rev = detectReversal(meta.participants, sells, cfg.exit);
    if (rev.triggered) {
      await sellAll("sell-reversal", rev.reasons.join(","));
      continue;
    }

    if (cfg.bars && cfg.atr) {
      const bars = await cfg.bars(symbol);
      const stop = atrStopLevel9(bars, meta.entryDate, cfg.atr.days, cfg.atr.multiple);
      const last = bars.length ? bars[bars.length - 1].close9 : null;
      if (stop !== null && last !== null && last < stop) {
        const fired = emitStopFired(db, symbol, meta, last, stop, new Date().toISOString());
        out.push({ symbol, action: "stop-fired", detail: fired ? "emitted" : "already-flagged" });
        continue;
      }
    }
    out.push({ symbol, action: "hold" });
  }
  return out;
}
