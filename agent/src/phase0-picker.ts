// Phase 0 LLM edge test — does Sonnet 4.6's stock-picking beat mechanical momentum, and how much
// of its in-cutoff (IN, 2024-01..2025-06) performance is memorization vs the clean OOS window
// (2026-02+, past its Jan 2026 training cutoff)? Runs every prompt in backtest/phase0/out/prompts.jsonl
// through a one-shot SDK call and appends {date, window, ranking, ...} lines to picks.jsonl.
//
// AUTH RULE: Phase 0 runs ~95 one-shot calls; they must ride CJ's Claude Max subscription via the
// Claude Code login, never the metered API key that Bull's .env sets for other purposes. So: no
// load-env.ts, no .env reads, and the key is deleted from the environment before any SDK call.
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

delete process.env.ANTHROPIC_API_KEY; // Max subscription only — never the metered API key.

const OUT_DIR = fileURLToPath(new URL("../../backtest/phase0/out/", import.meta.url));
const PROMPTS_PATH = join(OUT_DIR, "prompts.jsonl");
const PICKS_PATH = join(OUT_DIR, "picks.jsonl");

const MODEL = process.env.PHASE0_MODEL || "claude-sonnet-4-6";
const SYSTEM_PROMPT = "You are a quantitative equity analyst. Respond with only valid JSON.";
const CONCURRENCY = 3;
const MAX_RETRIES = 2; // retries after the first attempt (3 attempts total)
const RETRY_SUFFIX =
  "\n\nYour previous reply was not a valid JSON ranking of all 18 tickers. Reply with ONLY the JSON object.";

// Same order as gen_prompts.py / backtest.py — validation set for the model's ranking.
const UNIVERSE = [
  "AAPL", "MSFT", "NVDA", "GOOGL", "META", "AMZN", "HD", "JPM", "V",
  "XOM", "CVX", "UNH", "JNJ", "PG", "KO", "WMT", "CAT", "BA",
];

interface PromptLine { date: string; window: "IN" | "OOS"; prompt: string }
interface PickLine {
  date: string;
  window: "IN" | "OOS";
  ranking: string[] | null;
  rationale: string | null;
  model: string;
  costUsd: number;
  numTurns: number;
  promptSha: string; // hash of the exact prompt this pick answered — guards resume against regenerated prompts
  error: string | null;
}

const promptSha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 12);

// Extract first-{ .. last-} substring, parse, and validate an exact permutation of the universe.
function parseRanking(text: string): { ranking: string[]; rationale: string } {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object found in reply");
  const obj = JSON.parse(text.slice(start, end + 1)) as { ranking?: unknown; rationale?: unknown };
  if (!Array.isArray(obj.ranking) || obj.ranking.length !== UNIVERSE.length) {
    throw new Error(`ranking is not an array of exactly ${UNIVERSE.length} tickers`);
  }
  const ranking = obj.ranking.map((t) => String(t).trim().toUpperCase());
  if (!isPermutationOfUniverse(ranking)) throw new Error("ranking is not a permutation of the 18-ticker universe");
  return { ranking, rationale: typeof obj.rationale === "string" ? obj.rationale : "" };
}

function isPermutationOfUniverse(ranking: unknown): boolean {
  if (!Array.isArray(ranking) || ranking.length !== UNIVERSE.length) return false;
  const seen = new Set(ranking.map((t) => String(t).trim().toUpperCase()));
  return seen.size === UNIVERSE.length && UNIVERSE.every((t) => seen.has(t));
}

async function callModel(prompt: string): Promise<{ text: string; costUsd: number; numTurns: number; sdkError: string | null }> {
  const options: Options = {
    model: MODEL,
    systemPrompt: SYSTEM_PROMPT,
    allowedTools: [],
    maxTurns: 1,
    settingSources: [],
    cwd: OUT_DIR,
  };
  let text = "";
  let costUsd = 0;
  let numTurns = 0;
  let sdkError: string | null = null;
  for await (const message of query({ prompt, options })) {
    if (message.type === "result") {
      costUsd = message.total_cost_usd ?? 0;
      numTurns = message.num_turns ?? 0;
      if (message.subtype === "success") text = message.result ?? "";
      else sdkError = `agent ended without success: ${message.subtype}`;
    }
  }
  return { text, costUsd, numTurns, sdkError }; // never throws for SDK failures — cost must survive
}

