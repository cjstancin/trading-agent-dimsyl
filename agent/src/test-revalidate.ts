// SUCCESS / FAIL / NULL tests for the thesis re-validation helpers (no network, no orders).
// Run: npm run test:revalidate
// Invariants under test: verdicts parse + normalize; the position's OWN ledger entry + per-symbol history
// are injected into the prompt; a "broken" verdict yields an EXIT proposal that is sized DETERMINISTICALLY
// (full qty, never a model number) and routes through validateOrders (never a direct order — only sells can
// even exist here); and placement stays behind the mode double-gate (auto + BILL_ALLOW_AUTO_EXEC).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildPositionContexts, buildRevalidatePrompt, parseVerdicts, verdictsToOrders,
  renderThesisHealthFooter, DEFAULT_REVALIDATE, type RevalidationVerdict,
} from "./revalidate.js";
import { validateOrders, AGGRESSIVE_PAPER } from "./guardrails.js";
import { autoExecAllowed } from "./mode.js";
import type { ProposalRecord } from "./ledger.js";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean) => { (cond ? pass++ : fail++); console.log(`${cond ? "PASS" : "FAIL"} — ${name}`); };

// A live book: NVDA carries a ledger entry record; ORPH is an orphan (no ledger record).
const rawPositions = [
  { symbol: "NVDA", qty: 1.5, avg_entry_price: 900, current_price: 870, unrealized_plpc: -0.0333, market_value: 1305 },
  { symbol: "MU",   qty: 10,  avg_entry_price: 100, current_price: 118, unrealized_plpc: 0.18,    market_value: 1180 },
  { symbol: "ORPH", qty: 2,   avg_entry_price: 50,  current_price: 51,  unrealized_plpc: 0.02,    market_value: 102 },
];
const ledger: ProposalRecord[] = [
  // MU: one CLOSED loss (per-symbol history) + the current open entry.
  { ts: "2026-06-01T14:00:00Z", cycle: "2026-06-01", symbol: "MU", side: "buy", qty: 5, est_price: 95, profile: "aggressive", mode: "auto", status: "placed", setup: "failed-breakout", confidence: 70, outcome: "loss", realizedPnlUsd: -120, rMultiple: -1.2 },
  { ts: "2026-06-28T14:00:00Z", cycle: "2026-06-28", symbol: "MU", side: "buy", qty: 10, est_price: 100, profile: "aggressive", mode: "auto", status: "placed", thesis: "HBM supply crunch pricing power", setup: "catalyst", confidence: 74, outcome: "open" },
  // NVDA: a REJECTED record (must be ignored) then the real entry (must win as the "original thesis").
  { ts: "2026-07-01T13:00:00Z", cycle: "2026-07-01", symbol: "NVDA", side: "buy", qty: 1, est_price: 880, profile: "aggressive", mode: "auto", status: "rejected", thesis: "rejected thesis", outcome: "open" },
  { ts: "2026-07-02T13:31:00Z", cycle: "2026-07-02", symbol: "NVDA", side: "buy", qty: 1.5, est_price: 900, profile: "aggressive", mode: "auto", status: "placed", thesis: "AI capex supercycle re-acceleration", setup: "momentum breakout", confidence: 85, outcome: "open" },
];

// ── buildPositionContexts: joins each position with its OWN entry record from the ledger ──
const contexts = buildPositionContexts(rawPositions, ledger);
{
  const nvda = contexts.find((c) => c.symbol === "NVDA");
  check("CONTEXT: joins the most recent non-rejected buy (thesis/conv/setup/date)",
    nvda?.thesis === "AI capex supercycle re-acceleration" && nvda?.confidence === 85 && nvda?.setup === "momentum breakout" && nvda?.entryDate === "2026-07-02");
  const orph = contexts.find((c) => c.symbol === "ORPH");
  check("CONTEXT: a position with no ledger record still gets a context (null thesis)", !!orph && orph.thesis === null && orph.qty === 2);
  check("CONTEXT: zero-qty / blank-symbol rows dropped", buildPositionContexts([{ symbol: "", qty: 1 }, { symbol: "X", qty: 0 }], []).length === 0);
}

