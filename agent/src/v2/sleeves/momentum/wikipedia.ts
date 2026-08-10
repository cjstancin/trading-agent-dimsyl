// Bull v2 — Wikipedia constituent scraper (real UniversePort adapter). The two list pages carry a
// wikitable with id="constituents"; we parse it with header-driven column detection (regex, zero
// deps) rather than fixed column indexes — Wikipedia editors reorder columns without warning, and a
// positional parser would silently swap tickers for CIKs. The parser is PURE (html in, rows out) so
// fixtures cover it offline; only fetchConstituents touches the network.
//
// Failure posture: loud. An unparseable page or an implausibly small row count THROWS — upstream,
// buildUniverse refuses an empty universe, and the monthly delta detector catches the subtler case
// of a HALF-broken parse (>15% MoM symbol churn → approvals row, no trading on garbage).
import { withTimeout, DEFAULT_TIMEOUT_MS } from "../../../http-utils.js";
import type { UniversePort, WikiConstituent } from "./ports.js";

export const SP500_URL = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies";
export const SP400_URL = "https://en.wikipedia.org/wiki/List_of_S%26P_400_companies";

// Wikipedia's API etiquette wants an identifying UA with contact info; a generic UA gets throttled.
const USER_AGENT = "bull-v2-momentum/0.1 (paper-trading research; cj@dimsylaisolutions.com)";

// Sanity floors: the S&P 500 has ~503 rows, the 400 has ~401. Half a table = broken parse.
const MIN_ROWS: Record<"sp500" | "sp400", number> = { sp500: 400, sp400: 300 };

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, " ")
    .trim();
}

/** Pure parser: extract constituents from a list page's HTML. Finds the table with
 *  id="constituents", locates columns by HEADER TEXT (symbol/ticker, GICS sector, CIK), then walks
 *  the data rows. Throws when the table or the symbol column can't be found. */
export function parseConstituentsHtml(html: string, list: "sp500" | "sp400"): WikiConstituent[] {
  const tableMatch = /<table[^>]*id="constituents"[^>]*>([\s\S]*?)<\/table>/i.exec(html);
  if (!tableMatch) throw new Error(`wikipedia ${list}: no table with id="constituents" — page layout changed`);
  const table = tableMatch[1];

  const rows = table.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
  if (rows.length < 2) throw new Error(`wikipedia ${list}: constituents table has no rows`);

  // Header-driven column mapping.
  const headerCells = ((rows[0] ?? "").match(/<th[\s\S]*?<\/th>/gi) ?? []).map(stripTags);
  const findCol = (re: RegExp): number => headerCells.findIndex((h) => re.test(h));
  const symbolCol = findCol(/^(symbol|ticker)/i);
  const securityCol = findCol(/^(security|company)/i);
  const sectorCol = findCol(/gics\s*sector/i);
  const cikCol = findCol(/^cik/i);
  if (symbolCol < 0) throw new Error(`wikipedia ${list}: no Symbol/Ticker column in [${headerCells.join(" | ")}]`);

  const out: WikiConstituent[] = [];
  for (let i = 1; i < rows.length; i++) {
    const cells = (rows[i].match(/<td[\s\S]*?<\/td>/gi) ?? []).map(stripTags);
    if (cells.length <= symbolCol) continue;                    // header-only / spacer rows
    const symbol = cells[symbolCol].toUpperCase().replace(/\s+/g, "");
    if (!/^[A-Z0-9.\-]{1,8}$/.test(symbol)) continue;           // junk row, not a ticker
    const cikRaw = cikCol >= 0 && cells[cikCol] ? cells[cikCol].replace(/\D/g, "") : "";
    out.push({
      symbol,
      security: securityCol >= 0 ? (cells[securityCol] ?? "") : "",
      sector: sectorCol >= 0 ? (cells[sectorCol] ?? "") : "",
      cik: cikRaw ? cikRaw.padStart(10, "0") : null,
      list,
    });
  }
  return out;
}

async function fetchPage(url: string): Promise<string> {
  const res = await withTimeout(
    (signal) => fetch(url, { headers: { "User-Agent": USER_AGENT }, signal }),
    DEFAULT_TIMEOUT_MS,
  );
  if (!res.ok) throw new Error(`wikipedia fetch ${url} → ${res.status}`);
  return res.text();
}

/** Real adapter: fetch + parse both list pages, enforce plausibility floors, merge. */
export const wikipediaUniversePort: UniversePort = {
  async fetchConstituents(): Promise<WikiConstituent[]> {
    const [html500, html400] = await Promise.all([fetchPage(SP500_URL), fetchPage(SP400_URL)]);
    const sp500 = parseConstituentsHtml(html500, "sp500");
    const sp400 = parseConstituentsHtml(html400, "sp400");
    if (sp500.length < MIN_ROWS.sp500) throw new Error(`wikipedia sp500: only ${sp500.length} rows parsed (< ${MIN_ROWS.sp500}) — refusing`);
    if (sp400.length < MIN_ROWS.sp400) throw new Error(`wikipedia sp400: only ${sp400.length} rows parsed (< ${MIN_ROWS.sp400}) — refusing`);
    return [...sp500, ...sp400];
  },
};
