// Per-holding NEWS FEED (Bull v6) — recent headlines for each OPEN position, surfaced on the dashboard,
// in the pre-market brief, and as grounding for the thesis-revalidation prompt (a held name with fresh
// negative news is a revalidation signal). Reuses the EXISTING Alpaca data source (data.alpaca.markets
// /v1beta1/news — same keys as prices/bars/tradable checks; NO new paid feed) and is QUOTA-SAFE: results
// are TTL-cached (~1h) in memory/news-cache.json shared across rituals (each ritual is its own process),
// and all stale symbols go out in ONE batched request. BEST-EFFORT by design: no keys / feed down /
// malformed payload → empty headlines, never a throw — news can never break a trading ritual.
// Headlines are sanitized through news-guard normalizeText (hidden-HTML + homoglyph stripping) before
// they reach a prompt or the dashboard. Read-only; no order path touches this module.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { normalizeText } from "./news-guard.js";
import { getNews, type AlpacaNewsItem } from "./alpaca.js";

export interface NewsHeadline {
  headline: string;    // sanitized (normalizeText), capped length
  source: string;      // e.g. "Benzinga" — sanitized
  url: string;         // http(s) only, else ""
  publishedAt: string; // ISO timestamp, "" if unparseable
}
export interface SymbolNewsEntry { symbol: string; fetchedAt: string; headlines: NewsHeadline[] }
export type NewsCache = Record<string, SymbolNewsEntry>;
/** Injectable fetcher (tests stub this; prod uses the Alpaca news endpoint via alpaca.getNews). */
export type NewsFetcher = (symbols: string[], limit: number) => Promise<AlpacaNewsItem[]>;

export const NEWS_TTL_MS = 60 * 60 * 1000;          // ~1h — quota-safe across 5-min refresh ticks
export const NEWS_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // prune cache entries older than a day
export const MAX_HEADLINES_PER_SYMBOL = 3;
const MAX_HEADLINE_CHARS = 160;
const FETCH_LIMIT = 50; // one batched request covers every stale holding

const normSym = (s: unknown): string => String(s ?? "").trim().toUpperCase();

/** Is this cache entry still inside the TTL? Malformed/missing fetchedAt → stale. */
export function isFresh(entry: SymbolNewsEntry | undefined, now: number, ttlMs: number = NEWS_TTL_MS): boolean {
  if (!entry) return false;
  const t = Date.parse(entry.fetchedAt);
  return Number.isFinite(t) && now - t >= 0 && now - t < ttlMs;
}

/** Sanitize one raw news item into a NewsHeadline, or null if it has no usable headline. */
export function sanitizeNewsItem(item: AlpacaNewsItem): NewsHeadline | null {
  const headline = normalizeText(String(item?.headline ?? "")).slice(0, MAX_HEADLINE_CHARS);
  if (!headline) return null;
  const url = typeof item?.url === "string" && /^https?:\/\//i.test(item.url) ? item.url : "";
  const t = Date.parse(String(item?.created_at ?? ""));
  return {
    headline,
    source: normalizeText(String(item?.source ?? "")).slice(0, 40),
    url,
    publishedAt: Number.isFinite(t) ? new Date(t).toISOString() : "",
  };
}

/** Group a batched news payload per requested symbol (an item may tag several symbols), newest first,
 *  capped at maxPerSymbol. Symbols with no items map to []. Pure. */
export function groupNewsBySymbol(items: AlpacaNewsItem[], symbols: string[], maxPerSymbol: number = MAX_HEADLINES_PER_SYMBOL): Record<string, NewsHeadline[]> {
  const want = new Set(symbols.map(normSym).filter(Boolean));
  const out: Record<string, NewsHeadline[]> = {};
  for (const s of want) out[s] = [];
  const sorted = [...(Array.isArray(items) ? items : [])].sort((a, b) => (Date.parse(String(b?.created_at ?? "")) || 0) - (Date.parse(String(a?.created_at ?? "")) || 0));
  for (const item of sorted) {
    const tagged = Array.isArray(item?.symbols) ? item.symbols.map(normSym) : [];
    const clean = sanitizeNewsItem(item);
    if (!clean) continue;
    for (const sym of tagged) {
      if (!want.has(sym)) continue;
      if (out[sym].length < Math.max(0, maxPerSymbol)) out[sym].push(clean);
    }
  }
  return out;
}

export interface RefreshNewsResult {
  news: Record<string, NewsHeadline[]>; // per requested symbol (always every requested symbol, maybe [])
  cache: NewsCache;                     // next cache to persist
  fetchedSymbols: string[];             // symbols actually fetched this pass ([] = all served from cache)
}

