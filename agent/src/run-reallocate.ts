// Bill's REALLOCATION ritual — the intraday "cut the laggard, fund a better idea" loop.
//   Advisory (default, `npm run reallocate`): reads the book + candidate ideas (from a file/CLI arg),
//     prints/posts a swap plan, places NOTHING. Back-compatible.
//   --execute (`npm run reallocate:auto`, the hourly bill-realloc timer): RE-RESEARCHES the morning
//     watchlist with CURRENT data (web search) → fresh candidates re-scored on today's price/news (a
//     played-out catalyst gets downgraded), plans swaps, and ACTS per the off/gated/auto toggle:
//       off   → nothing.
//       gated → DM the proposed swap to #trade-bot; place nothing.
//       auto (+ BILL_ALLOW_AUTO_EXEC=1) → SELL the weak holding (cancels its stop + liquidates), then
//              size + BUY the better idea with a fresh protective trailing stop. The risk halt gates the
//              buy leg (a bad day/month/drawdown freezes the book — existing stops still protect it).
// Paper-only (alpaca.ts hard-guards the paper host); every buy still runs through validateOrders. The swap
// planner (reallocate.ts) stays propose-only + pure — placement is double-gated here, just like run-execute.
import "./load-env.js";
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { paperSnapshot, placePaperOrder, latestPrice, closePosition, waitForOrderTerminal, getAccount, getPortfolioHistory, type OrderRequest } from "./alpaca.js";
import { rulesFor, validateOrders, haltReason, sizeBuyQty } from "./guardrails.js";
import { getProfile } from "./profile.js";
import { getMode, autoExecAllowed } from "./mode.js";
import { readLedger, appendProposals } from "./ledger.js";
import { planReallocation, type Holding, type Candidate } from "./reallocate.js";
import { rankHoldings, formatRankingLines, holdingAgesDays } from "./run-rank.js";
import { runAgent } from "./agent.js";
import { buildEquityCurve, type PortfolioHistory } from "./equity-curve.js";
import { installSafetyNet } from "./http-utils.js";

installSafetyNet("bill-reallocate");

const { sendDiscord } = await import("../../scripts/notify-discord.mjs" as string);

const CANDIDATES_FILE = fileURLToPath(new URL("../../Signals/realloc-candidates.json", import.meta.url));
const APPROVED = fileURLToPath(new URL("../../Signals/approved-cycle.md", import.meta.url));
const PENDING = fileURLToPath(new URL("../../memory/pending-reallocation.md", import.meta.url));
const TRADELOG = fileURLToPath(new URL("../../memory/trade-log.md", import.meta.url));

const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const execute = process.argv.includes("--execute");
const mode = getMode();
if (mode === "off") {
  console.log(JSON.stringify({ ok: true, skipped: true, reason: "mode=off" }));
  process.exit(0);
}

// Explicit candidates win (file or `--candidates '<json>'`). Else, in --execute mode, we generate them.
function loadFileCandidates(): Candidate[] {
  const argIdx = process.argv.indexOf("--candidates");
  const raw = argIdx >= 0 ? process.argv[argIdx + 1] : (existsSync(CANDIDATES_FILE) ? readFileSync(CANDIDATES_FILE, "utf8") : "");
  if (!raw || !raw.trim()) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((c) => c && typeof c.symbol === "string" && Number.isFinite(Number(c.conviction)))
      .map((c) => ({ symbol: String(c.symbol).toUpperCase(), conviction: Number(c.conviction), thesis: c.thesis, setup: c.setup }));
  } catch { return []; }
}

const snap = await paperSnapshot();
if (!snap.connected) {
  console.error(JSON.stringify({ ok: false, reason: "Alpaca not reachable (keys/endpoint)", error: snap.error }));
  process.exit(1);
}

const acct = (snap.account ?? {}) as Record<string, unknown>;
const equity = Number(acct.equity ?? 0);
const positions = (Array.isArray(snap.positions) ? snap.positions : []) as Array<Record<string, unknown>>;
const ledger = readLedger();
const rules = rulesFor(getProfile());

