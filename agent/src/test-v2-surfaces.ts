// Offline tests — v2 surfaces: watchlist, trade notes, digest, statement, explains, chunking.
// :memory: DB; no network, no env (postBill itself is not exercised — it's transport, and the
// underlying sendDiscord already has its own contract; chunkMessage is the logic worth testing).
import { openDb } from "./v2/db.js";
import { d9 } from "./v2/decimal.js";
import { seedBook, recordCash } from "./v2/settled-cash.js";
import { ingestFill } from "./v2/lots.js";
import { markEquity } from "./v2/book/equity.js";
import { recordBench } from "./v2/book/benchmarks.js";
import { recordExit, weeklyWatchlistCheck, watchlistCandidates, consumeCandidate, renderWatchlist } from "./v2/book/watchlist.js";
import { chunkMessage } from "./v2/surfaces/discord.js";
import { tradeNote, escalationNote, skipNote } from "./v2/surfaces/notes.js";
import { sundayDigest } from "./v2/surfaces/digest.js";
import { monthlyStatement } from "./v2/surfaces/statement.js";
import { buildExplainsData, buildExplainsPrompt } from "./v2/surfaces/explains.js";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${detail}`); }
}

console.log("v2 surfaces — watchlist:");
{
  const db = openDb(":memory:");
  recordExit(db, { ts: "2026-08-01T15:00:00Z", sleeve: "ins", symbol: "KVHI", reason: "stop", exitPrice9: d9("8.5"), qty9: d9("50") });
  recordExit(db, { ts: "2026-02-01T15:00:00Z", sleeve: "mom", symbol: "OLD", reason: "rank_out", exitPrice9: d9("100"), qty9: d9("1") });

  // Week 1–3 above exit → counting; a dip resets; 4 consecutive weeks → flagged.
  let r = weeklyWatchlistCheck(db, { asOfDate: "2026-08-09", prices: new Map([["KVHI", d9("9")]]), stabilizationWeeks: 4, pruneWeeks: 26 });
  check("week 1 counted, none flagged", r.newlyFlagged.length === 0 && r.checked >= 1);
  weeklyWatchlistCheck(db, { asOfDate: "2026-08-16", prices: new Map([["KVHI", d9("9.1")]]), stabilizationWeeks: 4, pruneWeeks: 26 });
  r = weeklyWatchlistCheck(db, { asOfDate: "2026-08-23", prices: new Map([["KVHI", d9("8.2")]]), stabilizationWeeks: 4, pruneWeeks: 26 });
  check("dip resets the count", r.newlyFlagged.length === 0);
  for (const d of ["2026-08-30", "2026-09-06", "2026-09-13"]) {
    r = weeklyWatchlistCheck(db, { asOfDate: d, prices: new Map([["KVHI", d9("9")]]), stabilizationWeeks: 4, pruneWeeks: 26 });
  }
  check("3 weeks after reset: still counting", r.newlyFlagged.length === 0);
  r = weeklyWatchlistCheck(db, { asOfDate: "2026-09-20", prices: new Map([["KVHI", d9("9.2")]]), stabilizationWeeks: 4, pruneWeeks: 26 });
  check("4th consecutive week flags re-entry", r.newlyFlagged.length === 1 && r.newlyFlagged[0].symbol === "KVHI");
  check("old exit pruned at 26 weeks", r.pruned === 1 || (db.prepare("SELECT status FROM wl_exits WHERE symbol='OLD'").get() as any).status === "pruned");

  const cands = watchlistCandidates(db, "ins");
  check("candidate surfaces to owning sleeve only", cands.length === 1 && watchlistCandidates(db, "mom").length === 0);
  consumeCandidate(db, cands[0].id);
  check("consume removes candidate", watchlistCandidates(db, "ins").length === 0);

  const empty = openDb(":memory:");
  check("empty watchlist renders explicitly", renderWatchlist(empty)[0].includes("empty"));
  check("data gap holds state (no reset)", (() => {
    const db2 = openDb(":memory:");
    recordExit(db2, { ts: "2026-08-01T15:00:00Z", sleeve: "wld", symbol: "GAP", reason: "stop", exitPrice9: d9("10"), qty9: d9("1") });
    weeklyWatchlistCheck(db2, { asOfDate: "2026-08-09", prices: new Map([["GAP", d9("11")]]), stabilizationWeeks: 4, pruneWeeks: 26 });
    weeklyWatchlistCheck(db2, { asOfDate: "2026-08-16", prices: new Map(), stabilizationWeeks: 4, pruneWeeks: 26 });
    return (db2.prepare("SELECT weeks_above FROM wl_exits WHERE symbol='GAP'").get() as any).weeks_above === 1;
  })());
}

console.log("v2 surfaces — notes + chunking:");
{
  const n = tradeNote({ sleeve: "mom", symbol: "AAPL", side: "buy", intent: "buy", notional: "200", fillPrice: "231.20", thesis: "12-1 rank #4, FIP-smooth", protection: "rank-out exit" });
  check("buy note shape", n.includes("[Momentum] BUY AAPL $200 @ 231.20") && n.includes("FIP-smooth") && n.includes("rank-out exit"));
  const s = tradeNote({ sleeve: "ins", symbol: "KVHI", side: "sell", intent: "sell", qty: "50", reason: "thesis_break" });
  check("exit note uses reason", s.includes("thesis break"));
  check("escalation note points at the queue", escalationNote({ kind: "brake-tier3", title: "book −14%" }).includes("approvals queue"));
  check("skip note names the gate", skipNote("wld", "TSLA", "NO_SETTLED_CASH", "need 250 > settled 100").includes("NO_SETTLED_CASH"));

  const long = Array.from({ length: 120 }, (_, i) => `line ${i} — some digest content that is fairly long`).join("\n");
  const parts = chunkMessage(long);
  check("long message chunks under limit", parts.length > 1 && parts.every((p) => p.length <= 1900));
  check("chunking loses nothing", parts.join("\n") === long);
  check("short message single part", chunkMessage("hi").length === 1);
}

console.log("v2 surfaces — digest + statement + explains:");
{
  const db = openDb(":memory:");
  seedBook(db, "5000", "2026-08-17");
  ingestFill(db, { id: "f1", symbol: "AAPL", side: "buy", qty9: d9("10"), price9: d9("200"), ts: "2026-08-17T14:31:00Z", sleeve: "mom" });
  recordCash(db, { ts: "2026-08-17T14:31:00Z", kind: "buy", symbol: "AAPL", amount9: -d9("2000"), settlesOn: "2026-08-17", ref: "f1" });
  markEquity(db, "2026-08-17", new Map([["AAPL", d9("200")]]));
  markEquity(db, "2026-08-21", new Map([["AAPL", d9("210")]]));
  recordBench(db, "2026-08-17", "SPY", d9("500"));
  recordBench(db, "2026-08-21", "SPY", d9("505"));
  recordBench(db, "2026-08-17", "sleeve:mom", d9("2000"));
  recordBench(db, "2026-08-21", "sleeve:mom", d9("2100"));
  db.prepare("INSERT INTO approvals(ts, kind, title, payload) VALUES('2026-08-20T00:00:00Z','anchor-drift','Akre top-5 −18pp QoQ','{}')").run();
  recordExit(db, { ts: "2026-08-18T15:00:00Z", sleeve: "ins", symbol: "KVHI", reason: "stop", exitPrice9: d9("8.5"), qty9: d9("50") });

  const digest = sundayDigest(db, { asOfDate: "2026-08-23", extras: { dialLine: "caution (0.7) via LEI 08-20", brakeLine: "tier 0 · dd 0.0%", mondayQueue: ["momentum rebalance (month-end signals)"] } });
  check("digest: book week line", digest.includes("Book: $5100.00") && digest.includes("week +"), digest.split("\n")[1]);
  check("digest: sleeve vs rival", digest.includes("Momentum: week +5.00%") && digest.includes("QMOM"));
  check("digest: honest about missing sleeve marks", digest.includes("Insider: no marks yet"));
  check("digest: dial + brake lines", digest.includes("LEI dial**: caution") && digest.includes("tier 0"));
  check("digest: watchlist rendered", digest.includes("KVHI [ins] exited 2026-08-18"));
  check("digest: approvals queue", digest.includes("[anchor-drift] Akre top-5"));
  check("digest: monday queue", digest.includes("momentum rebalance"));
  check("digest: gate line honest", digest.includes("Live gate") && digest.includes("not yet green"));

  // Statement: sell half at a gain in August, then compose.
  ingestFill(db, { id: "f2", symbol: "AAPL", side: "sell", qty9: d9("4"), price9: d9("210"), ts: "2026-08-21T15:00:00Z", sleeve: "mom" });
  const st = monthlyStatement(db, "2026-08");
  check("statement: header + equity month line", st.includes("monthly statement · 2026-08") && st.includes("→ $5100.00"));
  check("statement: realized from ledger", st.includes("$40.00 economic across 1 closes"));
  check("statement: per-sleeve rows", st.includes("Momentum:") && st.includes("1 closes ($40.00)"));
  check("statement: paper-only footer", st.includes("Paper only"));

  const data = buildExplainsData(db, "2026-08-23");
  check("explains data: equity + watchlist", data.equityNow === 5100, String(data.equityNow));
  const prompt = buildExplainsPrompt(data);
  check("explains prompt: voice + honesty rails", prompt.includes("Bill the Bull") && prompt.includes("Never invent trades"));
}

console.log("v2 surfaces — discord sender path:");
{
  // Regression guard: discord.ts dynamically imports the fleet notifier by RELATIVE path, and
  // postBill's catch swallows a resolution failure — a wrong depth silenced every post from
  // launch (2026-08-18) until 2026-08-23. Resolve the specifier from the module's real location
  // and require the file to exist.
  const { readFileSync } = await import("node:fs");
  const { existsSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const discordSrcUrl = new URL("./v2/surfaces/discord.ts", import.meta.url);
  const src = readFileSync(fileURLToPath(discordSrcUrl), "utf8");
  const m = src.match(/import\("([^"]+notify-discord\.mjs)"/);
  check("discord.ts declares a notify-discord import", !!m, "specifier not found");
  if (m) {
    const resolved = fileURLToPath(new URL(m[1], discordSrcUrl));
    check("notifier specifier resolves to a real file", existsSync(resolved), resolved);
  }
}

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("v2 surfaces: all green");
