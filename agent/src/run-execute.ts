// Bill's EXECUTION ritual — honors the off/gated/auto toggle.
//   off   → does nothing.
//   gated → proposes orders to #trade-bot for approval + writes memory/pending-orders.md; places NOTHING.
//   auto  → (only if BILL_ALLOW_AUTO_EXEC=1) validates + places PAPER orders with stops, journals, reports.
// The model only PROPOSES (emits JSON); placement + guardrail validation are deterministic, done here.
import "./load-env.js";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runAgent } from "./agent.js";
import { paperSnapshot, placePaperOrder, latestPrice, getPortfolioHistory, getBars, getTradableSymbols, type OrderRequest } from "./alpaca.js";
import { isTrustedTicker, normalizeTicker } from "./news-guard.js";
import { fetchSpyRegime, regimeBlockReason, ignoreRegime, renderRegimeLine } from "./regime.js";
import { validateOrders, rulesFor, haltReason, type BookState } from "./guardrails.js";
import { atrFromBars, atrStop, sizeByRisk, riskGate, DEFAULT_RISK, type OpenPosition } from "./risk-engine.js";
import { setPositionTrail, readPositionTrails } from "./synthetic-stops.js";
import { buildEquityCurve, type PortfolioHistory } from "./equity-curve.js";
import { getMode, autoExecAllowed } from "./mode.js";
import { getProfile } from "./profile.js";
import { appendProposals, readLedger } from "./ledger.js";
import { renderProposedSymbolHistory, tradedSymbolsIn, symbolRecord, renderSymbolRecordLine } from "./symbol-record.js";
import { isMarketDayToday, isPastHalfDayCloseET } from "./market-calendar.js";
import { installSafetyNet } from "./http-utils.js";

installSafetyNet("bill-execute");

const { sendDiscord } = await import("../../scripts/notify-discord.mjs" as string);

const APPROVED = fileURLToPath(new URL("../../Signals/approved-cycle.md", import.meta.url));
const PLAN = fileURLToPath(new URL("../../Signals/planned-orders.json", import.meta.url));
const PENDING = fileURLToPath(new URL("../../memory/pending-orders.md", import.meta.url));
const TRADELOG = fileURLToPath(new URL("../../memory/trade-log.md", import.meta.url));

const mode = getMode();
const dryRun = process.argv.includes("--dry-run") || process.env.BILL_DRY_RUN === "1";
const planOnly = process.argv.includes("--plan-only"); // 9:15 bill-brief: run the LLM propose + persist the plan; place NOTHING.
const fromPlan = process.argv.includes("--from-plan"); // 9:30 bill-open: load the 9:15 plan + skip the LLM so orders fire at the bell.
if (mode === "off" && !dryRun) {
  console.log(JSON.stringify({ ok: true, skipped: true, reason: "mode=off" }));
  process.exit(0);
}

// Market-day guard — premarket posts the closure notice, execute just bails silently.
if (!dryRun) {
  const marketCheck = await isMarketDayToday();
  if (!marketCheck.open) {
    console.log(JSON.stringify({ ok: true, skipped: true, reason: marketCheck.reason, via: marketCheck.via, date: marketCheck.date }));
    process.exit(0);
  }
  // Half-day handling. On NYSE 1pm-close days the market shuts at 13:00 ET, so the mid slot (12:30 ET)
  // is the LAST safe trade window. If we're already past 13:00 the market is closed — skip rather than
  // submit orders Alpaca will reject. Before close, proceed but flag to CJ that this is the last window.
  if (marketCheck.halfDay) {
    if (isPastHalfDayCloseET()) {
      console.warn(JSON.stringify({ ok: true, skipped: true, reason: "market closed (half-day)", date: marketCheck.date }));
      process.exit(0);
    }
    console.warn(`[bill] NYSE half-day (${marketCheck.date}) — 1pm ET close; this mid window is the LAST safe trade window.`);
    await sendDiscord(
      "⚠️ Bill — today is an NYSE half-day (1pm ET close). Mid trade window is the LAST.",
      { channel: "bull", username: "Bill the Bull" },
    );
  }
}

// NULL case — nothing approved to act on.
let approved = "";
try { approved = readFileSync(APPROVED, "utf8").trim(); } catch { /* file may not exist yet */ }
if (!approved) {
  console.log(JSON.stringify({ ok: true, skipped: true, reason: "no Signals/approved-cycle.md" }));
  process.exit(0);
}

