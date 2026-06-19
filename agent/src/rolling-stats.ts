// Rolling (recent-form) trade analytics — PURE, no network, read-only over the ledger's closed trades.
// Where stats.ts reports the ALL-TIME scoreboard, this reports the SAME four metrics (win-rate, avg win,
// avg loss, expectancy) over just the most recent N closed trades — Bill's current form, not his lifetime
// record. A streak of recent losses gets buried in an all-time average but jumps out of a last-10 window.
// Bars/orders are never touched; this slices the same closed-trade set stats.ts already reads, so it is
// trivially unit-testable and cannot affect any live/paper trading path.
//
// "Most recent" is defined by entry timestamp (ts) ascending, so the tail is well-defined regardless of the
// order the caller passes records in. Only win/loss outcomes are scored (open/expired/unknown are ignored),
// mirroring stats.ts. The per-window math mirrors stats.ts EXACTLY so that a window >= total closed trades
// reproduces the all-time numbers.
const num = (v: unknown): number => { const x = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN; return Number.isFinite(x) ? x : 0; };
const r2 = (n: number) => Math.round(n * 100) / 100;
const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

/** Minimal closed-trade shape rolling stats need — a structural subset of ledger ProposalRecord. */
export interface RollingTrade {
  ts?: string;                  // ISO timestamp of the proposal/entry (defines recency)
  outcome?: string | null;      // "win" | "loss" | … (only win/loss are scored)
  realizedPnlUsd?: number | null;
}

export interface RollingWindow {
  window: number;      // requested window size (e.g. 10) — the cap, not the count
  trades: number;      // closed trades actually in this window (<= window)
  wins: number;
  losses: number;
  winRate: number;     // integer percent, mirrors stats.winRate
  avgWin: number;      // mean realized $ over winners (>= 0)
  avgLoss: number;     // mean realized $ over losers (<= 0), mirrors stats.avgLoss sign
  expectancy: number;  // winRate·avgWin + lossRate·avgLoss (textbook per-trade EV)
}

/** Rolling windows keyed by `last<N>` (e.g. { last10, last20 }). */
export type RollingStats = Record<string, RollingWindow>;

const DEFAULT_WINDOWS = [10, 20];

/** Summarize one window of closed trades into a RollingWindow (formula mirrors stats.ts). */
function summarize(window: number, trades: RollingTrade[]): RollingWindow {
  const wins = trades.filter((t) => t.outcome === "win");
  const losses = trades.filter((t) => t.outcome === "loss");
  const winUsd = wins.map((t) => num(t.realizedPnlUsd));
  const lossUsd = losses.map((t) => Math.abs(num(t.realizedPnlUsd)));
  const n = trades.length;
  const winRate = n ? Math.round((wins.length / n) * 100) : 0;
  const avgWin = wins.length ? r2(mean(winUsd)) : 0;
  const avgLoss = losses.length ? r2(-mean(lossUsd)) : 0;
  const expectancy = n ? r2((winRate / 100) * avgWin + (1 - winRate / 100) * avgLoss) : 0;
  return { window, trades: n, wins: wins.length, losses: losses.length, winRate, avgWin, avgLoss, expectancy };
}

/**
 * Rolling analytics over a set of trades. Pure; the caller passes ledger records (closed or not — non
 * win/loss outcomes are filtered out here). For each window size, takes the most recent N closed trades
 * (by entry ts ascending) and summarizes them. Unparseable timestamps sort as oldest.
 */
export function rollingStats(trades: RollingTrade[], windows: number[] = DEFAULT_WINDOWS): RollingStats {
  const closed = (trades ?? [])
    .filter((t) => t && (t.outcome === "win" || t.outcome === "loss"))
    .slice()
    .sort((a, b) => (new Date(a.ts ?? "").getTime() || 0) - (new Date(b.ts ?? "").getTime() || 0));
  const out: RollingStats = {};
  for (const w of windows) out[`last${w}`] = summarize(w, w > 0 ? closed.slice(-w) : []);
  return out;
}

/**
 * One-line Discord-friendly footer for the rolling windows, or "" if there are no closed trades to report.
 * e.g. "📊 Recent form (rolling): last 10 — 60% win · avg +$120 / −$45 · exp +$54.0 | last 20 — 55% win · …"
 */
export function renderRollingFooter(rolling: RollingStats): string {
  const usd = (n: number) => (n < 0 ? "−$" + Math.abs(n).toFixed(0) : "$" + n.toFixed(0));
  const signed = (n: number) => (n < 0 ? "−$" + Math.abs(n).toFixed(1) : "+$" + n.toFixed(1));
  const parts = Object.values(rolling)
    .filter((w) => w.trades > 0)
    .map((w) => `last ${w.window} — ${w.winRate}% win · avg ${usd(w.avgWin)} / ${usd(w.avgLoss)} · exp ${signed(w.expectancy)} (${w.trades} trades)`);
  return parts.length ? "📊 Recent form (rolling): " + parts.join(" | ") : "";
}
