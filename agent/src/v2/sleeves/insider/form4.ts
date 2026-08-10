// Bull v2 insider sleeve — Form 4 XML parser + buy/sell classification (design cluster filter,
// live-verified against EDGAR 2026-08-10).
//
// Parsing choice: regex/string extraction, NO new deps. EDGAR's ownershipDocument XML is machine-
// generated from a fixed schema (X0409/X0609 etc.) — flat, unambiguous tag names, no namespaces on
// the elements we read, no CDATA in the numeric fields — so a tag-block extractor that tolerates
// attribute order and whitespace covers the real corpus. A full XML parser would add a dependency
// for zero additional correctness on this schema, and the fixtures pin the exact shapes we accept.
// Every numeric field goes through d9 (string math) — never parseFloat on a reported number.
//
// Classification rules (verbatim from the locked design):
//   - Code P ONLY, in the NON-derivative table, with transactionAcquiredDisposedCode = "A".
//     M-exercises also appear as acquisitions ("A") and are NOT buys — code filter catches them,
//     as it does S,A,F,C,X,G,J,K,U,W,D,I,L,Z.
//   - 10b5-1 plans excluded two ways: the aff10b5One checkbox (verified live on schema X0609) AND
//     a /10b5-?1/i regex over the txn's referenced footnotes + remarks (older schemas have no
//     checkbox; filers disclose the plan in a footnote instead).
//   - DRIP/ESPP/401(k) footnotes → exclude (not discretionary conviction, just plumbing).
import { d9, mul9, type D9 } from "../../decimal.js";

export interface Form4Owner {
  cik: string;           // normalized (leading zeros stripped) — CIKs join across filings
  name: string;
  isDirector: boolean;
  isOfficer: boolean;
  isTenPercentOwner: boolean;
  isOther: boolean;
  officerTitle: string | null;
}

export interface Form4Txn {
  table: "nonDerivative" | "derivative";
  code: string;                    // P, S, M, A, F, …
  acquiredDisposed: string;        // "A" | "D" | ""
  date: string;                    // YYYY-MM-DD trade date
  shares9: D9;
  price9: D9;
  sharesAfter9: D9 | null;         // sharesOwnedFollowingTransaction (conviction Δown%)
  footnoteIds: string[];
}

export interface ParsedForm4 {
  documentType: string;            // "4" | "4/A"
  periodOfReport: string;
  aff10b5One: boolean;
  issuerCik: string;
  issuerName: string;
  symbol: string;
  owners: Form4Owner[];
  txns: Form4Txn[];
  footnotes: Record<string, string>;
  remarks: string;
}

// ---------- tag extraction helpers (attribute-order + whitespace tolerant) ----------

function tagBlocks(src: string, tag: string): string[] {
  // <tag ...attrs...> body </tag> — attrs optional, any order; non-greedy body; case-preserving
  // (EDGAR emits exact camelCase tag names per schema).
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

function tagBlock(src: string, tag: string): string | null {
  const b = tagBlocks(src, tag);
  return b.length ? b[0] : null;
}

/** Text content of a tag, unwrapping the schema's <value> indirection when present
 *  (e.g. <transactionShares><value>5000</value></transactionShares>). */
function tagValue(src: string, tag: string): string {
  const b = tagBlock(src, tag);
  if (b === null) return "";
  const inner = tagBlock(b, "value");
  return (inner !== null ? inner : b).trim();
}

function boolValue(s: string): boolean {
  return s === "1" || /^true$/i.test(s);
}

/** Strip leading zeros so "0001234567" and "1234567" join as the same CIK. */
export function normalizeCik(raw: string): string {
  const t = raw.trim().replace(/^0+(?=\d)/, "");
  return t;
}

/** Parse a schema decimal into d9; EDGAR occasionally pads ("5000.0000"). Empty/absent → null. */
function num9(s: string): D9 | null {
  const t = s.trim();
  if (!t) return null;
  // Trim excess fractional digits beyond 9 (EDGAR shares/price never need more precision).
  const m = /^(-?\d+)(?:\.(\d*))?$/.exec(t);
  if (!m) return null;
  const frac = (m[2] ?? "").slice(0, 9);
  return d9(frac ? `${m[1]}.${frac}` : m[1]);
}

// ---------- parser ----------

/** Parse one Form 4 (raw XML, or a full-submission .txt with the XML embedded — we slice to the
 *  <ownershipDocument> element either way). Throws on a document with no ownershipDocument: a
 *  malformed filing must surface to the ingest error log, not silently parse to nothing. */
export function parseForm4(raw: string): ParsedForm4 {
  const start = raw.indexOf("<ownershipDocument");
  const end = raw.indexOf("</ownershipDocument>");
  if (start < 0 || end < 0) throw new Error("parseForm4: no <ownershipDocument> element");
  const doc = raw.slice(start, end + "</ownershipDocument>".length);

  const issuer = tagBlock(doc, "issuer") ?? "";
  const owners: Form4Owner[] = tagBlocks(doc, "reportingOwner").map((b) => {
    const rel = tagBlock(b, "reportingOwnerRelationship") ?? "";
    return {
      cik: normalizeCik(tagValue(b, "rptOwnerCik")),
      name: tagValue(b, "rptOwnerName"),
      isDirector: boolValue(tagValue(rel, "isDirector")),
      isOfficer: boolValue(tagValue(rel, "isOfficer")),
      isTenPercentOwner: boolValue(tagValue(rel, "isTenPercentOwner")),
      isOther: boolValue(tagValue(rel, "isOther")),
      officerTitle: tagValue(rel, "officerTitle") || null,
    };
  });

  const footnotes: Record<string, string> = {};
  for (const block of tagBlocks(doc, "footnotes")) {
    const re = /<footnote\s[^>]*id\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/footnote>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(block)) !== null) footnotes[m[1]] = m[2].trim();
  }

  const parseTxn = (b: string, table: Form4Txn["table"]): Form4Txn => {
    const coding = tagBlock(b, "transactionCoding") ?? "";
    const amounts = tagBlock(b, "transactionAmounts") ?? "";
    const post = tagBlock(b, "postTransactionAmounts") ?? "";
    const footnoteIds: string[] = [];
    const fRe = /<footnoteId\s[^>]*id\s*=\s*"([^"]+)"/g;
    let fm: RegExpExecArray | null;
    while ((fm = fRe.exec(b)) !== null) footnoteIds.push(fm[1]);
    return {
      table,
      code: tagValue(coding, "transactionCode").toUpperCase(),
      acquiredDisposed: tagValue(amounts, "transactionAcquiredDisposedCode").toUpperCase(),
      date: tagValue(b, "transactionDate"),
      shares9: num9(tagValue(amounts, "transactionShares")) ?? 0n,
      price9: num9(tagValue(amounts, "transactionPricePerShare")) ?? 0n,
      sharesAfter9: num9(tagValue(post, "sharesOwnedFollowingTransaction")),
      footnoteIds,
    };
  };

  const txns: Form4Txn[] = [];
  const ndTable = tagBlock(doc, "nonDerivativeTable");
  if (ndTable) for (const b of tagBlocks(ndTable, "nonDerivativeTransaction")) txns.push(parseTxn(b, "nonDerivative"));
  const dTable = tagBlock(doc, "derivativeTable");
  if (dTable) for (const b of tagBlocks(dTable, "derivativeTransaction")) txns.push(parseTxn(b, "derivative"));

  return {
    documentType: tagValue(doc, "documentType").trim(),
    periodOfReport: tagValue(doc, "periodOfReport"),
    aff10b5One: boolValue(tagValue(doc, "aff10b5One")),
    issuerCik: normalizeCik(tagValue(issuer, "issuerCik")),
    issuerName: tagValue(issuer, "issuerName"),
    symbol: tagValue(issuer, "issuerTradingSymbol").toUpperCase(),
    owners,
    txns,
    footnotes,
    remarks: tagValue(doc, "remarks"),
  };
}