// A holding's strength = the conviction of its most recent ledger proposal (planner falls back to a
// P&L-derived proxy when a position has no ledger record).
const lastConfidence = (sym: string): number | undefined => {
  for (let i = ledger.length - 1; i >= 0; i--) {
    const r = ledger[i];
    if (r.symbol === sym && typeof r.confidence === "number") return r.confidence;
  }
  return undefined;
};

const holdings: Holding[] = positions.map((p) => ({
  symbol: String(p.symbol),
  marketValue: Number(p.market_value ?? 0),
  unrealizedPlPct: Number(p.unrealized_plpc ?? 0),
  score: lastConfidence(String(p.symbol)),
}));

// FRESH intraday RE-RESEARCH (the core of CJ's ask): each rotation re-validates this morning's watchlist
// with CURRENT data via web search — confirming names are still good to own RIGHT NOW, downgrading any whose
// catalyst already PLAYED OUT (already ran on the news / popped past the entry → less upside left, rotate
// elsewhere), and surfacing fresh movers. The morning convictions are NOT trusted as-is; the model re-scores
// from today's price action + news. Only used in --execute when no explicit file/CLI candidates are supplied.
async function generateCandidates(): Promise<{ candidates: Candidate[]; costUsd: number }> {
  let watchlist = "";
  try { watchlist = readFileSync(APPROVED, "utf8").trim(); } catch { /* may not exist */ }
  const cap = Math.round(rules.maxPositionPct * equity);
  const bookLines = holdings.length
    ? holdings.map((h) => `  • ${h.symbol}: ${(h.unrealizedPlPct * 100).toFixed(1)}% unreal, $${h.marketValue.toFixed(0)}${typeof h.score === "number" ? `, conv@entry ${h.score}` : ""}`).join("\n")
    : "  (no open positions)";
  const prompt = `You are Bill the Bull (paper account) running an INTRADAY rotation check — deciding whether to swap a weak holding for a better idea RIGHT NOW. Quality over churn.

RE-RESEARCH WITH CURRENT DATA — do NOT trust this morning's view. USE WEB SEARCH to check, as of right now: today's price action + intraday move, any news/catalyst since the open, and the market regime (risk-on/off). A name whose catalyst has already PLAYED OUT (already ran on the news, or popped through its entry zone) has less upside left → downgrade it or drop it in favor of a name still setting up. Also surface fresh movers that weren't on the morning list.

This morning's watchlist (names to RE-VALIDATE from today's data — re-score them, do NOT copy the morning convictions):
${watchlist || "(none — research the market fresh)"}

Current book (equity ≈ $${equity.toFixed(0)}, ${holdings.length}/${rules.maxOpen} slots):
${bookLines}

Propose the TOP 2–3 BEST ideas to rotate INTO right now — names NOT already held. Quality US large/mid-cap stocks + liquid non-leveraged ETFs only; price ≥ $${rules.minPrice}; sized in FRACTIONAL shares so any price is reachable (NVDA-class included; per-name cap ${Math.round(rules.maxPositionPct * 100)}%); NO penny / leveraged / inverse / crypto / options.
Give an HONEST 0–100 conviction reflecting TODAY's setup (only an idea beating a holding's strength by ≥15 points triggers a swap, so do NOT inflate). One-line thesis grounded in CURRENT data + a short setup label.
Output ONLY a JSON array (no prose / no fence): [{"symbol":"NVDA","conviction":85,"thesis":"… (current)","setup":"momentum breakout"}]. If nothing clearly beats the current book today, output [].`;
  try {
    const res = await runAgent(prompt);
    const m = res.text.match(/\[[\s\S]*\]/);
    const arr = m ? JSON.parse(m[0]) : [];
    const candidates: Candidate[] = Array.isArray(arr)
      ? arr
          .filter((c: any) => c && typeof c.symbol === "string" && Number.isFinite(Number(c.conviction)))
          .map((c: any) => ({ symbol: String(c.symbol).toUpperCase(), conviction: Number(c.conviction), thesis: c.thesis, setup: c.setup }))
      : [];
    return { candidates, costUsd: res.costUsd };
  } catch { return { candidates: [], costUsd: 0 }; }
}