const snap = await paperSnapshot();
const acct = (snap.account ?? {}) as Record<string, unknown>;
const equity = Number(acct.equity ?? 0);
const openCount = Array.isArray(snap.positions) ? snap.positions.length : 0;
const book: BookState = { equity, openCount };
const rules = rulesFor(getProfile());

// Per-symbol memory (advisory): Bill's own closed-trade record, read once — it seasons the live proposal
// prompt below AND annotates the gated proposal message, so a name that kept losing is flagged AT the
// decision point. History-not-edge framing lives in the block; it never hard-blocks a re-buy.
const ledgerTrades = readLedger();

// Deterministic 200-DMA market regime (SPY level + slope) — the dormant risk-engine regime filter, now
// live. Fetched once: it informs the proposal prompt AND drives the risk-off gate below. Fail-open
// (feed down → neutral → no blocking). BULL_IGNORE_REGIME=1 skips the gate for a deliberate play.
const regime = await fetchSpyRegime();

// ── HARD RISK HALT (Bull v3) ── enforce the daily-loss / monthly-kill / drawdown limits BEFORE proposing
// anything. They were descriptive-only before; now a bad day/month/drawdown actually stops NEW entries.
// Daily P&L is from the account (equity vs prior close); monthly + drawdown from portfolio history
// (best-effort — a fetch failure leaves those gates open, but the daily gate always fires).
// Skipped for --plan-only: at 9:15 the daily P&L is ~0 (market closed) and the 9:30 open run enforces
// the halt authoritatively before any placement — so planning is never gated and CJ gets one alert, not two.
if (!dryRun && !planOnly) {
  const lastEq = Number(acct.last_equity ?? 0);
  const dayPnlPct = lastEq > 0 ? ((equity - lastEq) / lastEq) * 100 : 0;
  let monthPnlPct: number | null = null;
  let drawdownFromPeakPct: number | null = null;
  try {
    const curve = buildEquityCurve((await getPortfolioHistory("1M", "1D")) as PortfolioHistory);
    if (curve.length) {
      const monthStart = curve[0].equity;
      const peak = Math.max(equity, ...curve.map((p) => p.equity));
      if (monthStart > 0) monthPnlPct = ((equity - monthStart) / monthStart) * 100;
      if (peak > 0) drawdownFromPeakPct = ((equity - peak) / peak) * 100;
    }
  } catch { /* portfolio-history fetch failed → leave monthly/drawdown null; daily halt still enforced */ }
  const halt = haltReason({ dayPnlPct, monthPnlPct, drawdownFromPeakPct }, rules);
  if (halt) {
    await sendDiscord(
      `🛑 **Bill — risk halt, NO new entries**\n${halt}\nEquity $${equity.toFixed(0)} · day ${dayPnlPct.toFixed(1)}%` +
        (monthPnlPct != null ? ` · MTD ${monthPnlPct.toFixed(1)}%` : "") +
        (drawdownFromPeakPct != null ? ` · DD ${drawdownFromPeakPct.toFixed(1)}%` : "") +
        `\n(Existing positions keep their trailing stops; only NEW buys are blocked.)`,
      { channel: "bull", username: "Bill the Bull" },
    );
    console.log(JSON.stringify({ ok: true, halted: true, reason: halt, equity, dayPnlPct, monthPnlPct, drawdownFromPeakPct }));
    process.exit(0);
  }
}

// ── obtain the proposed orders ──
let proposed: OrderRequest[] = [];
let costUsd = 0;
let usedPlan = false;

// FAST OPEN (--from-plan, the 9:30 bill-open run): load the orders the 9:15 brief pre-computed and SKIP
// the LLM call so buys submit within seconds of the bell. The plan fixes only the SELECTION — sizing,
// guardrails and the risk halt all still run live below against the real opening price. Falls back to a
// live proposal if the plan is missing or isn't from today (i.e. the 9:15 run failed).
if (fromPlan) {
  try {
    const plan = JSON.parse(readFileSync(PLAN, "utf8")) as { date?: string; orders?: OrderRequest[] };
    if (plan.date === new Date().toISOString().slice(0, 10) && Array.isArray(plan.orders)) {
      proposed = plan.orders;
      usedPlan = true;
      console.log(`[bill] --from-plan: loaded ${proposed.length} pre-computed order(s) from the 9:15 plan`);
    }
  } catch { /* missing / corrupt → fall through to a live proposal */ }
  if (!usedPlan) console.warn("[bill] --from-plan: planned-orders.json missing/stale → proposing live instead");
}

