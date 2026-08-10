// Offline tests — v2 journaled config store. Reads the committed defaults; journal via temp file.
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, foldConfig, parseJournal, isNonTunable, appendAmendment, scheduleLookup, getPath, DEFAULTS_PATH } from "./v2/config.js";
import { readFileSync } from "node:fs";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${detail}`); }
}

console.log("v2 config:");

// Defaults load + carry the design-doc numbers.
const eff = loadConfig(DEFAULTS_PATH, join(tmpdir(), "nonexistent-journal.jsonl"));
check("defaults parse", !!eff.config.book);
check("version format", /^v2c-[0-9a-f]{8}\+0$/.test(eff.version), eff.version);
check("sleeve split is 40/25/25/10", eff.config.book.sleeveSplit.mom === 0.4 && eff.config.book.sleeveSplit.wld === 0.1);
check("brake tiers 8/11/14", eff.config.book.brake.tiers.map((t: any) => t.ddPct).join(",") === "8,11,14");
check("LEI dial 100/70/55 on mom+wld", eff.config.book.leiDial.stages.pullback === 0.55 && eff.config.book.leiDial.appliesTo.join(",") === "mom,wld");
check("insider cluster 3×10d×$10k/$100k", eff.config.insider.cluster.minInsiders === 3 && eff.config.insider.cluster.windowDays === 10);
check("anchor = the locked four managers", eff.config.anchor.managers.length === 4 && eff.config.anchor.managers[0].name.includes("Berkshire"));
check("thesis floor −25", eff.config.thesisCheck.hardFloorPct === -25);
check("blacklist 31d", eff.config.ledger.washBlacklistDays === 31);

// Fold + version bump.
const raw = readFileSync(DEFAULTS_PATH, "utf8");
const amended = foldConfig(JSON.parse(raw), [
  { ts: "2026-08-11T00:00:00Z", author: "cj", path: "momentum.holdings.minOrderUsd", from: 25, to: 30 },
], raw);
check("amendment applied", amended.config.momentum.holdings.minOrderUsd === 30);
check("version counts journal", amended.version.endsWith("+1"));
check("defaults object untouched elsewhere", amended.config.momentum.holdings.weightBandRel === 0.25);

// Non-tunables refused (defense rail).
check("hard floor is non-tunable", isNonTunable("thesisCheck.hardFloorPct"));
check("sleeve split is non-tunable", isNonTunable("book.sleeveSplit.mom"));
check("normal dial is tunable", !isNonTunable("momentum.holdings.minOrderUsd"));
let threw = false;
try {
  foldConfig(JSON.parse(raw), [{ ts: "t", author: "x", path: "thesisCheck.hardFloorPct", from: -25, to: -50 }], raw);
} catch { threw = true; }
check("folding a non-tunable amendment throws", threw);

// Journal parse: malformed line throws (never silently dropped).
threw = false;
try { parseJournal('{"ts":"t","author":"cj","path":"a.b"}'); } catch { threw = true; }
check("malformed journal line throws", threw);
check("blank lines skipped", parseJournal("\n\n").length === 0);

// appendAmendment + reload round-trip via temp journal.
const dir = mkdtempSync(join(tmpdir(), "v2cfg-"));
const jp = join(dir, "journal.jsonl");
appendAmendment({ ts: "2026-08-11T00:00:00Z", author: "cj", path: "wildcard.minHoldWeeks", from: 4, to: 5, evidence: "test" }, jp);
const eff2 = loadConfig(DEFAULTS_PATH, jp);
check("appended amendment folds on reload", eff2.config.wildcard.minHoldWeeks === 5 && eff2.version.endsWith("+1"));
threw = false;
try { appendAmendment({ ts: "t", author: "cj", path: "book.sleeveSplit.mom", from: 0.4, to: 0.5 }, jp); } catch { threw = true; }
check("append refuses non-tunable", threw);
rmSync(dir, { recursive: true, force: true });

// Equity-indexed schedule lookup (living-design rule).
const sched = eff.config.momentum.holdings.nSchedule as { sleeveUsdBelow: number | null; n: number }[];
check("N=10 below $4k", scheduleLookup(sched, 2000).n === 10);
check("N=15 at $4–8k", scheduleLookup(sched, 5000).n === 15);
check("N=20 at $8–20k", scheduleLookup(sched, 12000).n === 20);
check("N=50 above", scheduleLookup(sched, 50000).n === 50);
check("getPath helper", getPath(eff.config, "book.sweep.etf") === "SGOV");

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("v2 config: all green");