let candidates = loadFileCandidates();
let genCostUsd = 0;
if (execute && candidates.length === 0) {
  const g = await generateCandidates();
  candidates = g.candidates;
  genCostUsd = g.costUsd;
}

const plan = planReallocation(holdings, candidates, { maxOpen: rules.maxOpen });

const swapLine = (s: typeof plan.swaps[number]) =>
  `  ↪ SELL ${s.sell.symbol} (strength ${s.sell.score}) → BUY ${s.buy.symbol} (conv ${s.buy.conviction}, +${s.edge} edge)${s.buy.setup ? ` · ${s.buy.setup}` : ""}`;
const planBody = [
  `🔁 **Bill the Bull — reallocation${execute ? "" : " (advisory)"} · ${rules.name}**`,
  ...plan.notes.map((n) => `• ${n}`),
  ...(plan.swaps.length ? ["", "**Proposed swaps:**", ...plan.swaps.map(swapLine)] : []),
].join("\n");
writeFileSync(PENDING, `# Reallocation — ${new Date().toISOString()}\n\n${planBody}\n`);

// ── ADVISORY (no --execute), OR gated / no opt-in → PROPOSE ONLY (place nothing) ──
const willPlace = execute && mode === "auto" && autoExecAllowed();
if (!willPlace) {
  if (plan.swaps.length) await sendDiscord(planBody.slice(0, 1990), { channel: "bull", username: "Bill the Bull" });
  console.log(JSON.stringify({ ok: true, mode, execute, placed: 0, proposedSwaps: plan.swaps.length, candidates: candidates.length, notes: plan.notes, costUsd: genCostUsd }, null, 2));
  process.exit(0);
}

// ── AUTO-EXECUTE ── First build the holding RANKING (CJ wants to SEE how every name ranks + why it's
// kept) — posted to #trade-bot each pass alongside the decision. Then act. Risk halt gates the BUY side:
// a bad day/month/drawdown means stand down → skip rotation (don't sell-without-rebuy; a halt freezes the
// book, stops still protect it).
const ages = await holdingAgesDays(holdings.map((h) => h.symbol));
const rankingLines = formatRankingLines(rankHoldings(holdings, ages), rules);

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
} catch { /* leave null — the daily gate still fires */ }
const halt = haltReason({ dayPnlPct, monthPnlPct, drawdownFromPeakPct }, rules);
if (halt) {
  await sendDiscord([...rankingLines, "", `⏸️ Rotation skipped — risk halt: ${halt}. (Existing trailing stops still protect the book.)`].join("\n").slice(0, 1990), { channel: "bull", username: "Bill the Bull" });
  console.log(JSON.stringify({ ok: true, mode, skippedReason: `risk halt: ${halt}`, proposedSwaps: plan.swaps.length, costUsd: genCostUsd }));
  process.exit(0);
}
if (plan.swaps.length === 0) {
  await sendDiscord([...rankingLines, "", "✅ No swap — held the book (no fresh idea beat the weakest by ≥15 conviction today)."].join("\n").slice(0, 1990), { channel: "bull", username: "Bill the Bull" });
  console.log(JSON.stringify({ ok: true, mode, placed: 0, proposedSwaps: 0, candidates: candidates.length, notes: plan.notes, costUsd: genCostUsd }, null, 2));
  process.exit(0);
}

