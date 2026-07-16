// Bill — paper trading specialist. Claude Agent SDK runtime (same template as Go's agent.ts).
// Loads Bill's rulebook (Trading-Agent/CLAUDE.md) as the brain, runs headless, READ-ONLY tool belt.
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getMode } from "./mode.js";
import { emitCost, ritualTask } from "./fleet-emit.js";
import { loadAibrainContext } from "./aibrain-context.js";

// src -> agent -> Trading-Agent. cwd = Trading-Agent so the agent can read memory/, Signals/, dashboard/.
const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BRAIN = fileURLToPath(new URL("../../CLAUDE.md", import.meta.url));

function runtimeOverride(): string {
  const mode = getMode();
  return `
=== RUNTIME OVERRIDE (highest priority) ===
You have NO order, shell, or execution tools — you analyze and write text/notes only. You NEVER place,
modify, cancel, or close a position yourself, and never claim you did. Any actual order placement is done
by the orchestrating script, deterministically, AFTER your output, and only in the mode below.

CURRENT MODE: ${mode}
- off   → take no action; produce nothing actionable.
- gated → you PROPOSE trades (with sizing + stop per the rulebook) for CJ to approve. Nothing executes.
- auto  → you still only PROPOSE; the script validates against the rulebook limits and places PAPER orders.
Paper account data is given to you read-only. Paper only — never reference a live endpoint.`;
}

export function loadBillBrain(): string {
  return readFileSync(BRAIN, "utf8").trim() + "\n" + runtimeOverride();
}

export interface RunResult {
  text: string;
  costUsd: number;
  isError: boolean;
  numTurns: number;
  model: string;        // model id the run used (fleet cost ledger)
  inputTokens: number;  // input-side tokens incl. cache creation/read (fleet cost ledger)
  outputTokens: number;
}

export async function runAgent(prompt: string, overrides: Partial<Options> = {}): Promise<RunResult> {
  const context = loadAibrainContext(prompt);
  const options: Options = {
    systemPrompt: { type: "preset", preset: "claude_code", append: [loadBillBrain(), context].filter(Boolean).join("\n\n") },
    model: process.env.AGENT_MODEL || "claude-sonnet-4-6",
    cwd: PROJECT_ROOT,
    permissionMode: "bypassPermissions",
    // READ-ONLY belt: no Bash, no order tools. Writes limited to journals/notes the agent is told to update.
    allowedTools: ["Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "WebFetch"],
    settingSources: [],
    ...overrides,
  };

  let text = "";
  let costUsd = 0;
  let numTurns = 0;
  let isError = false;
  let inputTokens = 0;
  let outputTokens = 0;
  const model = String(options.model ?? "unknown");

  for await (const message of query({ prompt, options })) {
    if (message.type === "result") {
      costUsd = message.total_cost_usd ?? 0;
      numTurns = message.num_turns ?? 0;
      // Token usage for the fleet cost ledger. Defensive: usage shape varies across SDK versions.
      const u = (message as { usage?: Record<string, unknown> }).usage ?? {};
      const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
      inputTokens = n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens);
      outputTokens = n(u.output_tokens);
      if (message.subtype === "success") {
        text = message.result ?? "";
      } else {
        isError = true;
        text = `Agent ended without success: ${message.subtype}`;
      }
    }
  }

  // Fleet cost ledger: EVERY LLM ritual's spend → conductor POST /cost (one central hook covers all
  // run-* scripts; task inferred from the entry script name). Best-effort — emitCost never throws and
  // silently no-ops without SAMS_CONTROL_TOKEN, so the ledger can never break a ritual.
  await emitCost({ model, inputTokens, outputTokens, costUsd, task: ritualTask() });

  return { text, costUsd, isError, numTurns, model, inputTokens, outputTokens };
}
