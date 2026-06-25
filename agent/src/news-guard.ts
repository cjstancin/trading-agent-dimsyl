// Input / news hardening (Bull v5) against the documented adversarial-injection risks for LLM traders:
// Unicode HOMOGLYPH ticker-misrouting (e.g. a Cyrillic "А" in "АAPL") and HIDDEN-HTML sentiment flips
// (<span style=display:none>). Pure + testable. The authoritative cross-check is alpaca.getTradableSymbols();
// this module normalizes text/tickers and flags anything suspicious at the boundaries we control (the LLM's
// proposed symbols). We can't sanitize inside the SDK's own web search, so we validate its OUTPUT instead.

/** Strip hidden HTML (display:none / visibility:hidden / [hidden]) + remaining tags, NFKD-normalize, drop
 *  non-ASCII (homoglyphs / zero-width), collapse whitespace. For any external text before it informs a decision. */
export function normalizeText(s: string): string {
  if (!s) return "";
  return s
    .replace(/<[^>]*(?:display\s*:\s*none|visibility\s*:\s*hidden|\bhidden\b)[^>]*>[\s\S]*?<\/[^>]+>/gi, " ") // hidden element + its content
    .replace(/<[^>]+>/g, " ")        // remaining tags
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")    // drop non-ASCII (homoglyphs, zero-width chars)
    .replace(/\s+/g, " ")
    .trim();
}

/** True if the string contains ANY non-ASCII character — a homoglyph / zero-width injection marker. */
export function hasSuspiciousChars(s: string): boolean {
  return /[^\x00-\x7F]/.test(s || "");
}

/** Normalize a ticker to plain ASCII uppercase [A-Z0-9.] (non-ASCII stripped, so a homoglyph can't pass through). */
export function normalizeTicker(s: string): string {
  return (s || "").normalize("NFKD").toUpperCase().replace(/[^A-Z0-9.]/g, "");
}

/** Cross-check proposed tickers against the authoritative tradable set. REJECT a symbol that contained
 *  non-ASCII (homoglyph attack), normalizes to empty, or whose clean form isn't a tradable US equity
 *  (hallucinated / misrouted). Returns normalized survivors + the rejects with reasons. An empty `tradable`
 *  set (API unavailable) skips the membership check but still strips suspicious symbols. */
export function cleanTickers(symbols: string[], tradable: Set<string>): { valid: string[]; rejected: Array<{ symbol: string; reason: string }> } {
  const valid: string[] = [];
  const rejected: Array<{ symbol: string; reason: string }> = [];
  for (const raw of symbols) {
    const norm = normalizeTicker(raw);
    if (hasSuspiciousChars(raw)) rejected.push({ symbol: raw, reason: "non-ASCII chars (possible homoglyph attack)" });
    else if (!norm) rejected.push({ symbol: raw, reason: "empty after normalization" });
    else if (tradable.size > 0 && !tradable.has(norm)) rejected.push({ symbol: raw, reason: "not a tradable US equity (hallucinated/misrouted)" });
    else valid.push(norm);
  }
  return { valid, rejected };
}

/** Convenience: is this single raw symbol a trusted, tradable ticker? */
export function isTrustedTicker(raw: string, tradable: Set<string>): boolean {
  if (hasSuspiciousChars(raw)) return false;
  const norm = normalizeTicker(raw);
  return !!norm && (tradable.size === 0 || tradable.has(norm));
}