// ── buildRevalidatePrompt: entry thesis + per-symbol history injected; token-lean (no raw JSON blobs) ──
{
  const prompt = buildRevalidatePrompt(contexts, ledger, "SPY $600 above rising 200-DMA (risk-on)");
  check("PROMPT: the position's ORIGINAL ledger thesis is injected", prompt.includes("AI capex supercycle re-acceleration"));
  check("PROMPT: per-symbol closed-trade history is injected (MU prior loss)", /YOUR HISTORY ON THESE NAMES/.test(prompt) && /MU: 1 trade/.test(prompt) && /0W\/1L/.test(prompt));
  check("PROMPT: computed regime line is injected", prompt.includes("risk-on"));
  check("PROMPT: token-lean — no raw Alpaca JSON keys", !prompt.includes("unrealized_plpc") && !prompt.includes("avg_entry_price"));
  check("PROMPT: propose-only framing (judge, don't place)", /place no orders/i.test(prompt));
}

// ── parseVerdicts: valid / weakening / broken from sample output, synonyms normalized ──
{
  const v = parseVerdicts(`Here you go:\n[
    {"symbol":"nvda","verdict":"still-valid","action":"hold","reason":"capex intact"},
    {"symbol":"MU","verdict":"WEAKENING","action":"trim","reason":"HBM pop priced in"},
    {"symbol":"ORPH","verdict":"broken","reason":"guidance cut"},
    {"symbol":"BAD","verdict":"sideways"},
    {"verdict":"broken"}
  ]`);
  check("PARSE: three well-formed verdicts survive, malformed dropped", v.length === 3);
  check("PARSE: 'still-valid' normalizes to valid (symbol upper-cased)", v[0].symbol === "NVDA" && v[0].verdict === "valid" && v[0].action === "hold");
  check("PARSE: weakening + trim parsed", v[1].verdict === "weakening" && v[1].action === "trim");
  check("PARSE: broken with MISSING action defaults to a (gated) exit", v[2].verdict === "broken" && v[2].action === "exit");
  check("PARSE: junk → []", parseVerdicts("no json here").length === 0);
  check("PARSE: 'liquidate' action normalizes to exit", parseVerdicts('[{"symbol":"A","verdict":"broken","action":"liquidate"}]')[0]?.action === "exit");
}

// ── verdictsToOrders: DETERMINISTIC sizing; sells only; routed through validateOrders ──
const verdicts: RevalidationVerdict[] = [
  { symbol: "NVDA", verdict: "valid", action: "hold", reason: "intact" },
  { symbol: "MU", verdict: "weakening", action: "trim", reason: "priced in" },
  { symbol: "ORPH", verdict: "broken", action: "exit", reason: "guidance cut" },
];
{
  const items = verdictsToOrders(verdicts, contexts);
  check("ORDERS: valid → no order; weakening-trim + broken-exit → two proposals", items.length === 2);
  const trim = items.find((i) => i.kind === "trim");
  const exit = items.find((i) => i.kind === "exit");
  check("ORDERS: broken → EXIT sized deterministically at the FULL held qty", exit?.order.symbol === "ORPH" && exit?.order.qty === 2 && exit?.order.side === "sell");
  check("ORDERS: weakening → TRIM sized deterministically at the fixed fraction (never model-sized)",
    trim?.order.symbol === "MU" && trim?.order.qty === 10 * DEFAULT_REVALIDATE.trimFraction);
  check("ORDERS: only SELLs can ever originate here", items.every((i) => i.order.side === "sell"));
  check("ORDERS: est_price grounded in the live position price", exit?.order.est_price === 51 && trim?.order.est_price === 118);

  // The exit proposal ROUTES THROUGH validateOrders — the same gate machinery as every ritual.
  const checked = validateOrders(items.map((i) => i.order), { equity: 10_000, openCount: 3 }, AGGRESSIVE_PAPER);
  check("GATE: revalidation sells pass validateOrders (not a direct order path)", checked.every((c) => c.ok));
  // And a bogus one is REJECTED by the same gate (price feed dead → est_price 0 → guardrails refuse it).
  const deadCtx = [{ ...contexts.find((c) => c.symbol === "ORPH")!, current: 0 }];
  const dead = verdictsToOrders([{ symbol: "ORPH", verdict: "broken", action: "exit", reason: "x" }], deadCtx);
  const deadChecked = validateOrders(dead.map((i) => i.order), { equity: 10_000, openCount: 1 }, AGGRESSIVE_PAPER);
  check("GATE: a malformed revalidation sell is rejected by validateOrders", dead.length === 1 && deadChecked[0].ok === false);
}
{
  // Safety edges: a stray trim/exit on a VALID thesis is ignored; a hallucinated symbol sells nothing;
  // an explicit hold on a broken thesis is respected; whole-share profiles floor the trim qty.
  check("SAFE: a stray exit action on a VALID verdict is ignored",
    verdictsToOrders([{ symbol: "MU", verdict: "valid", action: "exit", reason: "" }], contexts).length === 0);
  check("SAFE: a verdict on a symbol NOT in the book emits nothing",
    verdictsToOrders([{ symbol: "GHOST", verdict: "broken", action: "exit", reason: "" }], contexts).length === 0);
  check("SAFE: an explicit hold on a broken thesis emits nothing",
    verdictsToOrders([{ symbol: "ORPH", verdict: "broken", action: "hold", reason: "" }], contexts).length === 0);
  check("SAFE: whole-share profile floors the trim qty",
    verdictsToOrders([{ symbol: "NVDA", verdict: "weakening", action: "trim", reason: "" }], contexts, DEFAULT_REVALIDATE, false).length === 0 /* 1.5 × 0.5 = 0.75 → floor 0 → no order */);
}

