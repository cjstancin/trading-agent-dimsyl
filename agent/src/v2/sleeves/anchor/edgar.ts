// Bull v2 — Anchor: EDGAR adapter (the ONE file that talks to sec.gov). SEC fair-access rules are
// hard requirements, not etiquette: a DECLARED User-Agent with contact info, and ≤10 req/s (we
// self-throttle to ≤2 req/s — the sleeve fetches at most ~a dozen documents per filing evening, so
// politeness costs nothing). Violations get an IP block that would silently kill filing evenings.
//
// Three endpoints, all free JSON/XML:
//   · https://data.sec.gov/submissions/CIK##########.json — per-CIK filing index (form, accession,
//     reportDate, filingDate) → filingIndex()/latest13F()
//   · .../Archives/edgar/data/{cik}/{acc-no-dashes}/index.json — per-filing file list → find the
//     information-table XML (name varies by filer: infotable.xml, form13fInfoTable.xml, …) and,
//     for 13F-HR/A, the primary_doc.xml that carries <amendmentType> (RESTATEMENT | NEW HOLDINGS)
//   · the raw document fetch itself
//
// Everything returned is DATA — parsing is pure (infotable.ts) and every consumer below this file
// is tested offline against fixtures. The live adapter itself is exercised only in production.
import { withTimeout, DEFAULT_TIMEOUT_MS } from "../../../http-utils.js";
import type { EdgarPort, FilingRecord } from "./types.js";

const EDGAR_UA =
  process.env.EDGAR_USER_AGENT ?? "Bull-v2-anchor-sleeve cj@dimsylaisolutions.com";
const MIN_REQUEST_GAP_MS = 500; // ≤2 req/s
const TIMEOUT_MS = parseInt(process.env.EDGAR_TIMEOUT_MS || String(DEFAULT_TIMEOUT_MS), 10);

let lastRequestAt = 0;
async function throttled(url: string): Promise<Response> {
  const wait = lastRequestAt + MIN_REQUEST_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
  const res = await withTimeout(
    (signal) => fetch(url, { headers: { "User-Agent": EDGAR_UA, "Accept-Encoding": "gzip, deflate" }, signal }),
    TIMEOUT_MS,
  );
  if (!res.ok) throw new Error(`EDGAR GET ${url} → ${res.status}`);
  return res;
}

/** Zero-pad a CIK to the 10 digits the submissions endpoint requires. */
export function padCik(cik: string): string {
  return cik.replace(/^0+/, "").padStart(10, "0");
}

/** accession "0000950123-26-008888" → "000095012326008888" (Archives path segment). */
export function accessionNoDashes(accession: string): string {
  return accession.replace(/-/g, "");
}

/** PURE: submissions-JSON "recent" arrays → FilingRecord[] (13F-HR + /A only, newest first).
 *  Exported so the index-shape handling is unit-testable without the network. */
export function parseSubmissionsIndex(cik: string, submissions: any): FilingRecord[] {
  const r = submissions?.filings?.recent;
  if (!r?.form || !r?.accessionNumber) throw new Error(`EDGAR submissions for CIK ${cik}: unexpected shape`);
  const out: FilingRecord[] = [];
  for (let i = 0; i < r.form.length; i++) {
    const form = String(r.form[i]);
    if (form !== "13F-HR" && form !== "13F-HR/A") continue;
    out.push({
      cik: padCik(cik),
      form,
      accession: String(r.accessionNumber[i]),
      period: String(r.reportDate[i] ?? ""),
      filedDate: String(r.filingDate[i] ?? ""),
    });
  }
  return out; // "recent" is already newest-first
}

/** PURE: pick the info-table XML filename out of a filing's index.json file list. The table is the
 *  only OTHER .xml beside primary_doc.xml; filers name it freely (infotable.xml, form13fInfoTable
 *  .xml, …), so we match by exclusion + common patterns and throw when ambiguous. */
export function pickInfoTableFile(files: { name: string }[]): string {
  const xmls = files.map((f) => f.name).filter((n) => /\.xml$/i.test(n) && !/primary_doc\.xml$/i.test(n));
  if (xmls.length === 1) return xmls[0];
  const byPattern = xmls.filter((n) => /info.*table|form13f/i.test(n));
  if (byPattern.length === 1) return byPattern[0];
  throw new Error(`EDGAR filing index: cannot identify the info-table XML among [${xmls.join(", ")}]`);
}

/** PURE: extract <amendmentType> from a 13F-HR/A primary_doc.xml (RESTATEMENT | NEW HOLDINGS). */
export function parseAmendmentType(primaryDocXml: string): string | undefined {
  const m = /<(?:[A-Za-z0-9_]+:)?amendmentType\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?amendmentType>/i.exec(primaryDocXml);
  return m ? m[1].trim().toUpperCase() : undefined;
}

/** Live EDGAR adapter. Accession→CIK context is remembered from the last filingIndex call so
 *  fetchInfoTable(accession) can build the Archives path (the port keeps the design-doc signature). */
export function edgarLive(): EdgarPort {
  const accessionCik = new Map<string, string>(); // accession → unpadded cik for Archives paths

  async function filingIndex(cik: string): Promise<FilingRecord[]> {
    const res = await throttled(`https://data.sec.gov/submissions/CIK${padCik(cik)}.json`);
    const recs = parseSubmissionsIndex(cik, await res.json());
    for (const r of recs) accessionCik.set(r.accession, padCik(cik).replace(/^0+/, ""));
    // Amendments: resolve amendmentType lazily in fetchInfoTable? No — the STORE needs it at
    // record time, so resolve it here for /A rows (few per manager; throttle keeps us polite).
    for (const r of recs) {
      if (r.form !== "13F-HR/A") continue;
      try {
        const base = archiveBase(r.accession);
        const doc = await throttled(`${base}/primary_doc.xml`);
        r.amendmentType = parseAmendmentType(await doc.text());
      } catch {
        // Missing/odd primary_doc: leave amendmentType undefined — store treats an untyped /A as
        // RESTATEMENT (the conservative read: SEC guidance says an untyped amendment restates).
      }
    }
    return recs;
  }

  function archiveBase(accession: string): string {
    const cik = accessionCik.get(accession);
    if (!cik) throw new Error(`EDGAR: no CIK context for accession ${accession} — call filingIndex first`);
    return `https://www.sec.gov/Archives/edgar/data/${cik}/${accessionNoDashes(accession)}`;
  }

  return {
    filingIndex,
    async latest13F(cik: string, period?: string): Promise<FilingRecord | null> {
      const recs = await filingIndex(cik);
      const pool = period ? recs.filter((r) => r.period === period) : recs;
      if (!pool.length) return null;
      // Newest-first already; for a fixed period the newest filing (amendment) wins.
      return pool[0];
    },
    async fetchInfoTable(accession: string): Promise<string> {
      const base = archiveBase(accession);
      const idx = await throttled(`${base}/index.json`);
      const j: any = await idx.json();
      const files: { name: string }[] = (j?.directory?.item ?? []).map((it: any) => ({ name: String(it.name) }));
      const file = pickInfoTableFile(files);
      const doc = await throttled(`${base}/${file}`);
      return doc.text();
    },
  };
}
