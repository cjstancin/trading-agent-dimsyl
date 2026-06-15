// Bill's JOURNAL ritual (Bull v2 #4). Reconciles closed trades, then writes a short LLM post-mortem for
// each NEWLY closed trade (thesis vs outcome + one lesson) and grades it → memory/journal.jsonl. The refresh
// ritual surfaces these on the dashboard Journal tab. No orders. No-op when there are no new closes.
//   npm run journal
import "./load-env.js";
import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runAgent } from "./agent.js";
import { reconcile, type ClosedTrade } from "./reconcile.js";

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
  const prompt = `You are Bill the Bull. Write a SHORT trade post-mortem (2–3 sentences, plain text) for this closed PAPER trade:\n${JSON.stringify(c)}\nCover: the likely setup/thesis, why it ${c.pnlUsd >= 0 ? "worked" : "didn't"}, and ONE concrete lesson. No preamble.`;
  let note = "";
  try { const { text } = await runAgent(prompt); note = (text || "").trim().slice(0, 400); } catch { note = ""; }
  appendFileSync(JOURNAL, JSON.stringify({ ...c, grade: grade(c.rMultiple), note, ts: new Date().toISOString() }) + "\n");
}
console.log(JSON.stringify({ ok: true, newEntries: fresh.length, totalClosed: closed.length }, null, 2));
