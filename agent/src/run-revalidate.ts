// Bill's THESIS RE-VALIDATION ritual — the periodic "does the reason I own this still exist?" pass.
// Open positions already get MECHANICAL review (synthetic stops, rank/reallocate, profit-trim); this adds
// the missing JUDGMENT layer: for each open position, re-check the ORIGINAL entry thesis against fresh
// news/price/regime (web search — no new paid data) with Bill's own ledger record + per-symbol history in
// view, and verdict it: valid / weakening / broken, with a suggested hold / trim / exit.
//
// PROPOSE-ONLY + gated like every other ritual:
//   off   → nothing.
//   gated → verdicts + any suggested sells go to #trade-bot as a proposal; NOTHING is placed.
//   auto (+ BILL_ALLOW_AUTO_EXEC=1) → the validated sells are placed (exit → closePosition, which cancels
//          the name's stop first; trim → sellQty) — the same double-gated path the other rituals use.
// The model NEVER sizes or places anything: verdictsToOrders() sizes deterministically in code (exit =
// full qty, trim = a fixed fraction), every order runs through validateOrders(), and placement happens
// only behind mode=auto + the env opt-in. Sells are de-risking, so (like the profit-trim) they are not
// blocked by the risk halt — the halt only ever freezes NEW buys, and this ritual can't emit a buy at all.
// Paper-only (alpaca.ts hard-guards the paper host). Verdicts persist to memory/thesis-health.json, which
// the refresh ritual surfaces as a per-position badge on the dashboard and the EOD wrap summarizes.
//   npm run revalidate
import "./load-env.js";
import { writeFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runAgent } from "./agent.js";
import { paperSnapshot, closePosition, sellQty, waitForOrderTerminal } from "./alpaca.js";
import { validateOrders, rulesFor } from "./guardrails.js";
import { getMode, autoExecAllowed } from "./mode.js";
import { getProfile } from "./profile.js";
import { readLedger, appendProposals } from "./ledger.js";
import { fetchSpyRegime, renderRegimeLine } from "./regime.js";
import { isMarketDayToday, isPastHalfDayCloseET } from "./market-calendar.js";
import {
  buildPositionContexts, buildRevalidatePrompt, parseVerdicts, verdictsToOrders,
  renderVerdictLines, renderThesisHealthFooter, DEFAULT_REVALIDATE,
} from "./revalidate.js";
import { positionNews, renderNewsLines } from "./news-feed.js";
import { emitEvent } from "./fleet-emit.js";
import { installSafetyNet } from "./http-utils.js";

installSafetyNet("bill-revalidate");

const { sendDiscord } = await import("../../scripts/notify-discord.mjs" as string);

const HEALTH = fileURLToPath(new URL("../../memory/thesis-health.json", import.meta.url));
const PENDING = fileURLToPath(new URL("../../memory/pending-revalidation.md", import.meta.url));
const TRADELOG = fileURLToPath(new URL("../../memory/trade-log.md", import.meta.url));

const mode = getMode();
if (mode === "off") {
  console.log(JSON.stringify({ ok: true, skipped: true, reason: "mode=off" }));
  process.exit(0);
}

// Market-day guard — no session, no fresh data worth re-judging on (and nothing could be placed anyway).
const marketCheck = await isMarketDayToday();
if (!marketCheck.open) {
  console.log(JSON.stringify({ ok: true, skipped: true, reason: marketCheck.reason, via: marketCheck.via, date: marketCheck.date }));
  process.exit(0);
}
// Half-day past the 13:00 ET close: the market is shut, so even in auto mode nothing may be placed —
// the analysis still runs (verdicts are useful overnight) but placement is forced off for this pass.
const marketClosedNow = marketCheck.halfDay && isPastHalfDayCloseET();

const snap = await paperSnapshot();
if (!snap.connected) {
  console.error(JSON.stringify({ ok: false, reason: "Alpaca not reachable (keys/endpoint)", error: snap.error }));
  process.exit(1);
}
const acct = (snap.account ?? {}) as Record<string, unknown>;
const equity = Number(acct.equity ?? 0);
const rawPositions = (Array.isArray(snap.positions) ? snap.positions : []) as Array<Record<string, unknown>>;
const rules = rulesFor(getProfile());

