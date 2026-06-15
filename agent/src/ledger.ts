// Decision/proposal ledger — the keystone (Bull v2 #1). Every proposal Bill makes is appended here as
// one JSON object per line (JSONL). Later, reconcile() back-fills each record's outcome from Alpaca
// fills/closes. This is the memory the stats panel, trade journal, confidence scores, and the paper→live
// readiness gate all read from. Append-only; safe to grow indefinitely.
import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const LEDGER = fileURLToPath(new URL("../../memory/ledger.jsonl", import.meta.url));

export interface ProposalRecord {
  ts: string;                 // ISO timestamp of the proposal
  cycle: string;              // YYYY-MM-DD of the cycle
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  est_price: number;
  trail_percent?: number | null;
  thesis?: string;
  profile: string;            // aggressive | steady (active rulebook)
  mode: string;               // gated | auto
  status: "proposed" | "placed" | "rejected";
  reasons?: string[];         // guardrail failures, if rejected
  confidence?: number | null; // 0–100 (Bull v2 #5; null until wired)
  setup?: string | null;      // setup label (Bull v2 #5; null until wired)
  // Filled later by reconcile() against Alpaca activity:
  outcome?: "open" | "win" | "loss" | "expired" | "unknown";
  realizedPnlUsd?: number | null;
  rMultiple?: number | null;
}

/** Append a batch of proposal records (one JSON line each). No-op on empty. */
export function appendProposals(records: ProposalRecord[]): void {
  if (!records || !records.length) return;
  appendFileSync(LEDGER, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

/** Rewrite the whole ledger (used by reconcile() to back-fill outcomes). */
export function updateLedger(records: ProposalRecord[]): void {
  writeFileSync(LEDGER, records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : ""));
}

/** Read the full ledger (skips any corrupt lines). */
export function readLedger(): ProposalRecord[] {
  if (!existsSync(LEDGER)) return [];
  return readFileSync(LEDGER, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l) as ProposalRecord; } catch { return null; } })
    .filter((x): x is ProposalRecord => x !== null);
}
