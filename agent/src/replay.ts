// Backtest v2 — REAL-PROPOSAL REPLAY engine (strategy-evaluation layer). PURE: no network, no fs, no
// orders. The Python harness (backtest/backtest.py) validates the deterministic risk PLUMBING with a
// mechanical stand-in signal; THIS layer replays the ACTUAL proposals Bill logged in memory/ledger.jsonl
// against historical daily bars under his REAL deterministic exit rules, to measure the strategy's edge:
//
//   entry  : the proposal's recorded est_price on its cycle date (sanity-clamped to that day's bar)
//   stop   : synthetic trailing stop — peak × (1 − trail%), peak seeded at entry and ratcheted on daily
//            highs, trail% = the proposal's own trail_percent else the rulebook default
//            (mirrors synthetic-stops.evaluateStops + reconcile.trailForProposal)
//   target : OPTIONAL hard profit target (live Bill has NO hard target — the profit-trim is LLM-sized
//            and can't be replayed honestly; off by default, exposed for sensitivity runs)
//   time   : OPTIONAL time-stop in trading days (off by default)
//   open   : proposals still live at the end of data are marked "open" and EXCLUDED from closed stats
//
// Bar-granularity conventions (documented bias, mirrors backtest.py):
//   • today's stop level uses the peak through YESTERDAY (no intraday high→low ordering is knowable);
//   • the stop is tested against today's LOW — a wick the live 5-min poll might have missed WILL fire
//     here (conservative), but a same-day new-peak→fall stop-out CANNOT (slightly optimistic);
//   • when stop and target could both hit in one bar, the STOP wins (conservative);
//   • gap-through: if the bar OPENS beyond the level, the fill is the open, not the level.
//
// R-multiple matches reconcile(): risk $ = entry × qty × trail% (the risk the proposal actually carried).
// Win/loss matches reconcile(): pnl > 0 → win, else loss.
import type { ProposalRecord } from "./ledger.js";
import { attribution, type AttributedTrade, type Bucket } from "./attribution.js";
import { trailForProposal } from "./reconcile.js";
import { computeRegime, type RegimeState } from "./regime.js";

const r2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown): number => { const x = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN; return Number.isFinite(x) ? x : 0; };

export interface DailyBar { date: string; open: number; high: number; low: number; close: number; }

export interface ReplayConfig {
  targetPct?: number | null;   // hard profit target % from entry (null/absent = off — live Bill has none)
  maxHoldDays?: number | null; // time-stop in TRADING days including entry day (null/absent = off)
  slipBps?: number;            // per-side slippage in bps (default 0; the CLI passes 5)
}

export type ExitReason = "stop" | "trail" | "target" | "time" | "open";

export interface ReplayedTrade {
  symbol: string;
  ts: string;                  // proposal timestamp (drives time-of-day attribution, same as live)
  cycle: string;
  setup: string | null;
  confidence: number | null;
  profile: string;
  qty: number;
  trailPct: number;
  entryDate: string;
  entry: number;               // slippage-adjusted fill
  entryClamped: boolean;       // est_price fell outside the entry bar's plausible range → filled at bar open
  exitDate: string;
  exit: number;                // slippage-adjusted fill (last close for still-open)
  exitReason: ExitReason;
  holdDays: number;            // trading days held, entry day = 1
  pnlUsd: number;              // realized for closed; mark-to-market for still-open
  retPct: number;
  rMultiple: number;           // pnlUsd / (entry × qty × trail%) — same risk base reconcile() uses
  outcome: "win" | "loss" | "open";
}

/** Proposals eligible for replay: real BUY entries (proposed or placed). Rejected rows never traded. */
export function replayableProposals(ledger: ProposalRecord[]): ProposalRecord[] {
  return (ledger ?? []).filter(
    (p) => p && p.side === "buy" && (p.status === "proposed" || p.status === "placed") && num(p.est_price) > 0 && num(p.qty) > 0,
  );
}

