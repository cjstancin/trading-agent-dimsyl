// Bull v2 — Wildcard pool assembly (design §6). The pool is STRICTLY names the system's own signals
// surfaced: momentum top-25 ∪ live insider clusters (incl. shadow-book) ∪ Anchor top-5s. A name in
// multiple sources is ONE entry with merged flags — the flags travel onto the context card so the
// model sees the full "why surfaced" picture (a momentum name that ALSO has an insider cluster is a
// different animal than either alone). Order is deterministic: momentum rank ascending first, then
// the signal-only names alphabetically — determinism matters because the pool snapshot is hashed
// into the audit row and replayed in tests.
import type { PoolPort, PoolEntry } from "./types.js";

/** Design pins the pool's momentum slice at the top-25 — the momentum sleeve's own hold-band
 *  boundary (sellBelowRank), i.e. "names momentum would still be holding". Not a wildcard config
 *  dial today; promote to config if the design ever unpins it. */
export const MOMENTUM_POOL_TOP_N = 25;

export async function assemblePool(port: PoolPort, momTopN: number = MOMENTUM_POOL_TOP_N): Promise<PoolEntry[]> {
  const [mom, ins, anc] = await Promise.all([
    port.momentumTop(momTopN),
    port.insiderLiveClusters(),
    port.anchorTop5s(),
  ]);

  const bySym = new Map<string, PoolEntry>();
  const get = (symbol: string): PoolEntry => {
    const sym = symbol.toUpperCase().trim();
    let e = bySym.get(sym);
    if (!e) { e = { symbol: sym, momentumRank: null, insiderCluster: null, anchorManagers: [] }; bySym.set(sym, e); }
    return e;
  };

  for (const m of mom) {
    if (!m.symbol) continue;
    const e = get(m.symbol);
    // Keep the BEST rank if a source ever repeats a symbol.
    e.momentumRank = e.momentumRank === null ? m.rank : Math.min(e.momentumRank, m.rank);
  }
  for (const i of ins) {
    if (!i.symbol) continue;
    const e = get(i.symbol);
    // live beats shadow when both appear (a funded cluster is the stronger flag).
    if (e.insiderCluster !== "live") e.insiderCluster = i.live ? "live" : "shadow";
  }
  for (const a of anc) {
    if (!a.symbol) continue;
    const e = get(a.symbol);
    for (const m of a.managers ?? []) if (m && !e.anchorManagers.includes(m)) e.anchorManagers.push(m);
  }

  return [...bySym.values()].sort((x, y) => {
    const xr = x.momentumRank ?? Infinity, yr = y.momentumRank ?? Infinity;
    return xr !== yr ? xr - yr : x.symbol < y.symbol ? -1 : x.symbol > y.symbol ? 1 : 0;
  });
}