// ── Mode double-gate: the REAL machinery run-revalidate uses (autoExecAllowed) ──
{
  const saved = { m: process.env.BILL_MODE, e: process.env.BILL_ALLOW_AUTO_EXEC };
  process.env.BILL_MODE = "gated"; delete process.env.BILL_ALLOW_AUTO_EXEC;
  check("MODE: gated → propose-only (autoExecAllowed=false)", autoExecAllowed() === false);
  process.env.BILL_MODE = "auto";
  check("MODE: auto WITHOUT env opt-in → still propose-only", autoExecAllowed() === false);
  process.env.BILL_ALLOW_AUTO_EXEC = "1";
  check("MODE: auto + BILL_ALLOW_AUTO_EXEC=1 → placement allowed (double gate)", autoExecAllowed() === true);
  if (saved.m === undefined) delete process.env.BILL_MODE; else process.env.BILL_MODE = saved.m;
  if (saved.e === undefined) delete process.env.BILL_ALLOW_AUTO_EXEC; else process.env.BILL_ALLOW_AUTO_EXEC = saved.e;
}

// ── Source-level invariants: the ritual never imports a direct-placement path for entries, always gates ──
{
  const src = readFileSync(fileURLToPath(new URL("./run-revalidate.ts", import.meta.url)), "utf8");
  check("SOURCE: run-revalidate never imports placePaperOrder (no buys, no direct entry orders)", !src.includes("placePaperOrder"));
  check("SOURCE: run-revalidate routes proposals through validateOrders", src.includes("validateOrders("));
  check("SOURCE: run-revalidate placement is behind the auto + env double gate", src.includes('mode === "auto" && autoExecAllowed()'));
}

// ── Footer render ──
{
  const f = renderThesisHealthFooter([
    { symbol: "A", verdict: "valid" }, { symbol: "B", verdict: "valid" },
    { symbol: "MU", verdict: "weakening" }, { symbol: "XYZ", verdict: "broken" },
  ]);
  check("FOOTER: counts + names non-valid theses", /2 ✅ valid/.test(f) && /1 ⚠️ weakening \(MU\)/.test(f) && /1 🛑 broken \(XYZ\)/.test(f));
  check("FOOTER: no verdicts → '' (fresh/flat book adds nothing)", renderThesisHealthFooter([]) === "");
}

// NULL: empty inputs never throw.
check("NULL: empty positions/ledger → empty contexts", buildPositionContexts([], []).length === 0);
check("NULL: no verdicts → no orders", verdictsToOrders([], contexts).length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
