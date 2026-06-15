// Bill's EXECUTION ritual — honors the off/gated/auto toggle.
//   off   → does nothing.
//   gated → proposes orders to #trade-bot for approval + writes memory/pending-orders.md; places NOTHING.
//   auto  → (only if BILL_ALLOW_AUTO_EXEC=1) validates + places PAPER orders with stops, journals, reports.
// The model only PROPOSES (emits JSON); placement + guardrail validation are deterministic, done here.
import "./load-env.js";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runAgent } from "./agent.js";
import { paperSnapshot, placePaperOrder, latestPrice, type OrderRequest } from "./alpaca.js";
import { validateOrders, rulesFor, type BookState } from "./guardrails.js";
import { getMode, autoExecAllowed } from "./mode.js";
import { getProfile } from "./profile.js";
import { appendProposals } from "./ledger.js";
import { isMarketDayToday } from "./market-calendar.js";

const { sendDiscord } = await import("../../scripts/notify-discord.mjs" as string);

const APPROVED = fileURLToPath(new URL("../../Signals/approved-cycle.md", import.meta.url));
const PENDING = fileURLToPath(new URL("../../memory/pending-orders.md", import.meta.url));
const TRADELOG = fileURLToPath(new URL("../../memory/trade-log.md", import.meta.url));

const mode = getMode();
const dryRun = process.argv.includes("--dry-run") || process.env.BILL_DRY_RUN === "1";
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

const prompt = `You are Bill the Bull, CJ's trading agent (paper account). Convert the APPROVED trade cycle below into concrete orders.
Rulebook limits (${rules.name}): risk ~${rules.riskPerTradePct}% equity/trade, max ${Math.round(rules.maxPositionPct * 100)}% per position, max ${rules.maxOpen} open, price ≥ $${rules.minPrice}, a protective trailing stop (~${rules.trailPercent}%) on EVERY buy. Current equity ≈ $${equity}, open positions ≈ ${openCount}.
QUALITY UNIVERSE ONLY: liquid US large/mid-cap stocks + liquid non-leveraged ETFs. NEVER propose penny stocks (< $${rules.minPrice}), leveraged/inverse ETFs (SOXL/TQQQ/3x), crypto, or meme/pump names. Horizon 1 week–5 years; let winners run.

APPROVED CYCLE:
${approved}

Output ONLY a JSON array (no prose, no markdown fence) of orders in this exact shape — include a "confidence" (0–100 conviction) and a short "setup" label (e.g. momentum breakout, mean-revert, earnings drift) on each:
[{"symbol":"AAPL","side":"buy","qty":10,"type":"limit","limit_price":195.0,"est_price":195.0,"trail_percent":${rules.trailPercent},"thesis":"one line","confidence":72,"setup":"momentum breakout"}]
Use "market" type only when you intend a market order (still include est_price = your expected fill). Size per the risk formula and the caps. If nothing qualifies, output [].`;

const { text, costUsd } = await runAgent(prompt);

// Parse the model's proposal robustly: take the first JSON array in the output.
let proposed: OrderRequest[] = [];
let parseError = "";
try {
  const m = text.match(/\[[\s\S]*\]/);
  proposed = m ? (JSON.parse(m[0]) as OrderRequest[]) : [];
} catch (e) {
  parseError = String(e instanceof Error ? e.message : e);
}

if (parseError) {
  // Safety: if we can't parse structured orders, never place anything — fall back to a gated text proposal.
  await sendDiscord(`⚠️ Bill couldn't structure orders (parse error). Raw proposal:\n${text.slice(0, 1500)}`, { channel: "bull", username: "Bill the Bull" });
  console.error(JSON.stringify({ ok: false, parseError, costUsd }));
  process.exit(1);
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
const results: Array<{ symbol: string; ok: boolean; error?: string; stopSkippedReason?: string }> = [];
for (const o of valid) {
  try {
    const r = await placePaperOrder(o);
    results.push({ symbol: o.symbol, ok: true, stopSkippedReason: r.stopSkippedReason });
    const stopNote = r.stopSkippedReason ? ` (stop SKIPPED: ${r.stopSkippedReason})` : ` stop ${o.trail_percent}%`;
    appendFileSync(TRADELOG, `- ${new Date().toISOString()} PLACED ${o.side} ${o.qty} ${o.symbol} @ ${o.type}${stopNote} — ${o.thesis ?? ""}\n`);
  } catch (e) {
    results.push({ symbol: o.symbol, ok: false, error: String(e instanceof Error ? e.message : e) });
  }
}
const placed = results.filter((r) => r.ok);
const unprotected = placed.filter((r) => r.stopSkippedReason);
await sendDiscord(
  `🐂 **Bill the Bull — orders placed (auto · ${rules.name})**\n${placed.map((r) => (r.stopSkippedReason ? "⚠️ " : "✅ ") + r.symbol).join("  ") || "none"}` +
    (unprotected.length ? `\n⚠️ UNPROTECTED (run \`npm run backfill-stops\` to add trailing stops): ${unprotected.map((r) => r.symbol).join(", ")}` : "") +
    (results.some((r) => !r.ok) ? `\n❌ ${results.filter((r) => !r.ok).map((r) => `${r.symbol}: ${r.error}`).join("; ")}` : ""),
  { channel: "bull", username: "Bill the Bull" }
);
console.log(JSON.stringify({ ok: true, mode, placed: placed.length, unprotected: unprotected.length, failed: results.length - placed.length, rejected: rejected.length, costUsd }, null, 2));
