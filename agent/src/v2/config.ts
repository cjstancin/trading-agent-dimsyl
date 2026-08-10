// Bull v2 — journaled config store (design §10, LEI rules-editor pattern). Committed defaults
// (config/v2.defaults.json = the design-doc numbers) + a runtime amendment journal
// (runtime/v2/config-journal.jsonl: one {ts, author, path, from, to, evidence} per line, applied
// forward in order). The effective config is defaults with the journal folded on top; its VERSION
// ("v2c-<defaultsHash8>+<journalCount>") is stamped on every order intent and report stretch so any
// trade can be traced to the exact dials that produced it.
//
// Safety non-tunables are CODE, not config: paper-only assertion, the −25% floor, reallocation-on-
// schedule-only, and the quarantine. An amendment whose path touches one is REFUSED loudly.
// Equity-indexed schedules (position counts, slots) stay in config as SCHEDULES — code reads live
// equity against them, so growth needs no amendment (living-design rule).
import { readFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

export const DEFAULTS_PATH = fileURLToPath(new URL("../../config/v2.defaults.json", import.meta.url));
export const JOURNAL_PATH = fileURLToPath(new URL("../../runtime/v2/config-journal.jsonl", import.meta.url));

/** Dial paths no amendment may touch — enforced here AND intentionally duplicated as code constants
 *  at their use sites (defense in depth: config can't weaken them even if this list regresses). */
const NON_TUNABLE_PREFIXES = ["thesisCheck.hardFloorPct", "book.sleeveSplit", "paper", "quarantine"];

export interface ConfigAmendment {
  ts: string;       // ISO timestamp
  author: string;   // "cj" | "bill-proposal-approved" | …
  path: string;     // dot path into the config object, e.g. "momentum.holdings.minOrderUsd"
  from: unknown;    // value being replaced (recorded for the audit trail; not enforced)
  to: unknown;
  evidence?: string; // one-line why (digest link, report stretch)
}

export interface EffectiveConfig {
  version: string;
  config: any;
  amendments: ConfigAmendment[];
}

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function setPath(obj: any, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== "object" || cur[parts[i]] === null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

export function getPath(obj: any, path: string): unknown {
  return path.split(".").reduce((c: any, k) => (c == null ? undefined : c[k]), obj);
}

export function isNonTunable(path: string): boolean {
  return NON_TUNABLE_PREFIXES.some((p) => path === p || path.startsWith(p + "."));
}

/** Parse journal lines (skips blanks; a malformed line THROWS — a corrupt journal must halt, not
 *  silently drop an amendment someone approved). */
export function parseJournal(text: string): ConfigAmendment[] {
  const out: ConfigAmendment[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const a = JSON.parse(t) as ConfigAmendment;
    if (!a.ts || !a.author || !a.path || !("to" in a)) throw new Error(`config journal: malformed amendment: ${t.slice(0, 120)}`);
    out.push(a);
  }
  return out;
}

/** Pure core: fold amendments over defaults. Exposed for tests. */
export function foldConfig(defaults: any, amendments: ConfigAmendment[], defaultsRaw: string): EffectiveConfig {
  const cfg = deepClone(defaults);
  for (const a of amendments) {
    if (isNonTunable(a.path)) throw new Error(`config journal: amendment touches non-tunable "${a.path}" — refused`);
    setPath(cfg, a.path, a.to);
  }
  const hash8 = createHash("sha256").update(defaultsRaw).digest("hex").slice(0, 8);
  return { version: `v2c-${hash8}+${amendments.length}`, config: cfg, amendments };
}

/** Load the effective config from disk (defaults + journal). */
export function loadConfig(defaultsPath: string = DEFAULTS_PATH, journalPath: string = JOURNAL_PATH): EffectiveConfig {
  const raw = readFileSync(defaultsPath, "utf8");
  const defaults = JSON.parse(raw);
  const amendments = existsSync(journalPath) ? parseJournal(readFileSync(journalPath, "utf8")) : [];
  return foldConfig(defaults, amendments, raw);
}

/** Append one amendment to the journal (validates against non-tunables FIRST; creates the runtime
 *  dir on first write). Approval happens upstream (CJ's queue) — this is the write path only. */
export function appendAmendment(a: ConfigAmendment, journalPath: string = JOURNAL_PATH): void {
  if (isNonTunable(a.path)) throw new Error(`config amendment touches non-tunable "${a.path}" — refused`);
  if (!a.ts || !a.author || !a.path) throw new Error("config amendment needs ts, author, path");
  mkdirSync(dirname(journalPath), { recursive: true });
  appendFileSync(journalPath, JSON.stringify(a) + "\n", "utf8");
}

/** Resolve an equity-indexed schedule row: first row whose sleeveUsdBelow is null or > sleeveUsd.
 *  (Design: schedules are code reading live equity — growth needs no amendment.) */
export function scheduleLookup<T extends { sleeveUsdBelow: number | null }>(schedule: T[], sleeveUsd: number): T {
  for (const row of schedule) if (row.sleeveUsdBelow === null || sleeveUsd < row.sleeveUsdBelow) return row;
  return schedule[schedule.length - 1];
}