/** Tolerant JSONL parse (same semantics as ledger.readLedger, but from a string so it's pure/testable). */
export function parseLedgerJsonl(text: string): ProposalRecord[] {
  return (text ?? "")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l) as ProposalRecord; } catch { return null; } })
    .filter((x): x is ProposalRecord => x !== null && typeof x === "object");
}

/**
 * Replay ONE proposal against ascending daily bars for its symbol. Returns null when no bar exists on or
 * after the proposal's cycle date (no data → nothing honest to say). Pure.
 */
export function replayProposal(p: ProposalRecord, bars: DailyBar[], cfg: ReplayConfig = {}): ReplayedTrade | null {
  const qty = num(p.qty);
  const est = num(p.est_price);
  if (!(qty > 0) || !(est > 0)) return null;
  const startDate = (p.cycle && /^\d{4}-\d{2}-\d{2}$/.test(p.cycle) ? p.cycle : String(p.ts ?? "").slice(0, 10));
  const clean = (bars ?? []).filter((b) => b && b.open > 0 && b.high > 0 && b.low > 0 && b.close > 0);
  const i0 = clean.findIndex((b) => b.date >= startDate);
  if (i0 < 0) return null;

  const slip = Math.max(0, cfg.slipBps ?? 0) / 1e4;
  const trailPct = trailForProposal(p);
  const trail = Math.max(0, trailPct) / 100;
  const eb = clean[i0];
  // Sanity-clamp: est_price wildly outside the entry bar's range (bad quote, split-adjusted history) →
  // fill at the bar's open instead, and flag it so the report can disclose how often this happened.
  const plausible = est >= eb.low * 0.8 && est <= eb.high * 1.2;
  const rawEntry = plausible ? est : eb.open;
  const entry = rawEntry * (1 + slip);
  const target = cfg.targetPct != null && cfg.targetPct > 0 ? rawEntry * (1 + cfg.targetPct / 100) : null;
  const maxHold = cfg.maxHoldDays != null && cfg.maxHoldDays > 0 ? Math.floor(cfg.maxHoldDays) : null;
  const riskUsd = entry * qty * trail;

  let peak = rawEntry; // synthetic-stop peak seeds at entry (evaluateStops: max(entry, price))
  let exit = 0, exitDate = "", holdDays = 0;
  let reason: ExitReason = "open";

  for (let i = i0; i < clean.length; i++) {
    const b = clean[i];
    holdDays = i - i0 + 1;
    const stopLevel = peak * (1 - trail);
    if (trail > 0 && b.low <= stopLevel) {
      exit = (b.open < stopLevel ? b.open : stopLevel);
      exitDate = b.date;
      reason = peak > rawEntry ? "trail" : "stop"; // ratcheted above entry → a trail-out, else the initial stop
      break;
    }
    if (target != null && b.high >= target) {
      exit = (b.open > target ? b.open : target);
      exitDate = b.date;
      reason = "target";
      break;
    }
    if (maxHold != null && holdDays >= maxHold) {
      exit = b.close;
      exitDate = b.date;
      reason = "time";
      break;
    }
    if (b.high > peak) peak = b.high; // today's high sets TOMORROW's stop (look-ahead-free)
  }

  if (reason === "open") {
    const last = clean[clean.length - 1];
    exit = last.close;
    exitDate = last.date;
    holdDays = clean.length - i0;
  }

  const exitFill = exit * (1 - slip);
  const pnl = (exitFill - entry) * qty;
  return {
    symbol: p.symbol, ts: p.ts, cycle: startDate, setup: p.setup ?? null,
    confidence: typeof p.confidence === "number" && Number.isFinite(p.confidence) ? p.confidence : null,
    profile: p.profile ?? "", qty, trailPct, entryDate: eb.date, entry: r2(entry), entryClamped: !plausible,
    exitDate, exit: r2(exitFill), exitReason: reason, holdDays,
    pnlUsd: r2(pnl), retPct: r2((exitFill / entry - 1) * 100),
    rMultiple: riskUsd > 0 ? r2(pnl / riskUsd) : 0,
    outcome: reason === "open" ? "open" : pnl > 0 ? "win" : "loss",
  };
}

