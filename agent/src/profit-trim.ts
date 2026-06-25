// News-aware profit-taking (Bull v4): when a position runs to a gain, the hourly rotation re-assesses CURRENT
// sentiment and TRIMS part of it — selling MORE if the pop looks spent (catalyst priced in, news turning) and
// LESS/none if it's still running. Banks gains "into strength" without fully exiting a winner; the remainder
// keeps its synthetic trailing stop. Pure helpers here; the LLM call + sellQty placement live in run-reallocate.

export interface Winner { symbol: string; entry: number; current: number; gainPct: number; qty: number; }
export interface TrimDecision { symbol: string; trimFraction: number; reason: string; }

/** Positions whose unrealized gain ≥ triggerPct — candidates for a news-aware profit trim. */
export function findWinners(rawPositions: Array<Record<string, unknown>>, triggerPct: number): Winner[] {
  return rawPositions
    .map((p) => ({
      symbol: String(p.symbol ?? ""),
      entry: Number(p.avg_entry_price ?? 0),
      current: Number(p.current_price ?? 0),
      gainPct: Number(p.unrealized_plpc ?? 0) * 100,
      qty: Number(p.qty ?? 0),
    }))
    .filter((w) => w.symbol && w.qty > 0 && w.gainPct >= triggerPct);
}

/** Parse the model's per-winner trim decisions. trimFraction clamped to [0,1]; malformed rows dropped. */
export function parseTrims(text: string): TrimDecision[] {
  try {
    const m = text.match(/\[[\s\S]*\]/);
    const arr = m ? JSON.parse(m[0]) : [];
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((d: any) => d && typeof d.symbol === "string" && Number.isFinite(Number(d.trimFraction)))
      .map((d: any) => ({
        symbol: String(d.symbol).toUpperCase(),
        trimFraction: Math.max(0, Math.min(1, Number(d.trimFraction))),
        reason: typeof d.reason === "string" ? d.reason : "",
      }));
  } catch { return []; }
}

/** The news-aware trim prompt: the model web-searches each winner's CURRENT sentiment and sizes the trim. */
export function buildTrimPrompt(winners: Winner[], watchlist: string): string {
  const rows = winners.map((w) => `  • ${w.symbol}: bought $${w.entry.toFixed(2)}, now $${w.current.toFixed(2)} (+${w.gainPct.toFixed(1)}%), holding ${w.qty} sh`).join("\n");
  return `You are Bill the Bull (paper account). These OPEN positions are in PROFIT and may be candidates to TRIM — sell part into strength, bank the gain, keep the rest running. Decide how much of EACH to trim RIGHT NOW based on CURRENT sentiment.

Winners:
${rows}

USE WEB SEARCH on each name's state as of right now: is the move STILL RUNNING (fresh catalyst, upgrades, momentum, more upside) or SPENT (one-off pop, catalyst already priced in, news turning, overbought, downgrade)? Trim MORE when the pop looks done; trim LESS or nothing when it's still running.
trimFraction scale: 0 = let it run (still strong), 0.25 = light trim, 0.5 = bank half (pop maturing), 0.75–1.0 = mostly/fully exit (catalyst spent or turning). Be decisive, but don't cut a real runner early.

Today's watchlist (context):
${watchlist || "(none)"}

Output ONLY a JSON array (no prose / no fence), one entry per winner — omit any you'd fully hold (or give trimFraction 0):
[{"symbol":"NVDA","trimFraction":0.5,"reason":"+22%; AI-capex pop largely priced in after the MU read-through — bank half, let half run"}]`;
}
