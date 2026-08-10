// Bull v2 — Anchor: 13F information-table XML parser. Zero-dependency by design (the fleet rule:
// no new deps for a format this small) — the info table is a flat list of <infoTable> blocks with
// scalar children, so a namespace-tolerant regex walk is both sufficient and auditable. A row that
// doesn't parse THROWS: a silently dropped holding would corrupt the clone weights, and the evening
// filing run would trade on them the next open.
//
// Value normalization (the 2023 rule change): 13F <value> was reported in THOUSANDS of dollars
// until the EDGAR technical-spec change effective for filings covering periods ending 2022-12-31
// and later, which switched to ACTUAL dollars. We normalize by period (authoritative for our four
// deadline-day filers) with an optional explicit override for weird re-filed history. Heuristic
// guard: a modern-period table whose TOTAL is under $10M for a multi-billion manager would smell
// like thousands — we don't auto-correct (guessing on money is worse than failing), but
// summarize() exposes the total so the drift-watch AUM detector catches a 1000× discontinuity.
import type { InfoTableLine } from "./types.js";

/** Period-of-report boundary for the thousands→dollars switch (SEC 13F spec change, adopted with
 *  the Q4-2022 filing season). Periods ENDING on/after this date report actual dollars. */
export const VALUE_IN_DOLLARS_FROM_PERIOD = "2022-12-31";

export type ValueUnit = "dollars" | "thousands";

/** Which unit a filing's <value> column uses, from its period-of-report (overridable). */
export function valueUnitForPeriod(period: string, override?: ValueUnit): ValueUnit {
  if (override) return override;
  return period >= VALUE_IN_DOLLARS_FROM_PERIOD ? "dollars" : "thousands";
}

/** Extract the text of the first child tag matching `name` (namespace-prefix tolerant:
 *  <value>, <ns1:value>, <n1:value> all match). Returns null when absent. */
function tag(block: string, name: string): string | null {
  const re = new RegExp(`<(?:[A-Za-z0-9_]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[A-Za-z0-9_]+:)?${name}>`, "i");
  const m = re.exec(block);
  return m ? m[1].trim() : null;
}

/** Decode the handful of XML entities EDGAR actually emits in issuer names. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"');
}

/** Parse an integer money/share field. Tolerates commas and a trailing ".0…" decimal (a few filers
 *  emit them); anything else throws — a malformed number must halt, not become 0. */
function parseIntStrict(raw: string, field: string): bigint {
  const cleaned = raw.replace(/,/g, "").trim();
  const m = /^(-?\d+)(?:\.0*)?$/.exec(cleaned);
  if (!m) throw new Error(`infotable: unparseable ${field} "${raw}"`);
  return BigInt(m[1]);
}

/** Parse one information-table XML document into normalized lines (values in integer DOLLARS).
 *  `period` drives the thousands→dollars normalization; pass `valueUnit` to override. */
export function parseInfoTable(xml: string, period: string, valueUnit?: ValueUnit): InfoTableLine[] {
  const unit = valueUnitForPeriod(period, valueUnit);
  const blocks = xml.match(/<(?:[A-Za-z0-9_]+:)?infoTable\b[\s\S]*?<\/(?:[A-Za-z0-9_]+:)?infoTable>/gi) ?? [];
  if (blocks.length === 0 && /informationTable/i.test(xml) === false) {
    throw new Error("infotable: document does not look like a 13F information table");
  }
  const out: InfoTableLine[] = [];
  for (const block of blocks) {
    const nameOfIssuer = tag(block, "nameOfIssuer");
    const titleOfClass = tag(block, "titleOfClass");
    const cusip = tag(block, "cusip");
    const value = tag(block, "value");
    const sshPrnamt = tag(block, "sshPrnamt");
    const shType = tag(block, "sshPrnamtType");
    if (!nameOfIssuer || !titleOfClass || !cusip || !value || !sshPrnamt || !shType) {
      throw new Error(`infotable: incomplete infoTable row: ${block.slice(0, 200)}`);
    }
    const rawValue = parseIntStrict(value, "value");
    const putCall = tag(block, "putCall") ?? undefined;
    out.push({
      nameOfIssuer: decodeEntities(nameOfIssuer),
      titleOfClass: decodeEntities(titleOfClass).toUpperCase(),
      cusip: cusip.replace(/\s+/g, "").toUpperCase(),
      valueUsd: unit === "thousands" ? rawValue * 1000n : rawValue,
      shares: parseIntStrict(sshPrnamt, "sshPrnamt"),
      shType: shType.toUpperCase(),
      ...(putCall ? { putCall } : {}),
    });
  }
  return out;
}