// ---------- classification ----------

const RE_10B51 = /10b5-?1/i;
const RE_DRIP = /dividend\s+reinvestment|\bD\.?R\.?I\.?P\.?\b|employee\s+stock\s+purchase|\bESPP\b|401\s*\(?\s*k\s*\)?/i;

export type TxnClass =
  | { kind: "buy" }
  | { kind: "sell" }
  | { kind: "excluded"; reason: string };

/** Footnote text this transaction references (plus filing-level remarks — older schemas disclose
 *  plans there). Deliberately NOT all footnotes: another transaction's 10b5-1 note must not poison
 *  an unrelated open-market buy on the same filing. */
function referencedText(f: ParsedForm4, t: Form4Txn): string {
  const parts = t.footnoteIds.map((id) => f.footnotes[id] ?? "");
  parts.push(f.remarks);
  return parts.join("\n");
}

/** Classify one transaction per the design's cluster filter. Order matters for the audit trail:
 *  the most structural reason wins (wrong table/code before plan/DRIP footnotes). */
export function classifyTxn(f: ParsedForm4, t: Form4Txn): TxnClass {
  if (t.table !== "nonDerivative") return { kind: "excluded", reason: `table:derivative` };
  if (t.code === "S" && t.acquiredDisposed === "D") return { kind: "sell" };
  if (t.code !== "P") return { kind: "excluded", reason: `code:${t.code || "?"}` };
  if (t.acquiredDisposed !== "A") return { kind: "excluded", reason: `acquiredDisposed:${t.acquiredDisposed || "?"}` };
  if (f.aff10b5One) return { kind: "excluded", reason: "10b5-1-checkbox" };
  const notes = referencedText(f, t);
  if (RE_10B51.test(notes)) return { kind: "excluded", reason: "10b5-1-footnote" };
  if (RE_DRIP.test(notes)) return { kind: "excluded", reason: "drip-espp-401k" };
  return { kind: "buy" };
}

/** USD value of a transaction (qty × price, d9 exact). */
export function txnValue9(t: Form4Txn): D9 {
  return mul9(t.shares9, t.price9);
}

/** The owner a filing's transactions are attributed to. Joint filings (fund + affiliated persons)
 *  report ONE purchase under several reportingOwner blocks — attributing it to every owner would
 *  inflate "distinct insider CIKs" and fake a cluster out of a single decision. We pick one owner,
 *  preferring the human decision-maker: first officer, else first director, else owners[0]. */
export function primaryOwner(f: ParsedForm4): Form4Owner | null {
  if (!f.owners.length) return null;
  return f.owners.find((o) => o.isOfficer) ?? f.owners.find((o) => o.isDirector) ?? f.owners[0];
}