// Live proposal (plain execute, --plan-only, or the --from-plan fallback): the model converts the approved
// cycle into concrete orders. The model only PROPOSES — sizing + guardrail validation are deterministic, below.
if (!usedPlan) {
  // Per-symbol history for the names actually on the table: any approved-cycle symbol Bill has closed
  // trades on gets its record shown to the model before it proposes. "" when none match (fail open).
  const symbolHistory = renderProposedSymbolHistory(ledgerTrades, tradedSymbolsIn(ledgerTrades, approved));
  const prompt = `You are Bill the Bull, CJ's trading agent (paper account). Convert the APPROVED trade cycle below into concrete orders.
Rulebook limits (${rules.name}): max ${Math.round(rules.maxPositionPct * 100)}% per position, NO fixed position count — how many names fit is governed by the code's risk caps (risk/trade, per-name, sector, portfolio heat) + cash, price ≥ $${rules.minPrice}, a protective ~${rules.trailPercent}% trailing stop on EVERY buy (enforced in code). Current equity ≈ $${equity}, open positions ≈ ${openCount}.
COMPUTED MARKET REGIME (SPY vs 200-DMA, deterministic): ${renderRegimeLine(regime)}.${regime.state === "risk-off" ? ` Risk-off: the CODE will drop any NEW long whose setup is not explicitly tagged "counter-trend" — only propose longs you'd defend as counter-trend, or nothing.` : ""}
${symbolHistory ? symbolHistory + "\n" : ""}QUALITY UNIVERSE ONLY: liquid US large/mid-cap stocks + liquid non-leveraged ETFs. NEVER propose penny stocks (< $${rules.minPrice}), leveraged/inverse ETFs (SOXL/TQQQ/3x), crypto, meme/pump names, OR options/calls/puts/futures/derivatives — equities & ETFs only. Horizon 1 week–5 years; let winners run.
FRACTIONAL SIZING: positions are sized in FRACTIONAL shares from a ~$${equity} book, so ANY quality name is reachable regardless of share price (NVDA + other high-priced names included) — never skip a name for being "too expensive." Build a CONVICTION-TIERED book with NO fixed slot count: ~${rules.coreCount ?? 6} high-conviction CORE names you want the most capital in (confidence 70–95), plus optionally smaller SATELLITE names (confidence ~45–65) only if you genuinely like them — the risk engine's heat/name/sector/cash caps decide how many actually fit. Quality over quantity — a few strong names beats many mediocre ones; fine to pick fewer or none. Give an honest "confidence" (0–100) used to RANK ideas and decide which make the cut. You do NOT size positions: a deterministic risk engine sizes every buy itself from volatility + a fixed ~1% risk budget and caps it against portfolio limits.

APPROVED CYCLE:
${approved}

Output ONLY a JSON array (no prose, no markdown fence) of orders in this exact shape — include an HONEST "confidence" (0–100 conviction, drives the dollar size) and a short "setup" label (e.g. momentum breakout, mean-revert, earnings drift, counter-trend) on each:
[{"symbol":"NVDA","side":"buy","type":"market","est_price":900.0,"trail_percent":${rules.trailPercent},"thesis":"one line","confidence":82,"setup":"momentum breakout"}]
Use type "market"; est_price = your expected fill. The CODE sizes each position (fractional shares) from your confidence — do NOT compute qty yourself. If nothing qualifies, output [].`;

  const res = await runAgent(prompt);
  costUsd = res.costUsd;
  // Parse the model's proposal robustly: take the first JSON array in the output.
  try {
    const m = res.text.match(/\[[\s\S]*\]/);
    proposed = m ? (JSON.parse(m[0]) as OrderRequest[]) : [];
  } catch (e) {
    // Safety: if we can't parse structured orders, never place anything — fall back to a gated text proposal.
    await sendDiscord(`⚠️ Bill couldn't structure orders (parse error). Raw proposal:\n${res.text.slice(0, 1500)}`, { channel: "bull", username: "Bill the Bull" });
    console.error(JSON.stringify({ ok: false, parseError: String(e instanceof Error ? e.message : e), costUsd }));
    process.exit(1);
  }
}

