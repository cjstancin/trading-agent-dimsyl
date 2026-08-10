// Bull v2 insider sleeve — LIVE EDGAR adapter (the only file that talks to sec.gov). Two hard SEC
// fair-access rules are enforced here so no caller can forget them:
//   1. A DECLARED User-Agent with contact info — EDGAR 403s anonymous clients (verified live
//      2026-08-10). Overridable via EDGAR_USER_AGENT for ops rotation.
//   2. ≤2 requests/second — implemented as a serialized promise chain with a ≥500ms gap between
//      request STARTS. Serialization (not a token bucket) is deliberate: the poller and the nightly
//      reconciler share this module instance, and a simple chain makes bursts structurally
//      impossible rather than statistically unlikely.
// All fetches are wrapped in withTimeout (a stalled EDGAR must not pin the poll loop) and return
// RAW text — parsing lives in form4.ts / ingest.ts where fixtures cover it.
import { withTimeout, DEFAULT_TIMEOUT_MS } from "../../../http-utils.js";
import { d9, type D9 } from "../../decimal.js";
import type { EdgarPort } from "./ports.js";

const UA = process.env.EDGAR_USER_AGENT || "bull-v2 cj@dimsylaisolutions.com";
const MIN_GAP_MS = 500; // ≤2 req/s
const TIMEOUT_MS = parseInt(process.env.EDGAR_TIMEOUT_MS || String(DEFAULT_TIMEOUT_MS), 10);

let chain: Promise<unknown> = Promise.resolve();
let lastStart = 0;

function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(async () => {
    const wait = lastStart + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastStart = Date.now();
    return fn();
  });
  chain = next.catch(() => {}); // a failed request must not poison the chain
  return next;
}

async function edgarGet(url: string): Promise<string> {
  return throttled(async () => {
    const res = await withTimeout((signal) => fetch(url, {
      headers: { "User-Agent": UA, "Accept-Encoding": "gzip, deflate" },
      signal,
    }), TIMEOUT_MS);
    if (!res.ok) throw new Error(`EDGAR GET ${url} → ${res.status}${res.status === 403 ? " (missing/blocked User-Agent?)" : ""}`);
    return res.text();
  });
}

/** Accession "0001234567-26-000123" → its archive directory name "000123456726000123". */
export function accessionNoDashes(accession: string): string {
  return accession.replace(/-/g, "");
}

/** Daily-index path parts for an ET date: /Archives/edgar/daily-index/YYYY/QTRn/form.YYYYMMDD.idx */
export function dailyIndexUrl(date: string): string {
  const [y, m] = date.split("-").map((s) => parseInt(s, 10));
  const qtr = Math.floor((m - 1) / 3) + 1;
  return `https://www.sec.gov/Archives/edgar/daily-index/${y}/QTR${qtr}/form.${date.replace(/-/g, "")}.idx`;
}

export const edgarLive: EdgarPort = {
  getCurrentForm4Atom(): Promise<string> {
    // getcurrent = filings as they disseminate (the 2–5-min poll target). count=100 ≈ well past
    // one poll interval's worth of Form 4s even on a busy evening; the nightly index catches any
    // overflow (design: Atom is best-effort, the daily index is the reconciliation truth).
    return edgarGet("https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&company=&dateb=&owner=include&count=100&output=atom");
  },

  getDailyIndex(date: string): Promise<string> {
    return edgarGet(dailyIndexUrl(date));
  },

  async getFiling(accession: string, cik: string): Promise<string> {
    // Preferred: the filing's index.json names its documents; grab the ownership XML. Fallback:
    // the full-submission .txt (XML embedded) — parseForm4 slices to <ownershipDocument> either way.
    const cikNum = String(parseInt(cik, 10));
    const base = `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accessionNoDashes(accession)}`;
    try {
      const idx = JSON.parse(await edgarGet(`${base}/index.json`)) as { directory?: { item?: { name: string }[] } };
      const items = idx.directory?.item ?? [];
      const xml = items.find((i) => /\.xml$/i.test(i.name) && !/index/i.test(i.name));
      if (xml) return edgarGet(`${base}/${xml.name}`);
    } catch { /* fall through to full submission */ }
    return edgarGet(`https://www.sec.gov/Archives/edgar/data/${cikNum}/${accession}.txt`);
  },

  /** dei:EntityCommonStockSharesOutstanding (latest reported) via companyconcept — feeds the
   *  market-cap floor (shares × price). null on any miss: the floor fails CLOSED upstream. */
  async getSharesOutstanding(cik: string): Promise<D9 | null> {
    try {
      const cik10 = String(parseInt(cik, 10)).padStart(10, "0");
      const raw = await edgarGet(`https://data.sec.gov/api/xbrl/companyconcept/CIK${cik10}/dei/EntityCommonStockSharesOutstanding.json`);
      const j = JSON.parse(raw) as { units?: { shares?: { end: string; val: number }[] } };
      const rows = j.units?.shares ?? [];
      if (!rows.length) return null;
      rows.sort((a, b) => (a.end < b.end ? -1 : 1));
      const latest = rows[rows.length - 1].val;
      if (!Number.isFinite(latest) || latest <= 0) return null;
      return d9(String(Math.round(latest)));
    } catch { return null; }
  },
};