type SwapResult = { sell: string; buy: string; ok: boolean; soldOnly?: boolean; error?: string; stopSkippedReason?: string };
const results: SwapResult[] = [];
for (const s of plan.swaps) {
  try {
    // SELL leg: liquidate the laggard at market (cancels its protective stop first → no orphan stop).
    const sell = await closePosition(s.sell.symbol);
    if (sell.order?.id) await waitForOrderTerminal(String(sell.order.id), { timeoutMs: 45_000, intervalMs: 1_000 });
    appendFileSync(TRADELOG, `- ${new Date().toISOString()} ROTATE-SELL ${s.sell.symbol} (liquidated${sell.alreadyFlat ? " — already flat" : ""}, ${sell.canceledStops} stop(s) canceled) → fund ${s.buy.symbol}\n`);

    // BUY leg: size on the LIVE price, capped by the buying power freed by the sell; validate; place + stop.
    const live = await latestPrice(s.buy.symbol);
    if (!live || live <= 0) { results.push({ sell: s.sell.symbol, buy: s.buy.symbol, ok: false, soldOnly: true, error: "no live price for buy" }); continue; }
    let bp = equity;
    try { const a = (await getAccount()) as Record<string, unknown>; bp = Number(a.buying_power ?? a.cash ?? equity); } catch { /* fall back to equity ceiling */ }
    let qty = sizeBuyQty(live, equity, rules, s.buy.conviction);
    if (bp > 0) { const affordable = rules.fractional ? Math.round((bp / live) * 1e4) / 1e4 : Math.floor(bp / live); qty = Math.min(qty, affordable); }
    const buy: OrderRequest = { symbol: s.buy.symbol, side: "buy", qty, type: "market", est_price: round(live), trail_percent: rules.trailPercent, thesis: s.buy.thesis, confidence: s.buy.conviction, setup: s.buy.setup, fractional: !!rules.fractional };
    // Validate with the sold slot freed (openCount − 1) so the swap never trips the maxOpen cap.
    const checked = validateOrders([buy], { equity, openCount: Math.max(0, holdings.length - 1) }, rules)[0];
    if (!checked.ok) { results.push({ sell: s.sell.symbol, buy: s.buy.symbol, ok: false, soldOnly: true, error: `buy rejected: ${checked.reasons.join("; ")}` }); continue; }

    appendProposals([{
      ts: new Date().toISOString(), cycle: new Date().toISOString().slice(0, 10),
      symbol: buy.symbol, side: "buy", qty: buy.qty, est_price: buy.est_price, trail_percent: buy.trail_percent ?? null,
      thesis: buy.thesis, profile: getProfile(), mode, status: "proposed",
      reasons: [`rotation: swapped from ${s.sell.symbol} (+${s.edge} conviction edge)`],
      confidence: buy.confidence ?? null, setup: buy.setup ?? null, outcome: "open",
    }]);
    const r = await placePaperOrder(buy);
    appendFileSync(TRADELOG, `- ${new Date().toISOString()} ROTATE-BUY ${buy.qty} ${buy.symbol} @ market${r.stopSkippedReason ? ` (stop SKIPPED: ${r.stopSkippedReason})` : ` stop ${buy.trail_percent}%`} — ${buy.thesis ?? ""}\n`);
    results.push({ sell: s.sell.symbol, buy: s.buy.symbol, ok: true, stopSkippedReason: r.stopSkippedReason });
  } catch (e) {
    results.push({ sell: s.sell.symbol, buy: s.buy.symbol, ok: false, error: String(e instanceof Error ? e.message : e) });
  }
}

const done = results.filter((r) => r.ok);
const body = [
  ...rankingLines,
  "",
  `🔁 **Rotated ${done.length}/${results.length} (auto · ${rules.name})**`,
  ...results.map((r) =>
    r.ok
      ? `  ✅ SELL ${r.sell} → BUY ${r.buy}${r.stopSkippedReason ? " ⚠️ stop pending (reconcile)" : ""}`
      : `  ⚠️ ${r.sell}→${r.buy} — ${r.soldOnly ? "SOLD but buy failed" : "failed"}: ${r.error}`,
  ),
].join("\n");
await sendDiscord(body.slice(0, 1990), { channel: "bull", username: "Bill the Bull" });
console.log(JSON.stringify({ ok: true, mode, placed: done.length, swaps: results, costUsd: genCostUsd }, null, 2));