// Options/derivative insurance (Bull v3): the schema is market/limit-only, but strip + log anything that
// isn't a plain equity order before sizing/placing — belt-and-suspenders to the guardrail type-check.
const dropped = proposed.filter((o) => o.type && !["market", "limit"].includes(o.type));
if (dropped.length) console.warn(`[bill] dropped ${dropped.length} non-equity order(s): ${dropped.map((o) => `${o.symbol}/${o.type}`).join(", ")}`);
proposed = proposed.filter((o) => !o.type || ["market", "limit"].includes(o.type));

// News-hardening (Bull v5): cross-check every proposed ticker against Alpaca's authoritative tradable set —
// drops hallucinated symbols + homoglyph-misrouted tickers from poisoned news. Fail-open (API down → skip).
const tradable = await getTradableSymbols();
const beforeGuard = proposed.length;
proposed = proposed.filter((o) => {
  if (isTrustedTicker(o.symbol, tradable)) { o.symbol = normalizeTicker(o.symbol); return true; }
  console.warn(`[bill] news-guard dropped untrusted ticker "${o.symbol}"`);
  return false;
});
if (proposed.length < beforeGuard) console.warn(`[bill] news-guard dropped ${beforeGuard - proposed.length} ticker(s) (not tradable / suspicious)`);

// 200-DMA REGIME GATE (deterministic): in a CONFIRMED risk-off regime (SPY below a falling 200-DMA),
// drop NEW long entries unless the setup is explicitly counter-trend-tagged. Sells/exits are never
// touched, sizing is untouched — this only filters which names may OPEN. BULL_IGNORE_REGIME=1 skips it.
// Runs on every path (live proposal, --plan-only, --from-plan) since it sits before the plan write.
const regimeBlocked: string[] = [];
proposed = proposed.filter((o) => {
  const reason = regimeBlockReason(o, regime, ignoreRegime());
  if (!reason) return true;
  regimeBlocked.push(o.symbol);
  console.warn(`[bill] regime gate dropped ${o.symbol}: ${reason}`);
  return false;
});
if (regimeBlocked.length && !dryRun && !planOnly) {
  await sendDiscord(
    `🛑 **Bill — regime gate (risk-off)**\nSPY $${regime.price} below falling 200-DMA $${regime.ma200} — blocked new long(s): ${regimeBlocked.join(", ")}\n(Counter-trend-tagged setups pass; BULL_IGNORE_REGIME=1 overrides. Existing positions + stops untouched.)`,
    { channel: "bull", username: "Bill the Bull" },
  );
}

// --plan-only (9:15 bill-brief): persist the proposal for the 9:30 open run, then STOP — no sizing, no
// validation, no placement. The open run (--from-plan) sizes on the live open price + enforces the risk
// halt and guardrails before placing. If the plan never lands, --from-plan proposes live as a fallback.
if (planOnly) {
  writeFileSync(PLAN, JSON.stringify({ date: new Date().toISOString().slice(0, 10), generatedAt: new Date().toISOString(), profile: getProfile(), mode, orders: proposed }, null, 2));
  console.log(JSON.stringify({ ok: true, planOnly: true, planned: proposed.length, wrote: "Signals/planned-orders.json", costUsd }, null, 2));
  process.exit(0);
}

// Ground every buy in the LIVE price and size deterministically (the model picks the name + stop + thesis;
// the CODE sizes it from the real price + risk formula). This kills mis-sizing from hallucinated prices.
const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const rcfg = DEFAULT_RISK;
// Live book for the portfolio-risk gate: each open position's ~open-risk ≈ its trail% × market value.
const trailsNow = readPositionTrails();
const openPositions: OpenPosition[] = (Array.isArray(snap.positions) ? snap.positions : []).map((p: any) => {
  const mv = Number(p.market_value ?? 0);
  const tr = (trailsNow[String(p.symbol ?? "").toUpperCase()] ?? (rules.trailPercent ?? 20)) / 100;
  return { symbol: String(p.symbol ?? ""), marketValue: mv, riskDollars: Math.max(0, mv * tr) };
});
// ── PHASE 1: the deterministic RISK ENGINE owns sizing + the portfolio override (the LLM only proposed the name).
// Per buy: ATR-based stop (vol-scaled) → risk-based size (1% of equity ÷ stop distance) → riskGate caps it vs the
// per-name / sector / portfolio-heat limits. The per-position trail% (= the stop distance) is persisted so the
// synthetic-stop monitor protects each name at its OWN level (not a flat 20%).
for (const o of proposed) {
  if (o.side !== "buy") continue;
  const live = await latestPrice(o.symbol);
  if (!live || live <= 0) { o.qty = 0; continue; }
  o.est_price = round(live);
  let atr = 0;
  try {
    const end = new Date(); const start = new Date(end.getTime() - 45 * 864e5);
    atr = atrFromBars(await getBars(o.symbol, start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)), rcfg.atrPeriod);
  } catch { /* no bars → 15% fallback stop below */ }
  const rawStop = atr > 0 ? atrStop(live, atr, rcfg) : live * 0.85;
  const stop = Math.min(rawStop, live * 0.97); // floor the stop at 3% so a too-tight stop can't blow up the size
  o.trail_percent = Math.min(35, Math.max(3, round(((live - stop) / live) * 100)));
  o.type = "market";
  o.fractional = !!rules.fractional;
  const sized = sizeByRisk(equity, live, stop, rcfg);
  const gated = riskGate({ symbol: o.symbol, sector: (o as { sector?: string }).sector, price: live, stopPrice: stop, shares: sized }, { equity, positions: openPositions }, rcfg);
  o.qty = gated.shares;
  if (gated.reasons.length) console.log(`[bill] ${o.symbol}: ${sized}→${gated.shares} sh @ trail ${o.trail_percent}% (${gated.reasons.join("; ")})`);
  if (gated.ok) openPositions.push({ symbol: o.symbol, marketValue: gated.shares * live, riskDollars: gated.shares * (live - stop) });
}

