// Bill's EXECUTION ritual — honors the off/gated/auto toggle.
//   off   → does nothing.
//   gated → proposes orders to #trade-bot for approval + writes memory/pending-orders.md; places NOTHING.
//   auto  → (only if BILL_ALLOW_AUTO_EXEC=1) validates + places PAPER orders with stops, journals, reports.
// The model only PROPOSES (emits JSON); placement + guardrail validation are deterministic, done here.
import "./load-env.js";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runAgent } from "./agent.js";
import { paperSnapshot, placePaperOrder, latestPrice, getPortfolioHistory, type OrderRequest } from "./alpaca.js";
import { validateOrders, rulesFor, haltReason, type BookState } from "./guardrails.js";
import { buildEquityCurve, type PortfolioHistory } from "./equity-curve.js";
import { getMode, autoExecAllowed } from "./mode.js";
import { getProfile } from "./profile.js";
import { appendProposals } from "./ledger.js";
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
  const prompt = `You are Bill the Bull, CJ's trading agent (paper account). Convert the APPROVED trade cycle below into concrete orders.
Rulebook limits (${rules.name}): risk ~${rules.riskPerTradePct}% equity/trade, max ${Math.round(rules.maxPositionPct * 100)}% per position, max ${rules.maxOpen} open, price ≥ $${rules.minPrice}, a protective trailing stop (~${rules.trailPercent}%) on EVERY buy. Current equity ≈ $${equity}, open positions ≈ ${openCount}.
QUALITY UNIVERSE ONLY: liquid US large/mid-cap stocks + liquid non-leveraged ETFs. NEVER propose penny stocks (< $${rules.minPrice}), leveraged/inverse ETFs (SOXL/TQQQ/3x), crypto, meme/pump names, OR options/calls/puts/futures/derivatives — equities & ETFs only. Horizon 1 week–5 years; let winners run.
ACCOUNT SIZE ≈ $${equity}: positions are WHOLE shares (no fractional), so only propose names where ≥1 share fits the ${Math.round(rules.maxPositionPct * 100)}% cap (≈ $${Math.round(rules.maxPositionPct * equity)}). On a small account favor liquid quality names + sector ETFs priced below that so a real position + protective stop is possible; skip names too expensive to size.

APPROVED CYCLE:
${approved}

Output ONLY a JSON array (no prose, no markdown fence) of orders in this exact shape — include a "confidence" (0–100 conviction) and a short "setup" label (e.g. momentum breakout, mean-revert, earnings drift) on each:
[{"symbol":"AAPL","side":"buy","qty":10,"type":"limit","limit_price":195.0,"est_price":195.0,"trail_percent":${rules.trailPercent},"thesis":"one line","confidence":72,"setup":"momentum breakout"}]
Use "market" type only when you intend a market order (still include est_price = your expected fill). Size per the risk formula and the caps. If nothing qualifies, output [].`;

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
const trailPct = (rules.trailPercent ?? 20) / 100;
const riskPct = (rules.riskPerTradePct ?? 7) / 100;
for (const o of proposed) {
  if (o.side !== "buy") continue;
  const live = await latestPrice(o.symbol);
  if (live && live > 0) {
    o.est_price = round(live);
    const riskShares = trailPct > 0 ? (riskPct * equity) / (live * trailPct) : 0;
    const capShares = (rules.maxPositionPct * equity) / live;
    o.qty = Math.max(0, Math.floor(Math.min(riskShares, capShares)));
    if (o.type === "limit") o.limit_price = round(live * 1.01); // near-market, not a hallucinated limit
  }
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
  const body = [
    `🐂 **Bill the Bull — proposed orders · ${rules.name}**${note}`,
    valid.length ? valid.map(fmt).join("\n") : "（none passed guardrails）",
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
      const stopNote = r.stopSkippedReason ? ` (stop SKIPPED: ${r.stopSkippedReason})` : ` stop ${o.trail_percent}%`;
      appendFileSync(TRADELOG, `- ${new Date().toISOString()} PLACED ${o.side} ${o.qty} ${o.symbol} @ ${o.type}${stopNote} — ${o.thesis ?? ""}\n`);
      return { symbol: o.symbol, ok: true, stopSkippedReason: r.stopSkippedReason };
    } catch (e) {
      return { symbol: o.symbol, ok: false, error: String(e instanceof Error ? e.message : e) };
    }
  }));
const placed = results.filter((r) => r.ok);
const unprotected = placed.filter((r) => r.stopSkippedReason);
await sendDiscord(
  `🐂 **Bill the Bull — orders placed (auto · ${rules.name})**\n${placed.map((r) => (r.stopSkippedReason ? "⚠️ " : "✅ ") + r.symbol).join("  ") || "none"}` +
    (unprotected.length ? `\n⚠️ UNPROTECTED (run \`npm run backfill-stops\` to add trailing stops): ${unprotected.map((r) => r.symbol).join(", ")}` : "") +
    (results.some((r) => !r.ok) ? `\n❌ ${results.filter((r) => !r.ok).map((r) => `${r.symbol}: ${r.error}`).join("; ")}` : ""),
  { channel: "bull", username: "Bill the Bull" }
);
console.log(JSON.stringify({ ok: true, mode, placed: placed.length, unprotected: unprotected.length, failed: results.length - placed.length, rejected: rejected.length, costUsd }, null, 2));
