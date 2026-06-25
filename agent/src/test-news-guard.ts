// Tests for the news/input hardening (no network). Run: npm run test:news-guard
import { normalizeText, hasSuspiciousChars, normalizeTicker, cleanTickers, isTrustedTicker } from "./news-guard.js";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean) => { (cond ? pass++ : fail++); console.log(`${cond ? "PASS" : "FAIL"} — ${name}`); };

// homoglyph ticker (Cyrillic А = А) — detected + stripped to ASCII
check("suspicious: detects non-ASCII homoglyph", hasSuspiciousChars("АAPL") === true);
check("suspicious: clean ticker is fine", hasSuspiciousChars("AAPL") === false);
check("normalizeTicker: uppercases + strips junk; homoglyph loses the non-ASCII char", normalizeTicker(" aapl ") === "AAPL" && normalizeTicker("АAPL") === "APL");

// hidden-HTML sentiment flip — stripped with its content
{
  const t = normalizeText('Beat <span style="display:none">missed badly</span> earnings');
  check("normalizeText: removes hidden-HTML content", !/missed/i.test(t) && /Beat/.test(t) && /earnings/.test(t));
}
check("normalizeText: drops tags + zero-width chars", normalizeText("<b>Hi</b>​ there") === "Hi there");

// authoritative cross-check
{
  const tradable = new Set(["AAPL", "MSFT"]);
  const { valid, rejected } = cleanTickers(["AAPL", "АAPL", "FAKE9"], tradable);
  check("cleanTickers: keeps the real tradable symbol", valid.length === 1 && valid[0] === "AAPL");
  check("cleanTickers: rejects homoglyph + non-tradable", rejected.length === 2);
}
check("isTrustedTicker: real + tradable → true", isTrustedTicker("AAPL", new Set(["AAPL"])) === true);
check("isTrustedTicker: homoglyph → false", isTrustedTicker("АAPL", new Set(["AAPL"])) === false);
check("isTrustedTicker: empty set fails open (never block on API down)", isTrustedTicker("AAPL", new Set()) === true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