const checked = validateOrders(proposed, book, rules);
const valid = checked.filter((c) => c.ok).map((c) => c.order);
const rejected = checked.filter((c) => !c.ok);

const fmt = (o: OrderRequest) => `• ${o.side.toUpperCase()} ${o.qty} ${o.symbol} @ ${o.type}${o.limit_price ? " " + o.limit_price : ""} (stop ${o.trail_percent ?? "—"}%${o.confidence != null ? `, conf ${o.confidence}` : ""}${o.setup ? `, ${o.setup}` : ""}) — ${o.thesis ?? ""}`;

// Dry-run (Bull v2 #10): rehearse only — show proposals, write NOTHING (no ledger, no Discord, no orders).
if (dryRun) {
  console.log(JSON.stringify({ ok: true, dryRun: true, profile: rules.name, mode, proposed: valid.length, rejected: rejected.length, orders: valid.map(fmt), rejectedReasons: rejected.map((r) => `${r.order.symbol}: ${r.reasons.join("; ")}`), costUsd }, null, 2));
  process.exit(0);
}

// Keystone (Bull v2 #1): record every proposal — valid + rejected — to the ledger for later
// outcome reconciliation. This is the memory that stats / journal / confidence / readiness gate read.
appendProposals(checked.map((c) => ({
  ts: new Date().toISOString(),
  cycle: new Date().toISOString().slice(0, 10),
  symbol: c.order.symbol,
  side: c.order.side,
  qty: c.order.qty,
  est_price: c.order.est_price,
  trail_percent: c.order.trail_percent ?? null,
  thesis: c.order.thesis,
  profile: getProfile(),
  mode,
  status: c.ok ? "proposed" : "rejected",
  reasons: c.reasons,
  confidence: c.order.confidence ?? null,
  setup: c.order.setup ?? null,
  outcome: "open",
})));

// gated, OR auto-without-the-env-opt-in → PROPOSE only.
if (mode === "gated" || !autoExecAllowed()) {
  const note = mode === "auto" ? " (mode=auto but BILL_ALLOW_AUTO_EXEC not set → proposing, not placing)" : "";
  // Per-symbol memory on the proposal itself (covers --from-plan too, where the LLM prompt is skipped):
  // any proposed name Bill has closed trades on gets its record shown at the approval point. Advisory only.
  const histLines = valid
    .map((o) => symbolRecord(ledgerTrades, o.symbol))
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .map((r) => `  📜 ${renderSymbolRecordLine(r)}`);
  const body = [
    `🐂 **Bill the Bull — proposed orders · ${rules.name}**${note}`,
    valid.length ? valid.map(fmt).join("\n") : "（none passed guardrails）",
    histLines.length ? `\nBill's history on these names (small sample — advisory):\n${histLines.join("\n")}` : "",
    rejected.length ? `\nRejected: ${rejected.map((r) => `${r.order.symbol} [${r.reasons.join("; ")}]`).join(" · ")}` : "",
    `\nReply 👍 to approve, or set mode=auto (+ BILL_ALLOW_AUTO_EXEC=1) to let Bill place these.`,
  ].join("\n");
  await sendDiscord(body.slice(0, 1990), { channel: "bull", username: "Bill the Bull" });
  writeFileSync(PENDING, `# Pending paper orders — ${new Date().toISOString()}\n\n` + valid.map(fmt).join("\n") + "\n");
  console.log(JSON.stringify({ ok: true, mode, proposed: valid.length, rejected: rejected.length, placed: 0, costUsd }, null, 2));
  process.exit(0);
}

