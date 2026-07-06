// Bill's END-OF-DAY REPORT (read-only) — posts the day's wrap to #trade-bot as "Bill the Bull".
// Reads the live Alpaca PAPER snapshot + the day's fills + recent ledger entries, has the agent
// write a tight Discord-friendly summary: current state, how the day went, what was bought/sold.
// Place NO orders. Run: `npm run eod-report`. Designed to be the LAST step of the close-of-day cmd
// (after `refresh` and `journal` so the ledger is current).
import "./load-env.js";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runAgent } from "./agent.js";
import { readLedger } from "./ledger.js";
import { rollingStats, renderRollingFooter } from "./rolling-stats.js";
import { attribution, renderAttributionFooter } from "./attribution.js";
import { excursionSummary, renderExcursionFooter, renderExcursionLines, type ExcursionTrade } from "./excursion-stats.js";
import { renderThesisHealthFooter } from "./revalidate.js";
import { paperSnapshot, getActivities, getClosedOrders, getPortfolioHistory } from "./alpaca.js";
import { getMode } from "./mode.js";
import { isMarketDayToday, isPastHalfDayCloseET } from "./market-calendar.js";
import { installSafetyNet } from "./http-utils.js";

installSafetyNet("bill-eod-report");

if (getMode() === "off") {
  console.log(JSON.stringify({ ok: true, skipped: true, reason: "mode=off" }));
  process.exit(0);
}

// Market-day guard — no day to report on if the market was closed.
{
  const marketCheck = await isMarketDayToday();
  if (!marketCheck.open) {
    console.log(JSON.stringify({ ok: true, skipped: true, reason: marketCheck.reason, via: marketCheck.via, date: marketCheck.date }));
    process.exit(0);
  }
  // Half-day safety: the close-of-day wrap must not fire before the 13:00 ET close on a half-day.
  // bill-close.timer fires at 16:00 ET — well after — so this only guards a manual/early invocation.
  if (marketCheck.halfDay && !isPastHalfDayCloseET()) {
    console.log(JSON.stringify({ ok: true, skipped: true, reason: "half-day not yet closed (before 13:00 ET)", date: marketCheck.date }));
    process.exit(0);
  }
}

const { sendDiscord } = await import("../../scripts/notify-discord.mjs" as string);

const today = new Date().toLocaleDateString("en-US", {
  timeZone: "America/New_York", weekday: "long", year: "numeric", month: "long", day: "numeric",
});

// Live state — bounded reads, never crash the report.
async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); } catch { return fallback; }
}

const [snap, fills, closedOrders, portfolio] = await Promise.all([
  safe(() => paperSnapshot(), { connected: false, error: "snapshot unreachable" } as any),
  safe(() => getActivities("FILL"), [] as any),
  safe(() => getClosedOrders(50), [] as any),
  safe(() => getPortfolioHistory("1D", "5Min"), {} as any),
]);

// Filter today's fills only (Alpaca returns recent activity; cap to today's date in ET). Use the ET
// calendar date, NOT UTC — RTH fills carry UTC timestamps whose calendar date equals the ET date, and
// using UTC here would drop all of today's trades on any run after 8pm ET (e.g. a manual late run).
const isoToday = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const todaysFills = (Array.isArray(fills) ? fills : []).filter((f: any) => String(f?.transaction_time || f?.date || "").startsWith(isoToday));
const todaysCloses = (Array.isArray(closedOrders) ? closedOrders : []).filter((o: any) => String(o?.filled_at || o?.updated_at || "").startsWith(isoToday));

// Read recent ledger entries if present (these are CJ's paper-trade post-mortems). Also parse them into
// ExcursionTrade records so the deterministic MAE/MFE footer (below) reports the same journal data.
const LEDGER = fileURLToPath(new URL("../../memory/journal.jsonl", import.meta.url));
let recentJournal = "";
let journalEntries: (ExcursionTrade & Record<string, unknown>)[] = [];
try {
  if (existsSync(LEDGER)) {
    const lines = readFileSync(LEDGER, "utf8").split(/\r?\n/).filter(Boolean);
    recentJournal = lines.slice(-5).join("\n");
    journalEntries = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) as typeof journalEntries;
  }
} catch { /* not critical */ }