// NULL: flat book → nothing to re-validate. Persist the empty state so stale badges don't linger.
if (!rawPositions.length) {
  writeFileSync(HEALTH, JSON.stringify({ updated: new Date().toISOString(), verdicts: [] }, null, 2) + "\n");
  console.log(JSON.stringify({ ok: true, skipped: true, reason: "no open positions" }));
  process.exit(0);
}

// Each position's OWN entry record (thesis/conviction/setup) from the ledger + Bill's per-symbol
// closed-trade history — the model re-judges with Bill's actual history on every name in view.
const ledger = readLedger();
const contexts = buildPositionContexts(rawPositions, ledger);
const regime = await fetchSpyRegime();

// Per-holding news feed (Bull v6): recent cached headlines per held name as revalidation grounding —
// fresh negative news on a holding is a signal. Best-effort: no source / feed down → "" (prompt unchanged).
let newsLines = "";
try { newsLines = renderNewsLines(await positionNews(contexts.map((c) => c.symbol)), 2); } catch { /* news never breaks the ritual */ }

const prompt = buildRevalidatePrompt(contexts, ledger, renderRegimeLine(regime), newsLines);
const res = await runAgent(prompt);
if (res.isError) {
  console.error(JSON.stringify({ ok: false, reason: res.text || "agent error", costUsd: res.costUsd }));
  process.exit(1);
}
// Only verdicts on names actually held count — a hallucinated symbol can't verdict (or exit) anything.
const held = new Set(contexts.map((c) => c.symbol));
const verdicts = parseVerdicts(res.text).filter((v) => held.has(v.symbol));
if (!verdicts.length) {
  // Parse failure / empty output: keep the previous thesis-health file (stale beats blank) and bail.
  console.error(JSON.stringify({ ok: false, reason: "no parseable verdicts", raw: res.text.slice(0, 300), costUsd: res.costUsd }));
  process.exit(1);
}

// Fleet event ledger (best-effort, never throws): a broken thesis on a held name is a key activity signal.
const brokenVerdicts = verdicts.filter((v) => v.verdict === "broken");
if (brokenVerdicts.length) {
  await emitEvent({
    kind: "revalidation-broken",
    summary: `thesis broken: ${brokenVerdicts.map((v) => `${v.symbol}${v.reason ? ` (${v.reason})` : ""}`).join("; ")}`.slice(0, 400),
    severity: "warn",
  });
}

// Persist the verdicts (memory file): the refresh ritual reads this into dashboard/data/status.json
// (per-position thesis-health badge) and the EOD wrap appends renderThesisHealthFooter over it.
const ctxBySym = new Map(contexts.map((c) => [c.symbol, c]));
writeFileSync(HEALTH, JSON.stringify({
  updated: new Date().toISOString(),
  verdicts: verdicts.map((v) => {
    const c = ctxBySym.get(v.symbol);
    return { ...v, price: c?.current ?? null, unrealizedPlPct: c?.unrealizedPlPct ?? null };
  }),
}, null, 2) + "\n");

// DETERMINISTIC derivation + the SAME gate machinery as every ritual: the verdicts become sized SELL
// proposals in code (exit = full qty, trim = fixed fraction — never a model number), then every order
// runs through validateOrders() before anything else may happen. No direct orders from this ritual.
const items = verdictsToOrders(verdicts, contexts, DEFAULT_REVALIDATE, !!rules.fractional);
const checked = validateOrders(items.map((i) => i.order), { equity, openCount: rawPositions.length }, rules);
const actionable = items.filter((_, i) => checked[i].ok);
const rejected = checked.filter((c) => !c.ok);

// Ledger keystone: record every revalidation-driven proposal (valid + rejected) for reconciliation.
appendProposals(checked.map((c, i) => ({
  ts: new Date().toISOString(),
  cycle: new Date().toISOString().slice(0, 10),
  symbol: c.order.symbol,
  side: c.order.side,
  qty: c.order.qty,
  est_price: c.order.est_price,
  trail_percent: null,
  thesis: c.order.thesis,
  profile: getProfile(),
  mode,
  status: c.ok ? "proposed" : "rejected",
  reasons: c.ok ? [`thesis-revalidation: ${items[i].verdict.verdict} → ${items[i].kind}`] : c.reasons,
  confidence: null,
  setup: c.order.setup ?? null,
  outcome: "open",
})));

