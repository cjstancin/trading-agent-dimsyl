// Backtest v2 CLI — replay Bill's REAL proposal ledger against historical prices. OFFLINE ANALYSIS:
// reads memory/ledger.jsonl + the keyless Yahoo chart feed (the SAME source stats.ts/regime.ts already
// use — no new/paid data), simulates each proposal under the deterministic exit rules (see replay.ts),
// and writes the strategy-evaluation report to backtest/out/ WITHOUT touching the plumbing backtest's
// RESULTS.md. Never talks to Alpaca, never places anything.
//
//   npm run backtest:replay                      # default: memory/ledger.jsonl, 5 bps slip, $1000 cap
//   npm run backtest:replay -- --ledger path.jsonl --capital 1000 --slip-bps 5
//   npm run backtest:replay -- --target 15 --max-hold 20   # sensitivity: hard target / time-stop
//   npm run backtest:replay -- --refresh                    # ignore the price cache
//
// Outputs → backtest/out/REPLAY-RESULTS.md (+ replay_trades.csv, replay_equity.csv, replay_attribution.json)
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { withTimeout, DEFAULT_TIMEOUT_MS } from "./http-utils.js";
import { parseLedgerJsonl, replayableProposals, replayAll, buildReport, buildReplayMd, type DailyBar, type ReplayConfig } from "./replay.js";

const OUT_DIR = fileURLToPath(new URL("../../backtest/out", import.meta.url));
const CACHE_DIR = fileURLToPath(new URL("../../backtest/data/replay-cache", import.meta.url));
const DEFAULT_LEDGER = fileURLToPath(new URL("../../memory/ledger.jsonl", import.meta.url));

// ── args ──
const argv = process.argv.slice(2);
const argVal = (name: string): string | null => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : null; };
const ledgerPath = argVal("--ledger") ?? DEFAULT_LEDGER;
const initCap = Number(argVal("--capital") ?? 1000);
const slipBps = Number(argVal("--slip-bps") ?? 5);
const targetPct = argVal("--target") != null ? Number(argVal("--target")) : null;
const maxHoldDays = argVal("--max-hold") != null ? Number(argVal("--max-hold")) : null;
const refresh = argv.includes("--refresh");

// ── keyless Yahoo daily bars (same chart endpoint stats.ts/regime.ts use), cached on disk ──
async function fetchBars(symbol: string, period1: number, period2: number): Promise<DailyBar[]> {
  const fp = path.join(CACHE_DIR, `${symbol.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
  if (!refresh && existsSync(fp)) {
    try {
      const cached = JSON.parse(readFileSync(fp, "utf8")) as { period1: number; bars: DailyBar[] };
      if (cached.period1 <= period1 && Array.isArray(cached.bars)) return cached.bars;
    } catch { /* refetch */ }
  }
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d`;
  const r = await withTimeout(
    (signal) => fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; Bull/1.0)" }, signal }),
    DEFAULT_TIMEOUT_MS,
  );
  if (!r.ok) throw new Error(`yahoo ${symbol}: HTTP ${r.status}`);
  const j = (await r.json()) as any;
  const res = j?.chart?.result?.[0];
  const ts: number[] = res?.timestamp ?? [];
  const q = res?.indicators?.quote?.[0] ?? {};
  const bars: DailyBar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const [o, h, l, c] = [q.open?.[i], q.high?.[i], q.low?.[i], q.close?.[i]];
    if (o > 0 && h > 0 && l > 0 && c > 0) bars.push({ date: new Date(ts[i] * 1000).toISOString().slice(0, 10), open: o, high: h, low: l, close: c });
  }
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(fp, JSON.stringify({ period1, fetchedAt: new Date().toISOString(), bars }));
  return bars;
}

