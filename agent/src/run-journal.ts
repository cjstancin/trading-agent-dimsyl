// Bill's JOURNAL ritual (Bull v2 #4). Reconciles closed trades, then writes a short LLM post-mortem for
// each NEWLY closed trade (thesis vs outcome + one lesson) and grades it → memory/journal.jsonl. The refresh
// ritual surfaces these on the dashboard Journal tab. No orders. No-op when there are no new closes.
//   npm run journal
import "./load-env.js";
import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runAgent } from "./agent.js";
import { reconcile, type ClosedTrade } from "./reconcile.js";
import { getBars } from "./alpaca.js";
import { maeMfe } from "./mae-mfe.js";
import { installSafetyNet } from "./http-utils.js";

installSafetyNet("bill-journal");

const JOURNAL = fileURLToPath(new URL("../../memory/journal.jsonl", import.meta.url));
const key = (t: ClosedTrade) => `${t.symbol}|${t.closedAt}`;
const grade = (r: number) => (r >= 2 ? "A" : r >= 1 ? "B" : r >= 0 ? "C" : r >= -1 ? "D" : "F");

const closed = await reconcile();
const seen = new Set(
  existsSync(JOURNAL)
    ? readFileSync(JOURNAL, "utf8").split(/\r?\n/).filter(Boolean).map((l) => { try { return key(JSON.parse(l)); } catch { return ""; } })
    : [],
);
const fresh = closed.filter((c) => !seen.has(key(c)));
if (!fresh.length) { console.log(JSON.stringify({ ok: true, newEntries: 0, totalClosed: closed.length })); process.exit(0); }

for (const c of fresh) {
  // Excursion analytics: fetch the hold-window bars (read-only data API, [] on failure) and compute
  // MAE/MFE. reconcile() only emits long round-trips (FIFO buy→sell), so side is "long". Bars unavailable
  // → leave the fields off rather than block the journal.
  let excursion: Partial<ReturnType<typeof maeMfe>> = {};
  const bars = await getBars(c.symbol, c.openedAt, c.closedAt);
  if (bars.length) excursion = maeMfe(c.entry, "long", bars);

  const prompt = `You are Bill the Bull. Write a SHORT trade post-mortem (2–3 sentences, plain text) for this closed PAPER trade:\n${JSON.stringify(c)}\nCover: the likely setup/thesis, why it ${c.pnlUsd >= 0 ? "worked" : "didn't"}, and ONE concrete lesson. No preamble.`;
  let note = "";
  try { const { text } = await runAgent(prompt); note = (text || "").trim().slice(0, 400); } catch { note = ""; }
  appendFileSync(JOURNAL, JSON.stringify({ ...c, ...excursion, grade: grade(c.rMultiple), note, ts: new Date().toISOString() }) + "\n");
}
console.log(JSON.stringify({ ok: true, newEntries: fresh.length, totalClosed: closed.length }, null, 2));
