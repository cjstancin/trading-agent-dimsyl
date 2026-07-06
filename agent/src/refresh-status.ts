// Refresh dashboard/data/status.json from the LIVE Alpaca PAPER account (read-only, LLM-free).
// Replaces the sample book with real equity / cash / positions / open orders, flips isSample:false,
// and zeroes the sample-only history (fills/journal/signals/movers/tickers/stats) so nothing
// fictional survives for a fresh real account. Deterministic; no orders are ever placed.
//   npm run refresh
import "./load-env.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { paperSnapshot } from "./alpaca.js";
import { measure, recentFills } from "./stats.js";
import { readiness } from "./readiness.js";
import { computeAlerts } from "./alerts.js";
import { reconcile } from "./reconcile.js";
import { getMode } from "./mode.js";
import { getProfile } from "./profile.js";
import { rulesFor } from "./guardrails.js";
import { excursionSummary, type ExcursionTrade } from "./excursion-stats.js";
import { fetchSpyRegime, regimePill, renderRegimeLine } from "./regime.js";
import { isMarketDayToday } from "./market-calendar.js";
import { DEFAULT_RISK } from "./risk-engine.js";
import { runSyntheticStops, readPositionTrails } from "./synthetic-stops.js";
import { installSafetyNet } from "./http-utils.js";

installSafetyNet("bill-refresh");

const { sendDiscord } = await import("../../scripts/notify-discord.mjs" as string);

const STATUS = fileURLToPath(new URL("../../dashboard/data/status.json", import.meta.url));

const num = (v: unknown): number => {
  const x = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(x) ? x : 0;
};
const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

const snap = await paperSnapshot();
if (!snap.connected) {
  console.error("Alpaca PAPER not connected — leaving status.json untouched. " + (snap.error ?? ""));
  process.exit(1);
}

const acct = (snap.account ?? {}) as Record<string, unknown>;
const rawPositions = (Array.isArray(snap.positions) ? snap.positions : []) as Record<string, unknown>[];
const rawOrders = (Array.isArray(snap.openOrders) ? snap.openOrders : []) as Record<string, unknown>[];

const equity = num(acct.equity ?? acct.portfolio_value);
const cash = num(acct.cash);
const lastEquity = num(acct.last_equity) || equity;

const positions = rawPositions.map((p) => ({
  t: String(p.symbol ?? "?"),
  name: String(p.symbol ?? "?"),
  qty: num(p.qty),
  price: round(num(p.current_price)),
  avg: round(num(p.avg_entry_price)),
  mktVal: round(num(p.market_value)),
  unrealPct: round(num(p.unrealized_plpc) * 100, 1),
  dayPct: round(num(p.change_today) * 100, 1),
  stop: null as number | null,
}));

const openOrders = rawOrders.map((o) => ({
  time: String(o.submitted_at ?? "").slice(11, 16),
  t: String(o.symbol ?? "?"),
  side: String(o.side ?? ""),
  type: String(o.type ?? o.order_type ?? ""),
  qty: num(o.qty),
  limit: o.limit_price != null ? num(o.limit_price) : null,
  status: String(o.status ?? ""),
}));

const grossUsd = positions.reduce((s, p) => s + Math.abs(p.mktVal), 0);
const grossExposure = equity > 0 ? round((grossUsd / equity) * 100, 0) : 0;
const largestPos = equity > 0 && positions.length ? round((Math.max(...positions.map((p) => Math.abs(p.mktVal))) / equity) * 100, 0) : 0;
// Portfolio heat = aggregate open risk (each position's own trail% × market value) as % of equity. This —
// with cash — is what actually bounds how many names Bill can hold (there is NO fixed position-count cap).
const trailsForHeat = readPositionTrails();
const heatUsd = rawPositions.reduce((s, p) => {
  const mv = Math.abs(num(p.market_value));
  const tr = (trailsForHeat[String(p.symbol ?? "").toUpperCase()] ?? 20) / 100;
  return s + mv * tr;
}, 0);
const heatUsedPct = equity > 0 ? round((heatUsd / equity) * 100, 1) : 0;

const prev = JSON.parse(readFileSync(STATUS, "utf8")) as Record<string, unknown>;