// auto + opt-in → PLACE paper orders. placePaperOrder waits for the buy to fill before placing the
// protective trailing stop (Alpaca rejects a sell while the matching buy is still open). If the buy
// fills but the stop is skipped (timeout / non-filled terminal status), we surface stopSkippedReason
// in the Discord wrap so CJ sees the unprotected position immediately.
// CONCURRENT placement: every buy is submitted at once so they all hit within a second of the open.
// The old sequential loop made each order wait up to 45s for its own fill before the next buy was even
// submitted — so a 3-order day didn't fully fill until ~90s past the open, missing the opening move.
// Orders are independent (distinct symbols, idempotency-keyed), and each order's protective trailing
// stop still attaches inside placePaperOrder once its own buy fills.
const results: Array<{ symbol: string; ok: boolean; error?: string; stopSkippedReason?: string }> =
  await Promise.all(valid.map(async (o) => {
    try {
      const r = await placePaperOrder(o);
      setPositionTrail(o.symbol, o.trail_percent ?? rules.trailPercent ?? 20); // persist this name's ATR trail for the synthetic-stop monitor
      const stopNote = !r.stopSkippedReason
        ? ` stop ${o.trail_percent}%`
        : /synthetic|fractional/i.test(r.stopSkippedReason) ? ` (protected by synthetic stop)` : ` (⚠️ stop SKIPPED: ${r.stopSkippedReason})`;
      appendFileSync(TRADELOG, `- ${new Date().toISOString()} PLACED ${o.side} ${o.qty} ${o.symbol} @ ${o.type}${stopNote} — ${o.thesis ?? ""}\n`);
      return { symbol: o.symbol, ok: true, stopSkippedReason: r.stopSkippedReason };
    } catch (e) {
      return { symbol: o.symbol, ok: false, error: String(e instanceof Error ? e.message : e) };
    }
  }));
const placed = results.filter((r) => r.ok);
// "Unprotected" = a buy whose BROKER stop was genuinely skipped (fill timeout / non-fill) on a WHOLE-share
// order. Fractional buys carry "…protected by the synthetic trailing stop" — they ARE protected (the refresh
// sweep), so never flag them as unprotected or suggest backfill-stops (which can't even run on fractional).
const isSynthetic = (reason?: string) => !!reason && /synthetic|fractional/i.test(reason);
const unprotected = placed.filter((r) => r.stopSkippedReason && !isSynthetic(r.stopSkippedReason));
// Per-buy line: bought-at + the protective stop level (entry × (1−trail)), so CJ sees in/stop at a glance.
const ordBySym = new Map(valid.map((o) => [o.symbol, o]));
const px = (n: number) => (n >= 100 ? n.toFixed(0) : n.toFixed(2));
const placedLines = placed.map((r) => {
  const o = ordBySym.get(r.symbol);
  const prot = !(r.stopSkippedReason && !isSynthetic(r.stopSkippedReason));
  const at = o ? ` @ $${px(o.est_price)}` : "";
  const stop = o && o.trail_percent ? ` · stop ~$${px(o.est_price * (1 - o.trail_percent / 100))}` : "";
  return `${prot ? "✅" : "⚠️"} ${r.symbol}${at}${stop}`;
});
await sendDiscord(
  `🐂 **Bill the Bull — orders placed (auto · ${rules.name})**\n${placedLines.join("\n") || "none"}` +
    (unprotected.length ? `\n⚠️ UNPROTECTED — whole-share stop skipped (run \`npm run backfill-stops\`): ${unprotected.map((r) => r.symbol).join(", ")}` : "") +
    (results.some((r) => !r.ok) ? `\n❌ ${results.filter((r) => !r.ok).map((r) => `${r.symbol}: ${r.error}`).join("; ")}` : ""),
  { channel: "bull", username: "Bill the Bull" }
);
console.log(JSON.stringify({ ok: true, mode, placed: placed.length, unprotected: unprotected.length, failed: results.length - placed.length, rejected: rejected.length, costUsd }, null, 2));
