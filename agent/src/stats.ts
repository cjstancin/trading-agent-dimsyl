// Deterministic measurement (Bull v2 #2/#3) — no LLM, no orders. Two layers:
//   (a) Portfolio-history metrics: equity curve, vs-SPY benchmark, month return, drawdown/maxDD, Sharpe.
//       These work immediately from Alpaca's portfolio history (even on a flat account).
//   (b) Trade-level stats: win rate, profit factor, expectancy, avg win/loss, avg R — reconciled from the
//       proposal ledger + closed orders. Latent until Bill actually trades (returns zeros, correct shape).
import { readLedger, type ProposalRecord } from "./ledger.js";
import { getPortfolioHistory, getClosedOrders } from "./alpaca.js";
import { withTimeout, DEFAULT_TIMEOUT_MS } from "./http-utils.js";

const r2 = (n: number) => Math.round(n * 100) / 100;
const r1 = (n: number) => Math.round(n * 10) / 10;
const num = (v: unknown): number => { const x = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN; return Number.isFinite(x) ? x : 0; };
const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const stdev = (a: number[]) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };

async function spyCloses(n: number): Promise<number[]> {
  if (n < 2) return [];
  try {
    const r = await withTimeout(
      (signal) => fetch("https://query1.finance.yahoo.com/v8/finance/chart/SPY?range=3mo&interval=1d", { headers: { "User-Agent": "Mozilla/5.0 (compatible; Bull/1.0)" }, signal }),
      DEFAULT_TIMEOUT_MS,
    );
    if (!r.ok) return [];
    const j = await r.json();
    const cl = (j?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? []).filter((x: number | null) => x != null && x > 0) as number[];
    return cl.slice(-n);
  } catch { return []; }
}

export interface Measurement {
  equityCurve: number[];
  spyCurve: number[];
  vsSpyPct: number;
  monthPnlPct: number;
  risk: { drawdown: number; maxDD: number; peakEquity: number };
  stats: { winRate: number; trades: number; wins: number; losses: number; avgWin: number; avgLoss: number; profitFactor: number; sharpe: number; sortino: number; calmar: number; expectancy: number; avgR: number };
  proposals: { total: number; proposed: number; rejected: number; recent: ProposalRecord[] };
}

export async function measure(equityNow: number): Promise<Measurement> {
  // ---- (a) portfolio-history metrics ----
  let eq: number[] = [];
  try {
    const ph = (await getPortfolioHistory("1M", "1D")) as { equity?: (number | null)[] };
    eq = (ph?.equity ?? []).map(num).filter((x) => x > 0);
  } catch { /* leave empty */ }
  if (!eq.length) eq = [equityNow];
  // cap series to ~40 points for the chart
  const step = Math.max(1, Math.ceil(eq.length / 40));
  const equityCurve = eq.filter((_, i) => i % step === 0 || i === eq.length - 1).map((x) => r2(x));

  // drawdown / maxDD from the equity series
  let peak = eq[0], maxDD = 0;
  for (const v of eq) { if (v > peak) peak = v; const dd = peak > 0 ? (v / peak - 1) * 100 : 0; if (dd < maxDD) maxDD = dd; }
  const drawdown = peak > 0 ? r1((eq[eq.length - 1] / peak - 1) * 100) : 0;
  const monthPnlPct = eq.length > 1 && eq[0] > 0 ? r1((eq[eq.length - 1] / eq[0] - 1) * 100) : 0;

  // Sharpe / Sortino (annualized) from daily returns
  const rets: number[] = [];
  for (let i = 1; i < eq.length; i++) if (eq[i - 1] > 0) rets.push(eq[i] / eq[i - 1] - 1);
  const sd = stdev(rets), m = mean(rets);
  const downside = stdev(rets.filter((x) => x < 0));
  const sharpe = sd ? r2((m / sd) * Math.sqrt(252)) : 0;
  const sortino = downside ? r2((m / downside) * Math.sqrt(252)) : 0;
  const calmar = maxDD < 0 ? r2((monthPnlPct * 12) / Math.abs(maxDD)) : 0;

  // vs SPY over the same window (both rebased to 100)
  const spy = await spyCloses(equityCurve.length);
  let spyCurve: number[] = [], vsSpyPct = 0;
  if (spy.length >= 2 && equityCurve.length >= 2) {
    const s0 = spy[0], e0 = equityCurve[0];
    spyCurve = spy.map((x) => r2((x / s0) * 100));
    const youRet = (equityCurve[equityCurve.length - 1] / e0 - 1) * 100;
    const spyRet = (spy[spy.length - 1] / s0 - 1) * 100;
    vsSpyPct = r1(youRet - spyRet);
  }

  // ---- (b) trade-level stats from the ledger (reconciled) ----
  const ledger = readLedger();
  const proposedAll = ledger.filter((l) => l.status === "proposed" || l.status === "placed");
  const rejected = ledger.filter((l) => l.status === "rejected");
  const closed = ledger.filter((l) => l.outcome === "win" || l.outcome === "loss");
  const wins = closed.filter((l) => l.outcome === "win");
  const losses = closed.filter((l) => l.outcome === "loss");
  const winUsd = wins.map((l) => num(l.realizedPnlUsd));
  const lossUsd = losses.map((l) => Math.abs(num(l.realizedPnlUsd)));
  const grossWin = winUsd.reduce((s, x) => s + x, 0), grossLoss = lossUsd.reduce((s, x) => s + x, 0);
  const trades = closed.length;
  const winRate = trades ? Math.round((wins.length / trades) * 100) : 0;
  const avgWin = wins.length ? r2(mean(winUsd)) : 0;
  const avgLoss = losses.length ? r2(-mean(lossUsd)) : 0;
  const profitFactor = grossLoss ? r2(grossWin / grossLoss) : 0;
  const expectancy = trades ? r2((winRate / 100) * avgWin + (1 - winRate / 100) * avgLoss) : 0;
  const rs = closed.map((l) => num(l.rMultiple)).filter((x) => x !== 0);
  const avgR = rs.length ? r2(mean(rs)) : 0;

  return {
    equityCurve,
    spyCurve,
    vsSpyPct,
    monthPnlPct,
    risk: { drawdown, maxDD: r1(maxDD), peakEquity: r2(peak) },
    stats: { winRate, trades, wins: wins.length, losses: losses.length, avgWin, avgLoss, profitFactor, sharpe, sortino, calmar, expectancy, avgR },
    proposals: { total: ledger.length, proposed: proposedAll.length, rejected: rejected.length, recent: ledger.slice(-10).reverse() },
  };
}

// Pull recent fills (Alpaca FILL activities) for the blotter — best-effort, returns [] on failure.
export async function recentFills(limit = 12): Promise<Array<{ time: string; t: string; side: string; qty: number; price: number; value: number }>> {
  try {
    const acts = (await getClosedOrders(limit)) as Record<string, unknown>[];
    return (Array.isArray(acts) ? acts : [])
      .filter((o) => num(o.filled_qty) > 0)
      .slice(0, limit)
      .map((o) => {
        const qty = num(o.filled_qty), price = num(o.filled_avg_price);
        return { time: String(o.filled_at ?? o.submitted_at ?? "").slice(11, 16), t: String(o.symbol ?? "?"), side: String(o.side ?? ""), qty, price: r2(price), value: r2(qty * price) };
      });
  } catch { return []; }
}
