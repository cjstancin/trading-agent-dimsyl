// Open-position THESIS RE-VALIDATION — PURE helpers (no network, no orders, no file I/O).
// Closes the mechanical-only review gap: open positions get synthetic stops, rank/reallocate and the
// profit-trim, but nothing periodically re-judged whether the ORIGINAL entry thesis still holds against
// fresh fundamentals/news. This module powers run-revalidate.ts, which — on its own timer — shows the
// model each open position's OWN entry record (thesis/conviction/setup from the ledger) plus Bill's
// per-symbol closed-trade history (symbol-record.ts) and asks for a verdict: valid / weakening / broken.
//
// PROPOSE-ONLY + DETERMINISTIC by design, honoring the hard rails:
//   • The model only returns VERDICTS + a suggested action (hold / trim / exit). It never sizes anything.
//   • verdictsToOrders() sizes any resulting SELL deterministically in CODE: exit = the full held qty,
//     trim = a FIXED fraction (DEFAULT_REVALIDATE.trimFraction) of the held qty — never a model number.
//   • A "valid" verdict NEVER produces an order, whatever action the model suggested (no churn).
//   • Only SELLs can originate here (de-risking). A buy can never be emitted from a revalidation verdict.
//   • Every emitted order still goes through validateOrders() + the mode gate (gated → Discord proposal;
//     auto → only with BILL_ALLOW_AUTO_EXEC=1) in run-revalidate.ts — same machinery as every ritual.
import type { OrderRequest } from "./alpaca.js";
import type { ProposalRecord } from "./ledger.js";
import { renderProposedSymbolHistory, type SymbolTrade } from "./symbol-record.js";

export type ThesisVerdict = "valid" | "weakening" | "broken";
export type ThesisAction = "hold" | "trim" | "exit";

/** Compact context for ONE open position — the position joined with its own entry record from the ledger. */
export interface PositionContext {
  symbol: string;
  qty: number;
  entry: number;            // avg entry price (Alpaca avg_entry_price)
  current: number;          // current price (Alpaca current_price)
  unrealizedPlPct: number;  // fraction, e.g. -0.12 for -12% (Alpaca unrealized_plpc)
  marketValue: number;
  entryDate: string | null; // YYYY-MM-DD of the entry proposal (ledger), null if no record
  thesis: string | null;    // the ORIGINAL thesis Bill bought on (ledger), null if no record
  setup: string | null;     // setup tag at entry (ledger)
  confidence: number | null; // 0-100 conviction at entry (ledger)
}

export interface RevalidationVerdict {
  symbol: string;
  verdict: ThesisVerdict;
  action: ThesisAction;     // suggested only — sizing is deterministic, placement is gated
  reason: string;
}

export interface RevalidateConfig {
  trimFraction: number;     // deterministic fraction of the held qty sold on a "trim" action
}
// Half on a trim: decisive de-risking without fully cutting a name whose thesis merely weakened.
export const DEFAULT_REVALIDATE: RevalidateConfig = { trimFraction: 0.5 };

const num = (v: unknown): number => { const x = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN; return Number.isFinite(x) ? x : 0; };
const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/**
 * Join the live Alpaca positions with each name's OWN entry record from the ledger: the most recent
 * non-rejected BUY proposal for that symbol supplies the original thesis / conviction / setup / date.
 * Positions with no ledger record (e.g. manual buys) still get a context with null thesis fields —
 * the prompt tells the model to reconstruct the likely thesis in that case. Pure.
 */
export function buildPositionContexts(
  rawPositions: Array<Record<string, unknown>>,
  ledger: ProposalRecord[],
): PositionContext[] {
  const lastBuy = (sym: string): ProposalRecord | null => {
    for (let i = (ledger ?? []).length - 1; i >= 0; i--) {
      const r = ledger[i];
      if (r && String(r.symbol).toUpperCase() === sym && r.side === "buy" && r.status !== "rejected") return r;
    }
    return null;
  };
  return (rawPositions ?? [])
    .map((p) => {
      const symbol = String(p.symbol ?? "").trim().toUpperCase();
      const rec = symbol ? lastBuy(symbol) : null;
      return {
        symbol,
        qty: num(p.qty),
        entry: num(p.avg_entry_price),
        current: num(p.current_price),
        unrealizedPlPct: num(p.unrealized_plpc),
        marketValue: num(p.market_value),
        entryDate: rec ? String(rec.ts).slice(0, 10) : null,
        thesis: rec?.thesis ? String(rec.thesis) : null,
        setup: rec?.setup ? String(rec.setup) : null,
        confidence: typeof rec?.confidence === "number" && Number.isFinite(rec.confidence) ? rec.confidence : null,
      };
    })
    .filter((c) => c.symbol && c.qty > 0);
}