async function main(): Promise<void> {
  const cfg: ReplayConfig = { slipBps, targetPct, maxHoldDays };
  mkdirSync(OUT_DIR, { recursive: true });

  const raw = existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8") : "";
  const ledger = parseLedgerJsonl(raw);
  const eligible = replayableProposals(ledger);
  console.log(`[replay] ledger ${ledgerPath}: ${ledger.length} records, ${eligible.length} replayable buy proposals`);

  let barsBySym: Record<string, DailyBar[]> = {};
  let spyBars: DailyBar[] = [];
  let trades: ReturnType<typeof replayAll>["trades"] = [];
  let skipped: string[] = [];

  if (eligible.length) {
    const firstDate = eligible.map((p) => p.cycle || String(p.ts).slice(0, 10)).sort()[0];
    const DAY = 86400;
    const p2 = Math.floor(Date.now() / 1000) + DAY;
    const p1 = Math.floor(new Date(firstDate + "T00:00:00Z").getTime() / 1000) - 30 * DAY;      // entry buffer
    const p1Spy = Math.floor(new Date(firstDate + "T00:00:00Z").getTime() / 1000) - 500 * DAY;  // 200-DMA + slope history
    const symbols = [...new Set(eligible.map((p) => p.symbol.toUpperCase()))].sort();
    console.log(`[replay] fetching daily bars for ${symbols.length} symbols + SPY (keyless Yahoo chart, cache: ${CACHE_DIR})`);
    spyBars = await fetchBars("SPY", p1Spy, p2);
    for (const s of symbols) {
      try { barsBySym[s] = await fetchBars(s, p1, p2); }
      catch (e) { console.warn(`[replay] no data for ${s}: ${String(e instanceof Error ? e.message : e)}`); }
    }
    ({ trades, skipped } = replayAll(eligible, barsBySym, cfg));
  }

  const report = buildReport({ proposals: eligible.length, trades, skipped, barsBySym, spyBars, cfg, initCap });

  // write outputs (new files — the plumbing backtest's RESULTS.md is never touched)
  const mdPath = path.join(OUT_DIR, "REPLAY-RESULTS.md");
  writeFileSync(mdPath, buildReplayMd(report) + "\n");
  writeFileSync(
    path.join(OUT_DIR, "replay_trades.csv"),
    ["symbol,ts,entryDate,entry,exitDate,exit,exitReason,holdDays,qty,trailPct,setup,confidence,pnlUsd,retPct,rMultiple,outcome",
      ...report.trades.map((t) => [t.symbol, t.ts, t.entryDate, t.entry, t.exitDate, t.exit, t.exitReason, t.holdDays, t.qty, t.trailPct, JSON.stringify(t.setup ?? ""), t.confidence ?? "", t.pnlUsd, t.retPct, t.rMultiple, t.outcome].join(",")),
    ].join("\n") + "\n",
  );
  writeFileSync(
    path.join(OUT_DIR, "replay_equity.csv"),
    ["date,equity", ...report.equity.map((p) => `${p.date},${p.equity}`)].join("\n") + "\n",
  );
  writeFileSync(
    path.join(OUT_DIR, "replay_attribution.json"),
    JSON.stringify({ generatedAt: report.generatedAt, source: "real-proposal-replay (backtest v2)", window: report.window, counts: report.counts, totals: report.totals, bySetup: report.bySetup, byRegime: report.byRegime, byTimeOfDay: report.byTimeOfDay, byConfidence: report.byConfidence, exitReasons: report.exitReasons }, null, 2) + "\n",
  );

  console.log(`[replay] ${report.counts.replayed} replayed (${report.counts.closed} closed, ${report.counts.open} open) — win ${report.totals.winRate}%, P&L $${report.totals.pnlUsd}, PF ${report.totals.profitFactor === Infinity ? "∞" : report.totals.profitFactor}, maxDD ${report.totals.maxDrawdownPct}%`);
  console.log(`[replay] wrote ${mdPath} (+ replay_trades.csv, replay_equity.csv, replay_attribution.json)`);
}

main().catch((e) => { console.error("[replay] FAILED:", e instanceof Error ? e.message : e); process.exit(1); });