/**
 * TTL-cached per-symbol news, fetcher injected (pure apart from the fetcher — no file I/O here).
 * Fresh symbols are served from the cache without a network call; all stale symbols go out in ONE
 * batched fetch. A successful fetch stamps every stale symbol (empty results included) so a no-news
 * name doesn't refetch each tick. A FAILED fetch leaves the cache untouched (so the next pass retries)
 * and falls back to whatever stale headlines the cache still holds. NEVER throws.
 */
export async function refreshNews(
  symbols: string[],
  cache: NewsCache,
  fetcher: NewsFetcher,
  opts: { now?: number; ttlMs?: number; maxPerSymbol?: number } = {},
): Promise<RefreshNewsResult> {
  const now = opts.now ?? Date.now();
  const ttl = opts.ttlMs ?? NEWS_TTL_MS;
  const maxPer = opts.maxPerSymbol ?? MAX_HEADLINES_PER_SYMBOL;
  const want = [...new Set((symbols ?? []).map(normSym).filter(Boolean))];
  const prev: NewsCache = cache && typeof cache === "object" ? cache : {};
  const news: Record<string, NewsHeadline[]> = {};
  const next: NewsCache = { ...prev };

  const stale = want.filter((s) => !isFresh(prev[s], now, ttl));
  for (const s of want) news[s] = Array.isArray(prev[s]?.headlines) ? prev[s].headlines.slice(0, maxPer) : [];

  let fetchedSymbols: string[] = [];
  if (stale.length) {
    try {
      const items = await fetcher(stale, FETCH_LIMIT);
      const grouped = groupNewsBySymbol(items, stale, maxPer);
      for (const s of stale) {
        next[s] = { symbol: s, fetchedAt: new Date(now).toISOString(), headlines: grouped[s] ?? [] };
        news[s] = next[s].headlines;
      }
      fetchedSymbols = stale;
    } catch { /* feed down → stale/empty fallback, cache untouched so the next pass retries */ }
  }

  // Bound the cache file: drop entries older than a day (closed positions age out on their own).
  for (const key of Object.keys(next)) {
    const t = Date.parse(next[key]?.fetchedAt ?? "");
    if (!Number.isFinite(t) || now - t > NEWS_CACHE_MAX_AGE_MS) delete next[key];
  }
  return { news, cache: next, fetchedSymbols };
}

// ── file-backed cache + prod wrapper ──────────────────────────────────────────────────────────────
const CACHE_FILE = fileURLToPath(new URL("../../memory/news-cache.json", import.meta.url));
export const readNewsCache = (): NewsCache => {
  try {
    const j = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
    return j && typeof j === "object" && !Array.isArray(j) ? (j as NewsCache) : {};
  } catch { return {}; }
};
export function writeNewsCache(cache: NewsCache): void {
  try { writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2) + "\n"); } catch { /* best effort */ }
}

const alpacaNewsFetcher: NewsFetcher = (symbols, limit) => getNews(symbols, limit);

/** Prod entry point: headlines per open-position symbol, file-TTL-cached, best-effort.
 *  Any failure (keys missing, feed down, cache unreadable) → {} / empty lists. NEVER throws. */
export async function positionNews(symbols: string[], fetcher: NewsFetcher = alpacaNewsFetcher): Promise<Record<string, NewsHeadline[]>> {
  try {
    const res = await refreshNews(symbols, readNewsCache(), fetcher);
    if (res.fetchedSymbols.length) writeNewsCache(res.cache);
    return res.news;
  } catch { return {}; }
}

/** "3h ago"-style age for a headline timestamp; "" when unparseable. Pure. */
export function newsAgeLabel(publishedAt: string, now: number = Date.now()): string {
  const t = Date.parse(publishedAt ?? "");
  if (!Number.isFinite(t)) return "";
  const m = Math.max(0, Math.round((now - t) / 60000));
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Compact prompt/brief lines — `• SYM: "headline" (source · 3h ago)`. "" when there's nothing,
 *  so a no-news day adds zero tokens. Pure render. */
export function renderNewsLines(news: Record<string, NewsHeadline[]>, maxPerSymbol = 2, now: number = Date.now()): string {
  const lines: string[] = [];
  for (const sym of Object.keys(news ?? {}).sort()) {
    for (const h of (news[sym] ?? []).slice(0, Math.max(0, maxPerSymbol))) {
      if (!h?.headline) continue;
      const age = newsAgeLabel(h.publishedAt, now);
      const meta = [h.source, age].filter(Boolean).join(" · ");
      lines.push(`• ${sym}: "${h.headline}"${meta ? ` (${meta})` : ""}`);
    }
  }
  return lines.join("\n");
}