/** One compact position line for the prompt — entry vs now, plus the ORIGINAL thesis from the ledger. */
export function renderPositionLine(c: PositionContext): string {
  const pnl = (c.unrealizedPlPct * 100).toFixed(1);
  const opened = c.entryDate ? `, opened ${c.entryDate}` : "";
  const entryRec = c.thesis
    ? ` · entry thesis${c.confidence != null ? ` (conv ${c.confidence}${c.setup ? `, ${c.setup}` : ""})` : c.setup ? ` (${c.setup})` : ""}: "${c.thesis}"`
    : ` · entry thesis: (no record — reconstruct the likely thesis before judging it)`;
  return `• ${c.symbol}: in $${c.entry.toFixed(2)} → now $${c.current.toFixed(2)} (${Number(pnl) >= 0 ? "+" : ""}${pnl}%)${opened}${entryRec}`;
}

/**
 * The re-validation prompt: outcome-framed + token-lean — compact per-position lines (never raw JSON
 * blobs), the computed regime line, and Bill's per-symbol closed-trade history on the held names
 * (symbol-record.ts) so he re-judges each thesis knowing his actual record on that name.
 */
export function buildRevalidatePrompt(contexts: PositionContext[], ledger: SymbolTrade[], regimeLine: string): string {
  const lines = contexts.map(renderPositionLine).join("\n");
  const symbolHistory = renderProposedSymbolHistory(ledger ?? [], contexts.map((c) => c.symbol));
  return `You are Bill the Bull (paper account) running the OPEN-POSITION THESIS RE-VALIDATION ritual. For EACH open position below, judge whether the ORIGINAL entry thesis still holds RIGHT NOW. You only JUDGE — you place no orders and size nothing; deterministic code sizes any resulting action and routes it through the normal gates.

COMPUTED MARKET REGIME (deterministic — treat as THE regime, do not re-derive it): ${regimeLine}

OPEN POSITIONS (each with the thesis it was bought on):
${lines}

${symbolHistory ? symbolHistory + "\n\n" : ""}USE WEB SEARCH per name, as of right now: price action since entry, news/catalyst changes, guidance/analyst moves, sector shifts. Judge the ORIGINAL thesis — not whether you'd buy fresh today:
- "valid" — the reason for owning it is still true; catalyst/story intact. Suggested action: hold.
- "weakening" — partially played out, priced in, or newly contradicted; reducing is sensible. Suggested action: hold or trim.
- "broken" — the thesis is invalidated (catalyst failed, story changed, structural downgrade); exiting is reasonable. Suggested action: exit (or trim if genuinely borderline).
Be honest and P&L-agnostic: a red position with an intact thesis is "valid"; a green one whose catalyst is spent can be "weakening". Judge the thesis, not the tape.

Output ONLY a JSON array (no prose / no fence), ONE entry per position:
[{"symbol":"NVDA","verdict":"weakening","action":"trim","reason":"one line grounded in current data"}]`;
}

const normVerdict = (v: unknown): ThesisVerdict | null => {
  const s = String(v ?? "").trim().toLowerCase();
  if (/^(still[-_ ]?)?valid$|^intact$|^holds?$/.test(s)) return "valid";
  if (/weak/.test(s)) return "weakening";
  if (/broken|invalid|busted|dead/.test(s)) return "broken";
  return null;
};

const normAction = (a: unknown, verdict: ThesisVerdict): ThesisAction => {
  const s = String(a ?? "").trim().toLowerCase();
  if (s === "hold" || s === "trim" || s === "exit") return s;
  if (/sell|close|liquidat/.test(s)) return "exit";
  if (/reduce|partial/.test(s)) return "trim";
  // Missing/unknown action: a broken thesis defaults to a (gated) exit proposal; anything else holds.
  return verdict === "broken" ? "exit" : "hold";
};

/** Parse the model's verdicts. Symbols upper-cased, verdict synonyms normalized ("still-valid" → "valid"),
 *  missing/unknown actions defaulted (broken → exit, else hold). Malformed rows dropped; junk → []. */