const prompt = `You are Bill, CJ's PAPER trading agent. Write his END-OF-DAY WRAP for ${today}.
This is a READ-ONLY run: analyze and write only — no orders are placed.

LIVE ALPACA PAPER SNAPSHOT (read-only; ${snap.connected ? "connected" : "NOT connected — note this"}):
${JSON.stringify(snap, null, 2)}

TODAY'S FILLS (${todaysFills.length} total):
${JSON.stringify(todaysFills.slice(0, 20), null, 2)}

TODAY'S CLOSED ORDERS (${todaysCloses.length} total):
${JSON.stringify(todaysCloses.slice(0, 20), null, 2)}

INTRADAY PORTFOLIO HISTORY (5Min bars):
${JSON.stringify(portfolio, null, 2)}

RECENT JOURNAL ENTRIES (last 5 closes; with thesis/grade):
${recentJournal || "(none yet)"}

Write the wrap as PLAIN TEXT, Discord-friendly, MAX 1800 characters. Use this shape:
🌙 Bill EOD — ${today}
💼 Final state: equity $<n>, cash $<n>, day P&L $<n> (<+/-pct%>), <N> open positions
📈 Today's trades:
   ↗ <buys: SYMBOL qty @ fill, with one-line rationale or setup>
   ↘ <sells/closes: SYMBOL realized P&L $<n>, grade if available>
   (if zero trades, say "no fills today" and explain — flat market / risk-off / no setups met>)
🎯 How the day went: <1–2 lines on the action vs the morning plan; note any halts hit, alerts fired>
📝 Notes / lessons: <1 line — what you learned today, or what you'll watch tomorrow>
Output ONLY the report text — no preamble. If a datapoint can't be fetched, write "n/a" and continue.`;

const { text, costUsd, isError, numTurns } = await runAgent(prompt);

if (isError || !text.trim()) {
  console.error(JSON.stringify({ ok: false, reason: text || "empty result", costUsd, numTurns }));
  process.exit(1);
}

// Append the deterministic rolling-form footer (recent win-rate / avg win-loss / expectancy). Code-rendered,
// not LLM-written, so the numbers are always exact and present. Reads the proposal ledger as-is — `npm run
// refresh` (which reconciles outcomes) runs earlier in the close-of-day cmd. Footer is "" when no closed
// trades yet, so a fresh account adds nothing. Pure read; never affects orders.
const rollingFooter = renderRollingFooter(rollingStats(readLedger()));

// Deterministic per-strategy P&L attribution footer (Bull strategy-attribution): which setups make/lose
// money + win-rate per strategy, code-rendered from the proposal ledger's closed trades (the same set the
// rolling footer reads). attribution() filters to win/loss internally, so passing the raw ledger is correct.
// "" when no closed trade is tagged. Pure read; never affects orders.
const attributionFooter = renderAttributionFooter(attribution(readLedger()));

// Deterministic MAE/MFE excursion footer (Bull #12 reporting): portfolio summary over all journaled closes
// + per-trade lines for the trades that CLOSED TODAY. Code-rendered from memory/journal.jsonl (the only
// place excursion is persisted), so the numbers are always exact. "" when no trade carries excursion data.
// Pure read; never affects orders.
const excSummaryLine = renderExcursionFooter(excursionSummary(journalEntries));
const todaysCloseLines = renderExcursionLines(journalEntries.filter((j) => String(j.closedAt ?? "").startsWith(isoToday)));
const excursionFooter = excSummaryLine
  ? [excSummaryLine, ...(todaysCloseLines.length ? ["📐 Today's closes:", ...todaysCloseLines] : [])].join("\n")
  : "";

// Deterministic thesis-health footer: the latest revalidation verdicts (memory/thesis-health.json,
// written by `npm run revalidate`) summarized per position — but only when they're from TODAY, so a
// stale file from a prior session never masquerades as current judgment. "" when absent/stale/flat.
let thesisFooter = "";
try {
  const tf = fileURLToPath(new URL("../../memory/thesis-health.json", import.meta.url));
  if (existsSync(tf)) {
    const th = JSON.parse(readFileSync(tf, "utf8"));
    const updatedET = th?.updated ? new Date(String(th.updated)).toLocaleDateString("en-CA", { timeZone: "America/New_York" }) : "";
    if (updatedET === isoToday && Array.isArray(th?.verdicts)) thesisFooter = renderThesisHealthFooter(th.verdicts);
  }
} catch { /* not critical */ }

const report = [text.trimEnd(), thesisFooter, rollingFooter, attributionFooter, excursionFooter].filter(Boolean).join("\n\n");

const posted = await sendDiscord(report, { channel: "bull", username: "Bill the Bull" });
console.log(JSON.stringify({ ok: posted.ok === true, posted, paperConnected: snap.connected, todaysFills: todaysFills.length, todaysCloses: todaysCloses.length, costUsd, numTurns }, null, 2));
if (!posted.ok) process.exitCode = 1;