/** Replay every eligible proposal. Symbols without bars are skipped (returned in `skipped`). Pure. */
export function replayAll(ledger: ProposalRecord[], barsBySym: Record<string, DailyBar[]>, cfg: ReplayConfig = {}): { trades: ReplayedTrade[]; skipped: string[] } {
  const trades: ReplayedTrade[] = [];
  const skipped: string[] = [];
  for (const p of replayableProposals(ledger)) {
    const t = replayProposal(p, barsBySym[p.symbol?.toUpperCase?.() ?? ""] ?? barsBySym[p.symbol] ?? [], cfg);
    if (t) trades.push(t);
    else skipped.push(`${p.symbol} @ ${p.cycle || String(p.ts).slice(0, 10)}`);
  }
  return { trades, skipped };
}

// ───────────────────────── walk-forward attribution ─────────────────────────

/** Map replayed trades to the SAME closed-trade shape the live attribution consumes. */
export function toAttributed(trades: ReplayedTrade[]): AttributedTrade[] {
  return trades.map((t) => ({ ts: t.ts, setup: t.setup, outcome: t.outcome, realizedPnlUsd: t.outcome === "open" ? null : t.pnlUsd }));
}

/**
 * Bucket trades by an arbitrary key using the LIVE attribution() aggregation (identical math to what the
 * scan's outcome-feedback loop consumes) — the key is injected as the setup tag, then bySetup is returned.
 * Only closed (win/loss) trades are scored, exactly like live.
 */
export function bucketVia(trades: ReplayedTrade[], keyOf: (t: ReplayedTrade) => string): Record<string, Bucket> {
  return attribution(trades.map((t) => ({ ts: t.ts, setup: keyOf(t) || "unknown", outcome: t.outcome, realizedPnlUsd: t.outcome === "open" ? null : t.pnlUsd }))).bySetup;
}

/** Confidence bucket edges — coarse enough to have counts, fine enough to see a slope. */
export function confidenceBucket(c: number | null | undefined): string {
  if (c == null || !Number.isFinite(c)) return "unrated";
  if (c < 50) return "<50";
  if (c < 70) return "50-69";
  if (c < 85) return "70-84";
  return "85+";
}

/** Walk-forward SPY regime at a given date: computeRegime over closes STRICTLY up to that date (no
 *  look-ahead — the regime Bill would have seen that morning). Needs 220 closes, else neutral. */
export function regimeAt(spyBars: DailyBar[], date: string): RegimeState {
  const closes = (spyBars ?? []).filter((b) => b.date <= date).map((b) => b.close);
  return computeRegime(closes).state;
}

/** Profit factor over CLOSED replayed trades: gross wins ÷ gross losses. Infinity when nothing lost. */
export function profitFactor(trades: ReplayedTrade[]): number {
  const closed = trades.filter((t) => t.outcome !== "open");
  const gw = closed.filter((t) => t.pnlUsd > 0).reduce((s, t) => s + t.pnlUsd, 0);
  const gl = Math.abs(closed.filter((t) => t.pnlUsd <= 0).reduce((s, t) => s + t.pnlUsd, 0));
  if (gl === 0) return gw > 0 ? Infinity : 0;
  return r2(gw / gl);
}

// ───────────────────────── equity curve / drawdown / vs-SPY ─────────────────────────

export interface EquityPointR { date: string; equity: number; }

/**
 * Daily equity series over `calendar` (ascending trading dates, e.g. SPY's): starting capital + realized
 * P&L of trades exited on/before each date + mark-to-market of trades still on. Marks forward-fill the
 * last known close ≤ date. Pure.
 */