const verdictLines = renderVerdictLines(verdicts, contexts);
const actionLines = actionable.map((i) =>
  `  ↪ ${i.kind === "exit" ? "EXIT" : `TRIM ${Math.round(DEFAULT_REVALIDATE.trimFraction * 100)}%`} ${i.order.symbol} (${i.order.qty} sh @ ~$${i.order.est_price}) — thesis ${i.verdict.verdict}`);
const body = [
  `🧬 **Bill the Bull — thesis re-validation · ${rules.name}**`,
  ...verdictLines,
  ...(actionable.length ? ["", "**Suggested actions (deterministically sized, gate applies):**", ...actionLines] : ["", "✅ No action suggested — every thesis holds (or holds were advised)."]),
  ...(rejected.length ? [`Rejected by guardrails: ${rejected.map((r) => `${r.order.symbol} [${r.reasons.join("; ")}]`).join(" · ")}`] : []),
].join("\n");
writeFileSync(PENDING, `# Thesis re-validation — ${new Date().toISOString()}\n\n${body}\n\n${renderThesisHealthFooter(verdicts)}\n`);

// ── gated, auto-without-opt-in, or market-closed-now → PROPOSE ONLY (place nothing) ──
const willPlace = mode === "auto" && autoExecAllowed() && !marketClosedNow;
if (!willPlace) {
  const note = mode === "auto" && !autoExecAllowed() ? "\n(mode=auto but BILL_ALLOW_AUTO_EXEC not set → proposing, not placing)"
    : marketClosedNow ? "\n(half-day — market closed; verdicts recorded, nothing placed)" : "";
  // Only ping Discord when there's something to say: a suggested action or a non-valid thesis.
  if (actionable.length || verdicts.some((v) => v.verdict !== "valid")) {
    await sendDiscord((body + (actionable.length ? "\nReply 👍 to approve, or set mode=auto (+ BILL_ALLOW_AUTO_EXEC=1)." : "") + note).slice(0, 1990), { channel: "bull", username: "Bill the Bull" });
  }
  console.log(JSON.stringify({ ok: true, mode, placed: 0, verdicts: verdicts.length, proposedActions: actionable.length, rejected: rejected.length, costUsd: res.costUsd }, null, 2));
  process.exit(0);
}

// ── AUTO (double-gated) ── place the validated sells: exit via closePosition (cancels the name's stop
// first → no orphan stop, identical to the rotation SELL leg), trim via sellQty. Sells only — de-risking.
const results: Array<{ symbol: string; kind: string; ok: boolean; error?: string }> = [];
for (const i of actionable) {
  try {
    if (i.kind === "exit") {
      const r = await closePosition(i.order.symbol);
      if (r.order?.id) await waitForOrderTerminal(String(r.order.id), { timeoutMs: 45_000, intervalMs: 1_000 });
      appendFileSync(TRADELOG, `- ${new Date().toISOString()} REVALIDATE-EXIT ${i.order.symbol} (liquidated${r.alreadyFlat ? " — already flat" : ""}, ${r.canceledStops} stop(s) canceled) — thesis broken: ${i.verdict.reason}\n`);
    } else {
      await sellQty(i.order.symbol, i.order.qty);
      appendFileSync(TRADELOG, `- ${new Date().toISOString()} REVALIDATE-TRIM sold ${i.order.qty} ${i.order.symbol} (${Math.round(DEFAULT_REVALIDATE.trimFraction * 100)}% of position) — thesis ${i.verdict.verdict}: ${i.verdict.reason}\n`);
    }
    results.push({ symbol: i.order.symbol, kind: i.kind, ok: true });
  } catch (e) {
    results.push({ symbol: i.order.symbol, kind: i.kind, ok: false, error: String(e instanceof Error ? e.message : e) });
  }
}
const done = results.filter((r) => r.ok);
await sendDiscord([
  `🧬 **Bill — thesis re-validation acted (auto · ${rules.name})**`,
  ...verdictLines,
  "",
  ...results.map((r) => r.ok ? `  ✅ ${r.kind.toUpperCase()} ${r.symbol}` : `  ⚠️ ${r.kind.toUpperCase()} ${r.symbol} FAILED: ${r.error}`),
].join("\n").slice(0, 1990), { channel: "bull", username: "Bill the Bull" });
console.log(JSON.stringify({ ok: true, mode, placed: done.length, failed: results.length - done.length, verdicts: verdicts.length, rejected: rejected.length, costUsd: res.costUsd }, null, 2));
