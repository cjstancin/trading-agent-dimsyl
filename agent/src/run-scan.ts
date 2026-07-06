// Bill's SCAN ritual (Bull v2 — the signal source). Scans the market for the best swing/momentum setups
// matching the active profile, and writes them as today's APPROVED CYCLE that the EXECUTE ritual then acts on.
// Read-only: writes Signals/approved-cycle.md only — places NO orders. Respects the mode toggle (off → skip).
//   npm run scan
import "./load-env.js";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runAgent } from "./agent.js";
import { paperSnapshot } from "./alpaca.js";
import { getMode } from "./mode.js";
import { getProfile } from "./profile.js";
import { rulesFor } from "./guardrails.js";
import { readLedger } from "./ledger.js";
import { renderTrackRecordBlock, minTagTrades } from "./track-record.js";
import { fetchSpyRegime, renderRegimeLine } from "./regime.js";
import { installSafetyNet } from "./http-utils.js";

installSafetyNet("bill-scan");

if (getMode() === "off") { console.log(JSON.stringify({ ok: true, skipped: true, reason: "mode=off" })); process.exit(0); }

const APPROVED = fileURLToPath(new URL("../../Signals/approved-cycle.md", import.meta.url));
const rules = rulesFor(getProfile());
const snap = await paperSnapshot();
const acct = (snap.account as Record<string, unknown> | undefined) ?? {};
const held = ((snap.positions as Array<Record<string, unknown>> | undefined) ?? []).map((p) => String(p.symbol ?? ""));

// Outcome feedback (learning loop): Bill's own closed-trade record by setup tag, min-N-gated so a thin
// sample reads NEUTRAL. Advisory to the model only — deterministic sizing is untouched. "" until the
// first reconciled close, so a fresh account adds nothing.
const trackRecord = renderTrackRecordBlock(readLedger(), minTagTrades());
// Deterministic 200-DMA regime (SPY level + slope) — replaces the LLM's web-search vibe call. The same
// computed value drives the execute-time risk-off gate, so the scan must plan around it.
const regime = await fetchSpyRegime();

const prompt = `You are Bill the Bull, CJ's trading agent (paper account). SCAN the market right now and produce today's APPROVED CYCLE — a ranked shortlist of the best swing/momentum setups to consider next session.

Active profile: ${rules.name} — max ${Math.round((rules.maxPositionPct ?? 0.2) * 100)}%/position, NO fixed position count (the code's risk/heat/sector/cash caps govern how many names fit), price ≥ $${rules.minPrice}, ~${rules.trailPercent}% protective trailing stop on every buy.
Live paper book — equity ≈ $${acct.equity ?? "n/a"}, currently holding: ${held.length ? held.join(", ") : "nothing (flat)"}. Don't duplicate open positions.
COMPUTED MARKET REGIME (SPY vs 200-DMA, deterministic — treat as THE regime, do not re-derive it): ${renderRegimeLine(regime)}.${regime.state === "risk-off" ? ` Risk-off: execution BLOCKS new long entries unless a setup is explicitly counter-trend — propose fewer/defensive ideas, and tag any genuine counter-trend setup as "counter-trend".` : ""}
${trackRecord ? trackRecord + "\n" : ""}FRACTIONAL SIZING: positions use FRACTIONAL shares, so ANY quality name is reachable regardless of share price (NVDA + other high-priced names included) — never skip a name for being "too expensive." Aim for a CONVICTION-TIERED shortlist: ~${rules.coreCount ?? 6} high-conviction CORE ideas you'd put the most capital in, plus a few optional smaller SATELLITE ideas — no fixed total; the risk engine decides how many fit.

Use web search for movers, breakouts, and catalysts (the regime is already computed above). Pick as many **quality, liquid** US names as genuinely earn a place (no fixed count) that you'd be comfortable holding **1 week to ~5 years** — large/mid-cap real companies (real revenue) or liquid broad/sector ETFs (SPY/QQQ/XLK/SMH-type). **EXCLUDE entirely: penny stocks (price < $${rules.minPrice}), leveraged/inverse ETFs (NO SOXL/TQQQ/3x), crypto, meme/pump names, illiquid or pre-revenue lottery tickets.** Aggressive here = conviction in GOOD names, not gambles — quality over quantity, fine to pick fewer. For EACH idea give: ticker · CORE or SATELLITE · setup (momentum breakout / pullback-in-uptrend / catalyst / quality-trend) · one-line thesis · entry zone · protective stop.

Output concise markdown: a short heading line, then one bullet per idea. This is a candidate WATCHLIST — you place NO orders here.`;

const { text, costUsd, isError } = await runAgent(prompt);
if (isError || !text.trim()) { console.error(JSON.stringify({ ok: false, reason: text || "empty result", costUsd })); process.exit(1); }

const stamp = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
writeFileSync(APPROVED, `# Approved cycle — ${stamp} (auto-scan · ${rules.name})\n\n${text.trim()}\n`);
console.log(JSON.stringify({ ok: true, profile: rules.name, regime: regime.state, wrote: "Signals/approved-cycle.md", costUsd }, null, 2));
