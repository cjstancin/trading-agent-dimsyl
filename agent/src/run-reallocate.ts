// Bill's REALLOCATION advisor — PROPOSE-ONLY, always. Reads the live paper book + the proposal ledger,
// scores each holding, takes candidate ideas (new names competing for a slot), and prints/posts a
// position-swap plan: when the book is full, which weak holding to swap out to fund a higher-conviction
// idea. It NEVER places, sizes, or cancels an order — placement stays in run-execute.ts (double-gated).
// This is the advisory half of the swap/reallocation feature; wiring an APPROVED swap into auto-exec is
// a deliberate, separate future task.
//
// Candidate ideas come from (in order): a `--candidates '<json>'` CLI arg, else Signals/realloc-candidates.json.
// Shape: [{ "symbol": "NVDA", "conviction": 85, "thesis": "…", "setup": "momentum breakout" }, …]
import "./load-env.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { paperSnapshot } from "./alpaca.js";
import { rulesFor } from "./guardrails.js";
import { getProfile } from "./profile.js";
import { getMode } from "./mode.js";
import { readLedger } from "./ledger.js";
import { planReallocation, type Holding, type Candidate } from "./reallocate.js";

const { sendDiscord } = await import("../../scripts/notify-discord.mjs" as string);

const CANDIDATES_FILE = fileURLToPath(new URL("../../Signals/realloc-candidates.json", import.meta.url));
const PENDING = fileURLToPath(new URL("../../memory/pending-reallocation.md", import.meta.url));

const mode = getMode();
if (mode === "off") {
  console.log(JSON.stringify({ ok: true, skipped: true, reason: "mode=off" }));
  process.exit(0);
}

// Resolve candidate ideas: CLI arg wins, else the candidates file, else none.
function loadCandidates(): Candidate[] {
  const argIdx = process.argv.indexOf("--candidates");
  const raw = argIdx >= 0 ? process.argv[argIdx + 1] : (existsSync(CANDIDATES_FILE) ? readFileSync(CANDIDATES_FILE, "utf8") : "");
  if (!raw || !raw.trim()) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((c) => c && typeof c.symbol === "string" && Number.isFinite(Number(c.conviction)))
      .map((c) => ({ symbol: String(c.symbol).toUpperCase(), conviction: Number(c.conviction), thesis: c.thesis, setup: c.setup }));
  } catch { return []; }
}

const candidates = loadCandidates();

const snap = await paperSnapshot();
if (!snap.connected) {
  console.error(JSON.stringify({ ok: false, reason: "Alpaca not reachable (keys/endpoint)", error: snap.error }));
  process.exit(1);
}

const positions = (Array.isArray(snap.positions) ? snap.positions : []) as Array<Record<string, unknown>>;
const ledger = readLedger();

// A holding's strength score = the conviction of its most recent ledger proposal (if any). The planner
// falls back to a P&L-derived proxy when a position has no ledger record (e.g. a manual/backfilled buy).
const lastConfidence = (sym: string): number | undefined => {
  for (let i = ledger.length - 1; i >= 0; i--) {
    const r = ledger[i];
    if (r.symbol === sym && typeof r.confidence === "number") return r.confidence;
  }
  return undefined;
};

const holdings: Holding[] = positions.map((p) => ({
  symbol: String(p.symbol),
  marketValue: Number(p.market_value ?? 0),
  unrealizedPlPct: Number(p.unrealized_plpc ?? 0),
  score: lastConfidence(String(p.symbol)),
}));

const rules = rulesFor(getProfile());
const plan = planReallocation(holdings, candidates, { maxOpen: rules.maxOpen });

const lines = [
  `🔁 **Bill the Bull — reallocation plan · ${rules.name}** (advisory · propose-only)`,
  ...plan.notes.map((n) => `• ${n}`),
  ...(plan.swaps.length
    ? ["", "**Proposed swaps:**", ...plan.swaps.map((s) => `  ↪ SELL ${s.sell.symbol} (strength ${s.sell.score}) → BUY ${s.buy.symbol} (conv ${s.buy.conviction}, +${s.edge} edge)${s.buy.setup ? ` · ${s.buy.setup}` : ""}`)]
    : []),
];
const body = lines.join("\n");

writeFileSync(PENDING, `# Pending reallocation — ${new Date().toISOString()} (advisory · propose-only)\n\n${body}\n`);

// Only ping Discord when there's an actual swap to act on — advisory "no change" runs stay quiet.
if (plan.swaps.length) {
  await sendDiscord(body.slice(0, 1990), { channel: "bull", username: "Bill the Bull" });
}

console.log(JSON.stringify({
  ok: true,
  mode,
  profile: rules.name,
  needed: plan.needed,
  holdings: holdings.length,
  candidates: candidates.length,
  swaps: plan.swaps,
  skipped: plan.skipped,
  notes: plan.notes,
}, null, 2));