export function parseVerdicts(text: string): RevalidationVerdict[] {
  try {
    const m = (text ?? "").match(/\[[\s\S]*\]/);
    const arr = m ? JSON.parse(m[0]) : [];
    if (!Array.isArray(arr)) return [];
    const out: RevalidationVerdict[] = [];
    for (const v of arr) {
      if (!v || typeof v.symbol !== "string" || !v.symbol.trim()) continue;
      const verdict = normVerdict(v.verdict);
      if (!verdict) continue;
      out.push({
        symbol: v.symbol.trim().toUpperCase(),
        verdict,
        action: normAction(v.action, verdict),
        reason: typeof v.reason === "string" ? v.reason : "",
      });
    }
    return out;
  } catch { return []; }
}

export interface RevalidationOrder {
  order: OrderRequest;              // a SELL — the only side a verdict can ever produce
  kind: "exit" | "trim";
  verdict: RevalidationVerdict;
}

/**
 * DETERMINISTIC order derivation — the model's verdicts become concrete SELL proposals here, sized in
 * CODE: exit = the full held qty; trim = cfg.trimFraction of the held qty (never a model-chosen size).
 * Rules: a "valid" verdict never emits an order (even with a stray trim/exit action); "hold" never emits;
 * symbols not in the live book emit nothing (a hallucinated name can't exit anything); only SELLs are
 * possible. The caller must still run every emitted order through validateOrders() + the mode gate —
 * these are PROPOSALS, not placements.
 */
export function verdictsToOrders(
  verdicts: RevalidationVerdict[],
  contexts: PositionContext[],
  cfg: RevalidateConfig = DEFAULT_REVALIDATE,
  fractional = true,
): RevalidationOrder[] {
  const bySym = new Map(contexts.map((c) => [c.symbol, c]));
  const out: RevalidationOrder[] = [];
  for (const v of verdicts ?? []) {
    const ctx = bySym.get(v.symbol);
    if (!ctx || !(ctx.qty > 0)) continue;              // not held → nothing to sell
    if (v.verdict === "valid") continue;               // an intact thesis never trades
    if (v.action === "hold") continue;                 // weakening/broken but explicitly held
    const kind: "exit" | "trim" = v.action === "exit" ? "exit" : "trim";
    const rawQty = kind === "exit" ? ctx.qty : ctx.qty * clamp01(cfg.trimFraction);
    const qty = fractional ? r4(rawQty) : Math.floor(rawQty);
    if (!(qty > 0)) continue;
    out.push({
      kind,
      verdict: v,
      order: {
        symbol: ctx.symbol,
        side: "sell",
        qty,
        type: "market",
        est_price: r2(ctx.current),
        thesis: `thesis ${v.verdict} — ${v.reason || "revalidation"}`,
        setup: ctx.setup ?? "revalidation",
        fractional,
      },
    });
  }
  return out;
}

const BADGE: Record<ThesisVerdict, string> = { valid: "✅", weakening: "⚠️", broken: "🛑" };

/** Discord/pending lines: one per verdict, with the position's live P&L when known. */
export function renderVerdictLines(verdicts: RevalidationVerdict[], contexts: PositionContext[] = []): string[] {
  const bySym = new Map(contexts.map((c) => [c.symbol, c]));
  return (verdicts ?? []).map((v) => {
    const ctx = bySym.get(v.symbol);
    const pnl = ctx ? ` (${ctx.unrealizedPlPct >= 0 ? "+" : ""}${(ctx.unrealizedPlPct * 100).toFixed(1)}%)` : "";
    return `  ${BADGE[v.verdict]} ${v.symbol}${pnl} — ${v.verdict} · suggested ${v.action}${v.reason ? ` · ${v.reason}` : ""}`;
  });
}

/** One-line thesis-health summary for the EOD wrap / dashboard, e.g.
 *  "🧬 Thesis health: 3 ✅ valid · 1 ⚠️ weakening (MU) · 1 🛑 broken (XYZ)". "" when there are no verdicts,
 *  so a flat book (or a day the ritual didn't run) adds nothing. Pure render. */
export function renderThesisHealthFooter(verdicts: Array<Pick<RevalidationVerdict, "symbol" | "verdict">>): string {
  const vs = (verdicts ?? []).filter((v) => v && v.symbol && (v.verdict === "valid" || v.verdict === "weakening" || v.verdict === "broken"));
  if (!vs.length) return "";
  const parts: string[] = [];
  for (const verdict of ["valid", "weakening", "broken"] as ThesisVerdict[]) {
    const hit = vs.filter((v) => v.verdict === verdict);
    if (!hit.length) continue;
    const names = verdict === "valid" ? "" : ` (${hit.map((v) => v.symbol).join(", ")})`;
    parts.push(`${hit.length} ${BADGE[verdict]} ${verdict}${names}`);
  }
  return "🧬 Thesis health: " + parts.join(" · ");
}