export function equitySeries(trades: ReplayedTrade[], barsBySym: Record<string, DailyBar[]>, calendar: string[], initCap: number): EquityPointR[] {
  const closeAt = (sym: string, date: string): number => {
    const bars = barsBySym[sym] ?? [];
    let px = 0;
    for (const b of bars) { if (b.date > date) break; px = b.close; }
    return px;
  };
  return calendar.map((date) => {
    let eq = initCap;
    for (const t of trades) {
      if (t.entryDate > date) continue;                       // not entered yet
      if (t.exitReason !== "open" && t.exitDate <= date) eq += t.pnlUsd;  // realized
      else {                                                  // still on at `date` → mark it
        const px = closeAt(t.symbol, date);
        if (px > 0) eq += (px - t.entry) * t.qty;
      }
    }
    return { date, equity: r2(eq) };
  });
}

/** Max drawdown (%, ≤ 0) of an equity series. */
export function maxDrawdownPct(series: EquityPointR[]): number {
  let peak = -Infinity, mdd = 0;
  for (const p of series) {
    if (p.equity > peak) peak = p.equity;
    if (peak > 0) mdd = Math.min(mdd, (p.equity / peak - 1) * 100);
  }
  return r2(mdd);
}

// ───────────────────────── report ─────────────────────────

export interface ReplayReport {
  generatedAt: string;
  window: { first: string; last: string } | null;
  config: ReplayConfig & { initCap: number };
  counts: { proposals: number; replayed: number; closed: number; open: number; skipped: string[]; entryClamped: number };
  totals: { pnlUsd: number; winRate: number; profitFactor: number; expectancyUsd: number; avgR: number; maxDrawdownPct: number; endEquity: number; retPct: number; spyRetPct: number | null; vsSpyPct: number | null };
  bySetup: Record<string, Bucket>;
  byRegime: Record<string, Bucket>;
  byTimeOfDay: Record<string, Bucket>;
  byConfidence: Record<string, Bucket>;
  exitReasons: Record<string, number>;
  trades: ReplayedTrade[];
  equity: EquityPointR[];
}

/** Assemble the full walk-forward report from replayed trades. Pure. */
export function buildReport(opts: {
  proposals: number; trades: ReplayedTrade[]; skipped: string[];
  barsBySym: Record<string, DailyBar[]>; spyBars: DailyBar[];
  cfg: ReplayConfig; initCap: number; now?: string;
}): ReplayReport {
  const { trades, skipped } = opts;
  const closed = trades.filter((t) => t.outcome !== "open");
  const wins = closed.filter((t) => t.outcome === "win");
  const first = trades.length ? trades.map((t) => t.entryDate).sort()[0] : null;
  const last = trades.length ? trades.map((t) => t.exitDate).sort().slice(-1)[0] : null;
  const calendar = first && last ? opts.spyBars.map((b) => b.date).filter((d) => d >= first && d <= last) : [];
  const equity = equitySeries(trades, opts.barsBySym, calendar, opts.initCap);
  const endEquity = equity.length ? equity[equity.length - 1].equity : opts.initCap;
  const spyWin = opts.spyBars.filter((b) => first != null && last != null && b.date >= first && b.date <= last);
  const spyRet = spyWin.length >= 2 ? r2((spyWin[spyWin.length - 1].close / spyWin[0].close - 1) * 100) : null;
  const retPct = r2((endEquity / opts.initCap - 1) * 100);
  const rs = closed.map((t) => t.rMultiple);
  const exitReasons: Record<string, number> = {};
  for (const t of trades) exitReasons[t.exitReason] = (exitReasons[t.exitReason] ?? 0) + 1;

  return {
    generatedAt: opts.now ?? new Date().toISOString(),
    window: first && last ? { first, last } : null,
    config: { ...opts.cfg, initCap: opts.initCap },
    counts: { proposals: opts.proposals, replayed: trades.length, closed: closed.length, open: trades.length - closed.length, skipped, entryClamped: trades.filter((t) => t.entryClamped).length },
    totals: {
      pnlUsd: r2(closed.reduce((s, t) => s + t.pnlUsd, 0)),
      winRate: closed.length ? Math.round((wins.length / closed.length) * 100) : 0,
      profitFactor: profitFactor(trades),
      expectancyUsd: closed.length ? r2(closed.reduce((s, t) => s + t.pnlUsd, 0) / closed.length) : 0,
      avgR: rs.length ? r2(rs.reduce((s, x) => s + x, 0) / rs.length) : 0,
      maxDrawdownPct: maxDrawdownPct(equity),
      endEquity, retPct,
      spyRetPct: spyRet,
      vsSpyPct: spyRet != null ? r2(retPct - spyRet) : null,
    },
    bySetup: bucketVia(trades, (t) => (t.setup && String(t.setup).trim()) || "untagged"),
    byRegime: bucketVia(trades, (t) => regimeAt(opts.spyBars, t.cycle)),
    byTimeOfDay: attribution(toAttributed(trades)).byTimeOfDay,
    byConfidence: bucketVia(trades, (t) => confidenceBucket(t.confidence)),
    exitReasons,
    trades,
    equity,
  };
}

