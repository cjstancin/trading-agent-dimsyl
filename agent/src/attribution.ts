// Trade attribution analytics (Bull backlog #9) — PURE, no network, read-only over the ledger's closed
// trades. Given the set of closed proposal records (each carrying its setup tag, entry timestamp, outcome,
// and realized P&L), group + aggregate realized P&L and win-rate three ways: by setup/strategy tag, by
// time-of-day bucket of entry (ET), and by day-of-week. Bars/orders are never touched — this slices the
// same closed-trade set the trade-level stats already read, so it is trivially unit-testable.
//
// Time-of-day uses the entry timestamp converted to America/New_York (the session clock), so DST is handled
// by Intl rather than a hardcoded offset. Buckets mirror a trader's mental session map:
//   premarket  < 09:30 ET   ·   open  09:30–11:00   ·   midday  11:00–15:00   ·   close  ≥ 15:00
const num = (v: unknown): number => { const x = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN; return Number.isFinite(x) ? x : 0; };
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Minimal closed-trade shape attribution needs — a structural subset of ledger ProposalRecord. */
export interface AttributedTrade {
  ts: string;                       // ISO timestamp of the proposal/entry
  setup?: string | null;            // setup/strategy tag (Bull v2 #5)
  outcome?: string | null;          // "win" | "loss" | … (only win/loss are scored)
  realizedPnlUsd?: number | null;
}

export interface Bucket {
  count: number;
  wins: number;
  winRate: number;     // integer percent, mirrors stats.winRate
  totalPnl: number;    // sum realized $ over the bucket
  avgPnl: number;      // mean realized $ per trade
  expectancy: number;  // winRate·avgWin + lossRate·avgLoss (textbook per-trade EV)
}

export interface Attribution {
  bySetup: Record<string, Bucket>;
  byTimeOfDay: Record<string, Bucket>;
  byDayOfWeek: Record<string, Bucket>;
}

const ET = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });

/** ET session-clock parts for a timestamp, or null if unparseable. */
function etParts(ts: string): { weekday: string; minutes: number } | null {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const p = Object.fromEntries(ET.formatToParts(d).map((x) => [x.type, x.value]));
  const minutes = Number(p.hour) * 60 + Number(p.minute);
  if (!Number.isFinite(minutes)) return null;
  return { weekday: String(p.weekday), minutes };
}

function timeOfDay(ts: string): string {
  const et = etParts(ts);
  if (!et) return "unknown";
  if (et.minutes < 9 * 60 + 30) return "premarket";   // before 09:30 ET
  if (et.minutes < 11 * 60) return "open";             // 09:30–11:00
  if (et.minutes < 15 * 60) return "midday";           // 11:00–15:00
  return "close";                                      // ≥ 15:00
}

function dayOfWeek(ts: string): string {
  const et = etParts(ts);
  return et ? et.weekday : "unknown";
}

/** Aggregate one group of closed trades into a Bucket (win/loss only are scored). */
function summarize(trades: AttributedTrade[]): Bucket {
  const count = trades.length;
  const pnls = trades.map((t) => num(t.realizedPnlUsd));
  const winPnls = trades.filter((t) => t.outcome === "win").map((t) => num(t.realizedPnlUsd));
  const lossPnls = trades.filter((t) => t.outcome === "loss").map((t) => num(t.realizedPnlUsd));
  const wins = winPnls.length;
  const totalPnl = pnls.reduce((s, x) => s + x, 0);
  const winRate = count ? Math.round((wins / count) * 100) : 0;
  const avgWin = winPnls.length ? winPnls.reduce((s, x) => s + x, 0) / winPnls.length : 0;
  const avgLoss = lossPnls.length ? lossPnls.reduce((s, x) => s + x, 0) / lossPnls.length : 0;
  const expectancy = count ? (wins / count) * avgWin + (lossPnls.length / count) * avgLoss : 0;
  return { count, wins, winRate, totalPnl: r2(totalPnl), avgPnl: count ? r2(totalPnl / count) : 0, expectancy: r2(expectancy) };
}

/** Group trades by keyOf, then summarize each group. Only non-empty buckets are emitted. */
function groupBy(trades: AttributedTrade[], keyOf: (t: AttributedTrade) => string): Record<string, Bucket> {
  const groups: Record<string, AttributedTrade[]> = {};
  for (const t of trades) (groups[keyOf(t)] ||= []).push(t);
  const out: Record<string, Bucket> = {};
  for (const k in groups) out[k] = summarize(groups[k]);
  return out;
}

/**
 * Trade attribution over a set of CLOSED trades. Pure; the caller passes the already-closed ledger records.
 * Untagged setups bucket under "untagged"; unparseable timestamps bucket under "unknown".
 */
export function attribution(trades: AttributedTrade[]): Attribution {
  const closed = (trades ?? []).filter((t) => t && (t.outcome === "win" || t.outcome === "loss"));
  return {
    bySetup: groupBy(closed, (t) => (t.setup && String(t.setup).trim()) || "untagged"),
    byTimeOfDay: groupBy(closed, (t) => timeOfDay(t.ts)),
    byDayOfWeek: groupBy(closed, (t) => dayOfWeek(t.ts)),
  };
}

/**
 * One-line Discord-friendly per-strategy P&L attribution footer — the bySetup slice rendered for Bill's EOD
 * wrap, mirroring renderRollingFooter / renderExcursionFooter. Returns "" when no closed trade is tagged, so a
 * fresh account adds nothing. Setups are sorted by realized P&L descending (ties broken by name) so the best
 * and worst earners read left-to-right deterministically. Caps at `limit` setups and appends "(+N more)" so a
 * long tail is DISCLOSED, never silently dropped. Pure render over already-computed buckets; touches no order.
 * e.g. "🧭 By strategy (P&L): breakout +$60 · 50% win (2) | pullback −$20 · 0% win (1)"
 */
export function renderAttributionFooter(attr: Attribution, limit = 8): string {
  const usd = (n: number) => (n < 0 ? "−$" + Math.abs(n).toFixed(0) : "+$" + n.toFixed(0));
  const entries = Object.entries(attr?.bySetup ?? {})
    .filter(([, b]) => b.count > 0)
    .sort((a, b) => b[1].totalPnl - a[1].totalPnl || a[0].localeCompare(b[0]));
  if (!entries.length) return "";
  const shown = entries.slice(0, Math.max(0, limit));
  const parts = shown.map(([name, b]) => `${name} ${usd(b.totalPnl)} · ${b.winRate}% win (${b.count})`);
  const more = entries.length - shown.length;
  return "🧭 By strategy (P&L): " + parts.join(" | ") + (more > 0 ? ` | +${more} more` : "");
}