// One prompt end-to-end: attempt + up to MAX_RETRIES corrective retries. Cost accumulates
// across ALL attempts (including SDK-errored ones) so the ledger reflects true spend.
async function runPrompt(p: PromptLine): Promise<PickLine> {
  const sha = promptSha(p.prompt);
  let costUsd = 0;
  let lastError = "unknown error";
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const prompt = attempt === 0 ? p.prompt : p.prompt + RETRY_SUFFIX;
    try {
      const r = await callModel(prompt);
      costUsd += r.costUsd;
      if (r.sdkError) {
        lastError = r.sdkError;
        continue;
      }
      const { ranking, rationale } = parseRanking(r.text);
      return { date: p.date, window: p.window, ranking, rationale, model: MODEL, costUsd, numTurns: r.numTurns, promptSha: sha, error: null };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e); // parse failure or query() spawn error
    }
  }
  return { date: p.date, window: p.window, ranking: null, rationale: null, model: MODEL, costUsd, numTurns: 0, promptSha: sha, error: lastError };
}

function loadJsonl<T>(path: string): T[] {
  const out: T[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { out.push(JSON.parse(trimmed) as T); } catch { /* partial/corrupt line (crash mid-write) — redo it */ }
  }
  return out;
}

async function main(): Promise<void> {
  const t0 = Date.now();
  if (!existsSync(PROMPTS_PATH)) {
    console.error(`prompts.jsonl not found at ${PROMPTS_PATH} — run backtest/phase0/gen_prompts.py first.`);
    process.exit(1);
  }
  const prompts = loadJsonl<PromptLine>(PROMPTS_PATH);

  // RESUMABLE: skip a date only if its good line (error==null + valid ranking) was produced from
  // the CURRENT prompt text — a regenerated prompts.jsonl (new windows/features/data) must re-run,
  // never silently reuse picks made from an older prompt version.
  const curSha = new Map(prompts.map((p) => [p.date, promptSha(p.prompt)]));
  const havePick = new Set<string>();
  let staleCount = 0;
  if (existsSync(PICKS_PATH)) {
    for (const line of loadJsonl<PickLine>(PICKS_PATH)) {
      if (line.error !== null || !isPermutationOfUniverse(line.ranking)) continue;
      if (line.promptSha === curSha.get(line.date)) havePick.add(line.date);
      else staleCount++;
    }
  }
  if (staleCount > 0) {
    console.log(`WARNING: ${staleCount} existing pick(s) were made from a DIFFERENT prompt version (prompts.jsonl regenerated?) — re-running those dates.`);
  }
  const todo = prompts.filter((p) => !havePick.has(p.date));
  console.log(`phase0-picker: ${prompts.length} prompts, ${havePick.size} already done, ${todo.length} to run (model ${MODEL}, pool ${CONCURRENCY})`);
  if (todo.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  let done = 0;
  let okCount = 0;
  let errCount = 0;
  let totalCost = 0;

  // Simple async pool: CONCURRENCY workers pull from a shared cursor, append each result immediately.
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= todo.length) return;
      const result = await runPrompt(todo[i]);
      appendFileSync(PICKS_PATH, JSON.stringify(result) + "\n", "utf8"); // crash-safe: one line per completion
      done++;
      totalCost += result.costUsd;
      if (result.error === null) {
        okCount++;
        console.log(`[${done}/${todo.length}] ${result.date} ${result.window} ok (cost $${result.costUsd.toFixed(4)})`);
      } else {
        errCount++;
        console.log(`[${done}/${todo.length}] ${result.date} ${result.window} ERROR: ${result.error}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));

  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  console.log(`\nDone: ${okCount} ok, ${errCount} errors, total cost $${totalCost.toFixed(4)}, elapsed ${mins} min.`);
  console.log(`Picks: ${PICKS_PATH}`);
  if (errCount > 0) process.exit(1);
}

main().catch((e) => {
  console.error("phase0-picker fatal:", e instanceof Error ? e.message : e);
  process.exit(1);
});