const pfStr = (x: number) => (x === Infinity ? "∞" : x.toFixed(2));
const usd = (n: number) => (n < 0 ? `−$${Math.abs(n).toFixed(2)}` : `+$${n.toFixed(2)}`);

function bucketTable(title: string, buckets: Record<string, Bucket>): string[] {
  const rows = Object.entries(buckets).sort((a, b) => b[1].totalPnl - a[1].totalPnl || a[0].localeCompare(b[0]));
  if (!rows.length) return [`### ${title}`, "", "_no closed trades_", ""];
  return [
    `### ${title}`,
    "",
    "| bucket | trades | win% | total P&L | avg P&L | expectancy |",
    "|---|---|---|---|---|---|",
    ...rows.map(([k, b]) => `| ${k} | ${b.count} | ${b.winRate}% | ${usd(b.totalPnl)} | ${usd(b.avgPnl)} | ${usd(b.expectancy)} |`),
    "",
  ];
}

/** Render the walk-forward report as markdown — the honest labelling + caveats live HERE so a test can
 *  assert they are stated. Pure. */
export function buildReplayMd(r: ReplayReport): string {
  const lines: string[] = [
    "# Bill the Bull — Backtest v2: REAL-PROPOSAL REPLAY (strategy evaluation)",
    "",
    `_Generated ${r.generatedAt} by \`agent/src/backtest-replay.ts\` (offline analysis — reads the proposal ledger + historical prices; places NOTHING)._`,
    "",
    "## What this is (vs the plumbing backtest)",
    "`backtest/out/RESULTS.md` (from `backtest.py`) validates the **deterministic risk plumbing** with a",
    "**mechanical** trend stand-in — it says nothing about the LLM's picks. THIS report is the",
    "**strategy-evaluation layer**: it replays **Bill's actual logged proposals** (`memory/ledger.jsonl` —",
    "every real entry with its price, trail, setup tag, confidence and timestamp) against historical daily",
    "bars under his **real deterministic exit rules** (synthetic trailing stop at each proposal's own",
    "trail %, peak-seeded at entry" + (r.config.targetPct ? `; hard target ${r.config.targetPct}%` : "") + (r.config.maxHoldDays ? `; time-stop ${r.config.maxHoldDays} trading days` : "") + "). Attribution below uses the SAME `attribution()` aggregation the",
    "live scan's outcome-feedback loop consumes.",
    "",
  ];

  if (!r.trades.length) {
    lines.push("## Result", "", `**No replayable proposals** (${r.counts.proposals} eligible in the ledger window; skipped: ${r.counts.skipped.length ? r.counts.skipped.join(", ") : "none"}). Once Bill logs real buy proposals, re-run \`npm run backtest:replay\`.`, "");
  } else {
    const t = r.totals;
    lines.push(
      "## Headline (closed replayed trades)",
      "",
      `| window | proposals replayed | closed / open | win% | P&L | expectancy/trade | avg R | profit factor | max DD | strategy ret | SPY ret | vs SPY |`,
      "|---|---|---|---|---|---|---|---|---|---|---|---|",
      `| ${r.window!.first} → ${r.window!.last} | ${r.counts.replayed} | ${r.counts.closed} / ${r.counts.open} | ${t.winRate}% | ${usd(t.pnlUsd)} | ${usd(t.expectancyUsd)} | ${t.avgR.toFixed(2)}R | ${pfStr(t.profitFactor)} | ${t.maxDrawdownPct.toFixed(1)}% | ${t.retPct.toFixed(1)}% | ${t.spyRetPct != null ? t.spyRetPct.toFixed(1) + "%" : "—"} | ${t.vsSpyPct != null ? (t.vsSpyPct >= 0 ? "+" : "") + t.vsSpyPct.toFixed(1) + "%" : "—"} |`,
      "",
      `Exit mix: ${Object.entries(r.exitReasons).map(([k, v]) => `${k} ×${v}`).join(" · ") || "—"}. ` +
      `Entry clamps (est_price outside the entry bar → filled at open): ${r.counts.entryClamped}. ` +
      `Skipped (no price data): ${r.counts.skipped.length ? r.counts.skipped.join(", ") : "none"}.`,
      "",
      "## Walk-forward attribution (feeds the same loop the live scan reads)",
      "",
      ...bucketTable("By setup tag", r.bySetup),
      ...bucketTable("By SPY regime at proposal time (walk-forward, no look-ahead)", r.byRegime),
      ...bucketTable("By time of day (ET session of the proposal)", r.byTimeOfDay),
      ...bucketTable("By confidence bucket", r.byConfidence),
      "Equity curve → `replay_equity.csv` · per-trade detail → `replay_trades.csv` · machine-readable buckets → `replay_attribution.json`.",
      "",
    );
  }

  lines.push(
    "## Honest limits — read before believing any number",
    "- **A replay of past proposals is NOT a forward guarantee.** It measures how the ideas Bill already",
    "  had would have resolved under his exit rules — nothing about ideas he'll have next month.",
    "- **Selection/survivorship bias**: only symbols Bill actually proposed (and that still return data",
    "  from the keyless Yahoo feed) are replayed; delisted/renamed names drop out.",
    "- **Look-ahead caveat**: entries use the ledger's recorded `est_price` on the proposal's cycle date",
    "  (clamped to that day's bar when implausible), so no future data leaks into entries; exits test",
    "  daily-bar lows against a stop set from the PRIOR day's peak — a wick the live 5-minute poll missed",
    "  will fire here (conservative), while a same-day new-peak→fall stop-out cannot (optimistic).",
    "- **LLM-driven exits are NOT replayed**: the news-aware profit trim, revalidation sells and",
    "  reallocation swaps are model decisions — the replay holds to the deterministic stop only, so live",
    "  results will differ from replayed results even on identical entries.",
    "- **The LLM memorization mirage still applies** to any window inside the model's training data: the",
    "  model may have 'known' these prices when proposing. Forward paper results (Phase 0) remain the",
    "  only clean validation; treat this as diagnostic attribution, not proof of edge.",
    "- **Costs**: " + (r.config.slipBps ?? 0) + " bps per side slippage, zero commission (Alpaca paper).",
    "  No dividends/corporate-action adjustments beyond what the price feed bakes in.",
    "",
    "_Educational/research output — paper-trading analysis only, not investment advice._",
  );
  return lines.join("\n");
}
