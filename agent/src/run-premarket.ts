// Bill's first ritual — PRE-MARKET BRIEF (read-only).
// 1) pull the live Alpaca PAPER snapshot (deterministic, read-only), 2) agent analyzes + writes the brief,
// 3) post to #trade-bot as "Bill". No orders are placed. Run: `npm run premarket`.
import "./load-env.js";
import { runAgent } from "./agent.js";
import { paperSnapshot } from "./alpaca.js";
import { getMode } from "./mode.js";
import { isMarketDayToday } from "./market-calendar.js";
import { rulesFor } from "./guardrails.js";
import { getProfile } from "./profile.js";
import { readState, positionLines, readPositionTrails } from "./synthetic-stops.js";
import { fetchSpyRegime, renderRegimeLine } from "./regime.js";
import { positionNews, renderNewsLines } from "./news-feed.js";
import { installSafetyNet } from "./http-utils.js";

installSafetyNet("bill-premarket");

if (getMode() === "off") {
  console.log(JSON.stringify({ ok: true, skipped: true, reason: "mode=off" }));
  process.exit(0);
}

// Reuse the existing tested Bill notifier (ESM .mjs); dynamic import avoids TS type-resolution on the .mjs.
const { sendDiscord } = await import("../../scripts/notify-discord.mjs" as string);

// Market-day guard. If today's a weekend / NYSE holiday, bail with a brief Discord notice so CJ knows
// the system ran but did nothing. The mid + close rituals skip silently.
const marketCheck = await isMarketDayToday();
if (!marketCheck.open) {
  await sendDiscord(
    `🐂 Bill the Bull — market closed today (${marketCheck.date})\n` +
      `↪ ${marketCheck.reason} (via ${marketCheck.via}) — premarket / scan / execute skipped. See you next session.`,
    { channel: "bull", username: "Bill the Bull" },
  );
  console.log(JSON.stringify({ ok: true, skipped: true, reason: marketCheck.reason, via: marketCheck.via, date: marketCheck.date }));
  process.exit(0);
}

const today = new Date().toLocaleDateString("en-US", {
  weekday: "long", year: "numeric", month: "long", day: "numeric",
});

const snap = await paperSnapshot();
// Deterministic 200-DMA regime — the same computed value the scan prompt + execute risk-off gate use.
const regime = await fetchSpyRegime();

// Per-holding news feed (Bull v6): recent cached headlines per open position (existing Alpaca data
// source, TTL ~1h) as grounding for the per-position notes. Best-effort — feed down → "" (no block).
const heldSyms = (Array.isArray(snap.positions) ? (snap.positions as Array<Record<string, unknown>>) : []).map((p) => String(p.symbol ?? ""));
let newsBySym: Awaited<ReturnType<typeof positionNews>> = {};
try { newsBySym = await positionNews(heldSyms); } catch { /* news never breaks the brief */ }
const newsLines = renderNewsLines(newsBySym, 2);

const prompt = `You are Bill, CJ's PAPER trading agent. Write his PRE-MARKET BRIEF for ${today}.
This is a READ-ONLY run: analyze and write only — you place no orders.

LIVE ALPACA PAPER SNAPSHOT (read-only; ${snap.connected ? "connected" : "NOT connected — note this"}):
${JSON.stringify(snap, null, 2)}
${newsLines ? `\nRECENT HEADLINES per holding (existing data source, cached ≤1h, sanitized — use as grounding for the per-position notes; still verify anything decision-relevant with web search):\n${newsLines}\n` : ""}
Also do (web search is primary for live data):
- Today's market-open setup: index futures, key levels for SPY/QQQ, any major overnight headline. The regime is COMPUTED deterministically (SPY vs 200-DMA): ${renderRegimeLine(regime)} — use this as THE regime, don't re-derive it.
- For each open paper position above, a one-line note (overnight move / any catalyst today).
- You may read memory/strategy.md and Signals/approved-cycle.md (if present) for queued ideas.

Write the brief as PLAIN TEXT, Discord-friendly, MAX 1400 characters (a precise per-position table — bought / now / stop — is auto-appended after your brief, so DON'T duplicate those numbers; just add catalyst/overnight color per position):
🐂 Bill Pre-Market — ${today}
💼 Paper book: equity $<n>, cash $<n>, <N> positions; open orders <N>  (if not connected, say so)
📊 Open setup: <futures + regime + key levels>
🎯 On watch: <approved/queued ideas or own setups — each WITH its planned stop discipline. Watch only, NO execution.>
⚠️ Risk: <daily −10% halt status, −30% MTD kill-switch status, concentration note>
Output ONLY the brief text — no preamble. If a datapoint can't be fetched, write "n/a" and continue.`;

const { text, costUsd, isError, numTurns } = await runAgent(prompt);

if (isError || !text.trim()) {
  console.error(JSON.stringify({ ok: false, reason: text || "empty result", costUsd, numTurns }));
  process.exit(1);
}

// Append a precise per-position table (bought / now / synthetic stop) — the numbers CJ wants at a glance,
// computed deterministically (not LLM-rephrased) from the live snapshot + the synthetic-stop peaks.
let brief = text.trim();
const rawPos = Array.isArray(snap.positions) ? (snap.positions as Array<Record<string, unknown>>) : [];
if (rawPos.length) {
  const lines = positionLines(rawPos, readState(), rulesFor(getProfile()).trailPercent ?? 20, readPositionTrails());
  brief += `\n\n📊 Positions — bought · now · stop:\n` + lines.map((l) => "• " + l).join("\n");
}
// Computed regime, appended deterministically (not LLM-rephrased) so the brief always carries the real value.
brief += `\n\n📐 Regime (200-DMA, computed): ${renderRegimeLine(regime)}`;
// Per-holding headlines, appended deterministically (1 per name, cached ≤1h) so the freshest news line
// per position always reaches CJ even if the model skipped it. Empty feed → nothing appended.
const compactNews = renderNewsLines(newsBySym, 1);
if (compactNews) brief += `\n\n📰 Holdings news (≤1h cache):\n${compactNews}`;
// Discord hard-caps messages at 2000 chars — protective slice (same pattern as the other rituals).
const posted = await sendDiscord(brief.slice(0, 1990), { channel: "bull", username: "Bill the Bull" });
console.log(JSON.stringify({ ok: posted.ok === true, posted, paperConnected: snap.connected, costUsd, numTurns }, null, 2));
if (!posted.ok) process.exitCode = 1;
