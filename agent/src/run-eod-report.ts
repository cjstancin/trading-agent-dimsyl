// Bill's END-OF-DAY REPORT (read-only) — posts the day's wrap to #trade-bot as "Bill the Bull".
// Reads the live Alpaca PAPER snapshot + the day's fills + recent ledger entries, has the agent
// write a tight Discord-friendly summary: current state, how the day went, what was bought/sold.
// Place NO orders. Run: `npm run eod-report`. Designed to be the LAST step of the close-of-day cmd
// (after `refresh` and `journal` so the ledger is current).
import "./load-env.js";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runAgent } from "./agent.js";
import { paperSnapshot, getActivities, getClosedOrders, getPortfolioHistory } from "./alpaca.js";
import { getMode } from "./mode.js";

if (getMode() === "off") {
  console.log(JSON.stringify({ ok: true, skipped: true, reason: "mode=off" }));
  process.exit(0);
}

const { sendDiscord } = await import("../../scripts/notify-discord.mjs" as string);

const today = new Date().toLocaleDateString("en-US", {
  weekday: "long", year: "numeric", month: "long", day: "numeric",
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

// Filter today's fills only (Alpaca returns recent activity; cap to today's date in ET).
const isoToday = new Date().toISOString().slice(0, 10);
const todaysFills = (Array.isArray(fills) ? fills : []).filter((f: any) => String(f?.transaction_time || f?.date || "").startsWith(isoToday));
const todaysCloses = (Array.isArray(closedOrders) ? closedOrders : []).filter((o: any) => String(o?.filled_at || o?.updated_at || "").startsWith(isoToday));

// Read recent ledger entries if present (these are CJ's paper-trade post-mortems).
const LEDGER = fileURLToPath(new URL("../../memory/journal.jsonl", import.meta.url));
let recentJournal = "";
try {
  if (existsSync(LEDGER)) {
    const lines = readFileSync(LEDGER, "utf8").split(/\r?\n/).filter(Boolean);
    recentJournal = lines.slice(-5).join("\n");
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

const posted = await sendDiscord(text, { channel: "bull", username: "Bill the Bull" });
console.log(JSON.stringify({ ok: posted.ok === true, posted, paperConnected: snap.connected, todaysFills: todaysFills.length, todaysCloses: todaysCloses.length, costUsd, numTurns }, null, 2));
if (!posted.ok) process.exitCode = 1;
