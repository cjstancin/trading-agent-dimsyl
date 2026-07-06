// SUCCESS / FAIL / NULL tests for the per-holding news feed (no network, no orders, no file writes).
// Run: npm run test:news-feed
// Invariants under test: TTL cache (~1h) makes the feed quota-safe (fresh symbols never refetch; stale
// symbols go out in ONE batched call); headlines are sanitized through news-guard normalizeText before
// they can reach a prompt/dashboard; an empty/down source degrades to [] and NEVER throws (news is
// best-effort — it can never break a ritual); and per-position attach maps a multi-symbol item to every
// tracked holding, newest first, capped.
process.env.ALPACA_API_KEY = "test-key-not-real";
process.env.ALPACA_API_SECRET = "test-secret-not-real";
delete process.env.ALPACA_BASE_URL; // default paper host → alpaca.ts module-load guard passes

const {
  refreshNews, groupNewsBySymbol, sanitizeNewsItem, isFresh, positionNews,
  renderNewsLines, newsAgeLabel, NEWS_TTL_MS, MAX_HEADLINES_PER_SYMBOL,
} = await import("./news-feed.js");
const { buildRevalidatePrompt } = await import("./revalidate.js");
type AlpacaNewsItem = import("./alpaca.js").AlpacaNewsItem;
type NewsCache = import("./news-feed.js").NewsCache;

let pass = 0, fail = 0;
const check = (name: string, cond: boolean) => { (cond ? pass++ : fail++); console.log(`${cond ? "PASS" : "FAIL"} — ${name}`); };

const NOW = Date.parse("2026-07-06T12:00:00Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const items: AlpacaNewsItem[] = [
  { headline: "NVDA beats on earnings", source: "Benzinga", url: "https://example.com/nvda", created_at: iso(30 * 60e3), symbols: ["NVDA"] },
  { headline: "Chip sector rallies", source: "Reuters", url: "https://example.com/chips", created_at: iso(10 * 60e3), symbols: ["NVDA", "MU"] },
  { headline: "Unrelated name pops", source: "PR", url: "https://example.com/x", created_at: iso(5 * 60e3), symbols: ["ZZZZ"] },
];
const mkFetcher = (payload: AlpacaNewsItem[]) => {
  const calls: string[][] = [];
  const fetcher = async (symbols: string[], _limit: number) => { calls.push([...symbols]); return payload; };
  return { fetcher, calls };
};

// ── SUCCESS: fetch + per-position attach (batched, grouped, newest-first, tracked-only) ──
{
  const { fetcher, calls } = mkFetcher(items);
  const res = await refreshNews(["NVDA", "MU", "AAPL"], {}, fetcher, { now: NOW });
  check("fetch: ONE batched call covers every stale symbol", calls.length === 1 && calls[0].join(",") === "NVDA,MU,AAPL");
  check("attach: multi-symbol item lands on each tracked holding", res.news.NVDA.length === 2 && res.news.MU.length === 1 && res.news.MU[0].headline === "Chip sector rallies");
  check("attach: newest first", res.news.NVDA[0].headline === "Chip sector rallies");
  check("attach: untracked symbol (ZZZZ) is ignored", !("ZZZZ" in res.news) && !("ZZZZ" in res.cache));
  check("attach: no-news holding still gets [] + a cache stamp (no refetch storm)", Array.isArray(res.news.AAPL) && res.news.AAPL.length === 0 && isFresh(res.cache.AAPL, NOW));
  check("fetchedSymbols reports what actually went out", res.fetchedSymbols.join(",") === "NVDA,MU,AAPL");
}

// ── TTL cache: fresh symbols never refetch; stale-only symbols go out; expiry refetches ──
{
  const { fetcher, calls } = mkFetcher(items);
  const first = await refreshNews(["NVDA", "MU"], {}, fetcher, { now: NOW });
  const second = await refreshNews(["NVDA", "MU"], first.cache, fetcher, { now: NOW + 10 * 60e3 });
  check("TTL: within ~1h → served from cache, fetcher NOT called again", calls.length === 1 && second.fetchedSymbols.length === 0);
  check("TTL: cached headlines survive the cache hit", second.news.NVDA.length === 2 && second.news.NVDA[0].headline === "Chip sector rallies");
  const mixed = await refreshNews(["NVDA", "TSLA"], first.cache, fetcher, { now: NOW + 10 * 60e3 });
  check("TTL: only the STALE symbol is fetched (fresh NVDA skipped)", mixed.fetchedSymbols.join(",") === "TSLA" && calls[calls.length - 1].join(",") === "TSLA");
  const expired = await refreshNews(["NVDA"], first.cache, fetcher, { now: NOW + NEWS_TTL_MS + 1 });
  check("TTL: past the TTL → refetched", expired.fetchedSymbols.join(",") === "NVDA");
  check("isFresh: malformed fetchedAt → stale", isFresh({ symbol: "X", fetchedAt: "garbage", headlines: [] }, NOW) === false);
}