// Bull v2 measurement: reconcile closed trades into ledger outcomes, then compute the scoreboard.
await reconcile();
const m = await measure(equity);
// Trade-journal entries (written by `npm run journal`) → dashboard Journal tab. Each carries the per-trade
// MAE/MFE excursion (Bull #12) when bars were available at journal time; surface those fields here so the
// dashboard can show max-adverse / max-favorable per closed trade.
let journalEntries: unknown[] = [];
let excursionTrades: ExcursionTrade[] = [];
try {
  const jf = fileURLToPath(new URL("../../memory/journal.jsonl", import.meta.url));
  if (existsSync(jf)) {
    const raw = readFileSync(jf, "utf8").split(/\r?\n/).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) as Record<string, unknown>[];
    excursionTrades = raw;
    journalEntries = raw
      .map((j) => ({ t: j.symbol, side: "Long", opened: String(j.openedAt ?? "").slice(0, 10), closed: String(j.closedAt ?? "").slice(0, 10), entry: j.entry, exit: j.exit, pnlPct: j.pnlPct, pnlUsd: j.pnlUsd, grade: j.grade, lesson: j.note, maePct: j.maePct ?? null, maeUsd: j.maeUsd ?? null, mfePct: j.mfePct ?? null, mfeUsd: j.mfeUsd ?? null }))
      .slice(-20).reverse();
  }
} catch { /* none yet */ }
// Portfolio-level excursion summary (avg MAE/MFE, capture ratio) over all journaled closes.
const excursion = excursionSummary(excursionTrades);
const fills = await recentFills();
// Deterministic 200-DMA regime — replaces the old static/LLM-vibe "regime" pill with the computed value
// (the same one the scan prompt + execute risk-off gate use). Fail-open: feed down → "Neutral".
const regime = await fetchSpyRegime();
const ready = readiness(m);
const mode = getMode();
const rules = rulesFor(getProfile());
const dayPnlPct = lastEquity > 0 ? round(((equity - lastEquity) / lastEquity) * 100, 2) : 0;
const alertObjs = computeAlerts({ dayPnlPct, monthPnlPct: m.monthPnlPct, drawdown: m.risk.drawdown, largestPos });
const alerts = alertObjs.map((a) => a.text); // full current set → status.json (dashboard banner shows live state)
const alertKeys = alertObjs.map((a) => a.key); // active alert types → next cycle de-dups against these
const botStatus = mode === "off" ? "Stopped" : mode === "auto" ? "Auto" : "Running";
const stamp = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";

const next = {
  ...prev,
  updated: stamp + " (live Alpaca PAPER)",
  isSample: false,
  profile: rules.name,
  mode,
  regime: regimePill(regime),
  regimeDetail: { ...regime, line: renderRegimeLine(regime) },
  equity: round(equity),
  cash: round(cash),
  buyingPower: round(num(acct.buying_power)),
  dayPnlUsd: round(equity - lastEquity),
  dayPnlPct,
  monthPnlPct: m.monthPnlPct,
  vsSpyPct: m.vsSpyPct,
  stats: m.stats,
  rolling: m.rolling,
  attribution: m.attribution,
  excursion,
  equityCurve: m.equityCurve,
  equityCurveSeries: m.equityCurveSeries,
  spyCurve: m.spyCurve,
  readiness: ready,
  proposals: m.proposals,
  positions,
  openOrders,
  fills,
  journal: journalEntries,
  signals: Array.isArray(prev.signals) ? prev.signals : [],
  movers: prev.movers ?? { gainers: [], losers: [], active: [] },
  tickers: prev.tickers ?? {},
  bot: { ...((prev.bot as Record<string, unknown>) ?? {}), status: botStatus, mode, profile: rules.name, lastRun: stamp },
  // No maxOpen / slot count here on purpose — position count is governed by heat + name + sector + cash.
  caps: { riskPerTrade: DEFAULT_RISK.riskPerTradePct, maxPosition: Math.round((rules.maxPositionPct ?? 0.4) * 100), sectorCap: DEFAULT_RISK.maxSectorPct, portfolioHeat: DEFAULT_RISK.maxPortfolioHeatPct, trailingStop: rules.trailPercent, dailyHalt: rules.dailyHaltPct, monthlyKill: rules.monthlyKillPct },
  risk: { drawdown: m.risk.drawdown, maxDD: m.risk.maxDD, peakEquity: m.risk.peakEquity, grossExposure, largestPos, heatUsedPct, sectorConc: 0 },
  alerts,
  alertKeys,
};

writeFileSync(STATUS, JSON.stringify(next, null, 2) + "\n");

// Post risk alerts to Discord — but only on TRANSITION into a state (per-key de-dup vs the previous cycle),
// so a persistent condition pings once, not every 5-min refresh. status.json.alerts still lists ALL active
// alerts for the dashboard; only newly-active ones reach #trade-bot.
const prevKeys = Array.isArray(prev.alertKeys) ? (prev.alertKeys as string[]) : [];
const freshAlerts = alertObjs.filter((a) => !prevKeys.includes(a.key));
if (freshAlerts.length) {
  try {
    await sendDiscord("🐂 **Bill the Bull — risk alert**\n" + freshAlerts.map((a) => a.text).join("\n"), { channel: "bull", username: "Bill the Bull" });
  } catch { /* notifier optional */ }
}

// Synthetic trailing-stop sweep (Bull v4): the protective stop for FRACTIONAL positions (Alpaca won't attach
// a broker stop to fractional qty). Peak-tracks every holding; market-sells any that fell trailPercent below
// its peak (auto mode + trading day). Runs each refresh tick (5-min during market hours).
try {
  const marketOpen = (await isMarketDayToday()).open;
  await runSyntheticStops({
    rawPositions,
    trailPct: rules.trailPercent ?? 20,
    mode,
    marketOpen,
    alert: (msg) => sendDiscord(msg, { channel: "bull", username: "Bill the Bull" }),
  });
} catch (e) { console.warn("[bill] synthetic-stop sweep failed:", String(e instanceof Error ? e.message : e)); }
console.log(
  JSON.stringify(
    {
      ok: true,
      isSample: false,
      equity: next.equity,
      cash: next.cash,
      buyingPower: next.buyingPower,
      positions: positions.length,
      openOrders: openOrders.length,
      book: positions.map((p) => `${p.t} ${p.qty}@$${p.price} (${p.unrealPct}% unreal)`),
    },
    null,
    2,
  ),
);