// ── EMPTY SOURCE / DOWN FEED: best-effort, never throws, never breaks a run ──
{
  const { fetcher } = mkFetcher([]);
  const res = await refreshNews(["NVDA"], {}, fetcher, { now: NOW });
  check("empty source: [] headlines, still stamped fresh (quota-safe)", res.news.NVDA.length === 0 && isFresh(res.cache.NVDA, NOW));
}
{
  const boom = async () => { throw new Error("feed down"); };
  let threw = false;
  let res: Awaited<ReturnType<typeof refreshNews>> | null = null;
  try { res = await refreshNews(["NVDA"], {}, boom, { now: NOW }); } catch { threw = true; }
  check("down feed: refreshNews NEVER throws", !threw && !!res);
  check("down feed: symbol degrades to [] and cache is NOT poisoned (retry next pass)", res!.news.NVDA.length === 0 && !res!.cache.NVDA && res!.fetchedSymbols.length === 0);
  // stale cached headlines still surface as a fallback while the feed is down
  const staleCache: NewsCache = { NVDA: { symbol: "NVDA", fetchedAt: iso(2 * NEWS_TTL_MS), headlines: [{ headline: "old but useful", source: "X", url: "", publishedAt: iso(3 * NEWS_TTL_MS) }] } };
  const fb = await refreshNews(["NVDA"], staleCache, boom, { now: NOW });
  check("down feed: stale cached headlines still serve as fallback", fb.news.NVDA.length === 1 && fb.news.NVDA[0].headline === "old but useful");
  // positionNews (prod wrapper) also never throws with a dead fetcher — and writes nothing on failure
  let pThrew = false; let pRes: Record<string, unknown> = {};
  try { pRes = await positionNews(["NVDA"], boom); } catch { pThrew = true; }
  check("positionNews: dead fetcher → never throws, returns per-symbol lists", !pThrew && Array.isArray((pRes as Record<string, unknown[]>).NVDA));
}

// ── SANITIZATION (news-guard) + caps ──
{
  const dirty: AlpacaNewsItem[] = [
    { headline: 'Beat <span style="display:none">missed badly</span> earnings', source: "Wire​", url: "javascript:alert(1)", created_at: iso(60e3), symbols: ["AAPL"] },
    { headline: "", source: "empty", url: "https://ok.example", created_at: iso(60e3), symbols: ["AAPL"] },
  ];
  const g = groupNewsBySymbol(dirty, ["AAPL"]);
  check("sanitize: hidden-HTML sentiment flip stripped", g.AAPL.length === 1 && !/missed/i.test(g.AAPL[0].headline) && /Beat/.test(g.AAPL[0].headline));
  check("sanitize: non-http(s) url dropped", g.AAPL[0].url === "");
  check("sanitize: zero-width chars stripped from source", g.AAPL[0].source === "Wire");
  check("sanitize: headline-less item dropped entirely", sanitizeNewsItem({ headline: "", symbols: ["AAPL"] }) === null);
  const many: AlpacaNewsItem[] = Array.from({ length: 6 }, (_, i) => ({ headline: `h${i}`, created_at: iso(i * 60e3), symbols: ["NVDA"] }));
  check(`cap: at most ${MAX_HEADLINES_PER_SYMBOL} headlines per symbol`, groupNewsBySymbol(many, ["NVDA"]).NVDA.length === MAX_HEADLINES_PER_SYMBOL);
}

// ── cache pruning bounds the file ──
{
  const old: NewsCache = { GONE: { symbol: "GONE", fetchedAt: iso(25 * 3600e3), headlines: [] } };
  const { fetcher } = mkFetcher(items);
  const res = await refreshNews(["NVDA"], old, fetcher, { now: NOW });
  check("prune: cache entries older than 24h dropped", !res.cache.GONE && !!res.cache.NVDA);
}

// ── renders: prompt/brief lines + age label; revalidation prompt integration ──
{
  const { fetcher } = mkFetcher(items);
  const res = await refreshNews(["NVDA", "MU"], {}, fetcher, { now: NOW });
  const lines = renderNewsLines(res.news, 2, NOW);
  check("render: bullet per headline with source + age", /• NVDA: "Chip sector rallies" \(Reuters · 10m ago\)/.test(lines) && /• MU: /.test(lines));
  check("render: maxPerSymbol respected", renderNewsLines(res.news, 1, NOW).split("\n").filter((l) => l.startsWith("• NVDA")).length === 1);
  check("render: empty feed → '' (adds zero tokens)", renderNewsLines({}, 2, NOW) === "");
  check("age: minutes/hours/days + unparseable → ''", newsAgeLabel(iso(90 * 60e3), NOW) === "2h ago" && newsAgeLabel(iso(3 * 864e5), NOW) === "3d ago" && newsAgeLabel("junk", NOW) === "");
  const ctx = [{ symbol: "NVDA", qty: 1, entry: 900, current: 870, unrealizedPlPct: -0.03, marketValue: 870, entryDate: null, thesis: null, setup: null, confidence: null }];
  const withNews = buildRevalidatePrompt(ctx, [], "SPY $600 above rising 200-DMA (risk-on)", lines);
  const without = buildRevalidatePrompt(ctx, [], "SPY $600 above rising 200-DMA (risk-on)");
  check("revalidate prompt: headlines block injected as a signal", withNews.includes("RECENT HEADLINES") && withNews.includes("Chip sector rallies"));
  check("revalidate prompt: no news → block absent (prompt unchanged)", !without.includes("RECENT HEADLINES"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
