// Bull v2 — Anchor sleeve shared types (design: 13F best-ideas clone). The sleeve clones the top-5
// holdings of four CJ-LOCKED managers (Berkshire / TCI / AltaRock / Himalaya — config
// anchor.managers) into equal manager slots. Everything downstream of the EDGAR fetch is PURE and
// port-driven so every behavior is testable offline against XML fixtures: EdgarPort (filings),
// MappingPort (CUSIP→ticker), PricePort (TTM performance-guard math). 13F dollar values are
// bigint INTEGER DOLLARS (the SEC reports integers; pre-2023 filings report thousands — see
// infotable.ts normalization); weights are d9 fractions (decimal.ts) — no float ever touches a
// reported number.
import type { D9 } from "../../decimal.js";

/** One manager row from config anchor.managers (CJ-locked; code never edits the set). */
export interface ManagerCfg {
  name: string;
  cik: string;   // zero-padded 10-digit SEC CIK, e.g. "0001067983"
  note?: string; // e.g. "transition-watch" (Berkshire) — surfaced in reports, no behavior change
}

/** One <infoTable> row from a 13F information table, values normalized to integer dollars. */
export interface InfoTableLine {
  nameOfIssuer: string;
  titleOfClass: string;
  cusip: string;        // 9 chars as filed (uppercased, no spaces)
  valueUsd: bigint;     // integer dollars (post-normalization — see normalizeInfoTableValue)
  shares: bigint;       // sshPrnamt (integer; PRN rows carry principal amount here)
  shType: string;       // "SH" (shares) | "PRN" (principal — debt, never cloneable)
  putCall?: string;     // "Put" | "Call" when the row is an option position
}

/** An InfoTableLine after CUSIP→ticker resolution. symbol=null = mapping failed (flag, never guess). */
export interface MappedLine extends InfoTableLine {
  symbol: string | null;
}

/** 13F filing metadata (from the EDGAR submissions index / primary_doc). */
export interface FilingRecord {
  cik: string;
  period: string;          // periodOfReport YYYY-MM-DD (quarter end)
  accession: string;       // e.g. "0000950123-26-008888"
  form: string;            // "13F-HR" | "13F-HR/A"
  amendmentType?: string;  // "RESTATEMENT" (replaces table) | "NEW HOLDINGS" (additive) — /A only
  filedDate: string;       // YYYY-MM-DD
}

/** EDGAR read surface. Real adapter in edgar.ts (throttled, declared User-Agent); tests use a
 *  fixture adapter over authored XML. fetchInfoTable returns the RAW info-table XML — parsing is a
 *  separate pure step (infotable.ts) so a format surprise fails loudly in one place. */
export interface EdgarPort {
  /** All 13F-HR / 13F-HR/A filings for a CIK, newest first. */
  filingIndex(cik: string): Promise<FilingRecord[]>;
  /** Latest 13F for a CIK; when `period` is given, latest filing FOR that quarter (amendments win). */
  latest13F(cik: string, period?: string): Promise<FilingRecord | null>;
  /** Raw information-table XML for one accession. */
  fetchInfoTable(accession: string): Promise<string>;
}

/** CUSIP→ticker resolution. Real adapter documented in mapping.ts (OpenFIGI, SEC fallback);
 *  a null return means "could not resolve" — the caller flags the line into approvals. */
export interface MappingPort {
  tickerForCusip(cusip: string, issuerHint?: string): Promise<string | null>;
}

/** Price reads for the TTM performance guard + rebuild planning. Real adapter wraps the v1 Alpaca
 *  data client (prices.ts); tests use fixtures. All prices d9. */
export interface PricePort {
  latestPrice9(symbol: string): Promise<D9 | null>;
  /** Close on (or the nearest session before) an ET date key. */
  priceOn9(symbol: string, dateKey: string): Promise<D9 | null>;
}

/** One manager's slot after the clone math: surviving top-5 lines with d9 weights that sum EXACTLY
 *  to slotMass9 minus residual9 (residual only when the 40% line cap makes full allocation
 *  infeasible, i.e. fewer than ceil(1/cap) surviving lines). */
export interface ManagerSlot {
  manager: string;
  cik: string;
  slotMass9: D9;                                   // this manager's share of the sleeve (≈ 1/N)
  lines: { symbol: string; cusip: string; weight9: D9; valueUsd: bigint }[];
  excluded: ExcludedLine[];                        // audit trail: what fell out and why
  residual9: D9;                                   // un-allocatable slot mass (stays cash)
}

export type ExcludeReason =
  | "option-row"        // putCall set — a derivative, not a conviction holding
  | "non-share"         // sshPrnamtType != SH (principal-amount debt line)
  | "parking-etf"       // SGOV-type cash parking / ETF line
  | "non-common-class"  // preferred / warrant / note / unit title
  | "recursion"         // BRK.A/B inside another manager's top-5 while Berkshire is a slot
  | "mapping-failure";  // CUSIP→ticker unresolved — flagged to approvals, never guessed

export interface ExcludedLine {
  reason: ExcludeReason;
  nameOfIssuer: string;
  cusip: string;
  valueUsd: bigint;
  detail?: string;
}

/** Full clone build: per-manager slots + the cross-manager aggregate target weights. */
export interface CloneBuild {
  periodTag: string;                 // the quarter this build derives from, e.g. "2026-06-30"
  slots: ManagerSlot[];
  targets: Map<string, D9>;          // symbol → weight9 (fraction of sleeve); duplicates merged
  totalWeight9: D9;                  // Σ targets (= 1.0 exactly unless some slot left residual)
  flags: ExcludedLine[];             // mapping failures across managers → approvals rows
}

/** Filing summary used by the drift-watch detectors — computed from the CURRENT (post-amendment)
 *  table so a restatement re-scores the quarter. Weights keyed by cusip (mapping-independent). */
export interface FilingSummary {
  cik: string;
  manager: string;
  period: string;
  totalValueUsd: bigint;             // Σ value over ALL lines (incl. non-equity)
  count: number;
  weights: Map<string, D9>;          // cusip → fraction of totalValueUsd
  top5Keys: string[];                // top-5 cusips by value
  top5Share9: D9;
  top10Share9: D9;
  nonEquityShare9: D9;               // options + PRN + parking-ETF + non-common share of value
}

/** One drift-watch detector hit. NEVER acts — flagDrift() writes it to the approvals queue. */
export type DriftDetector =
  | "deconcentration"
  | "name-churn"
  | "weight-turnover"
  | "aum-anomaly"
  | "representativeness"
  | "performance-guard"
  | "liveness";

export interface DriftHit {
  detector: DriftDetector;
  level: "warn" | "eject";
  manager: string;
  cik: string;
  period: string;
  evidence: Record<string, unknown>;
}

/** A planned (not yet placed) rebuild order. Executed via the shared order gateway only. */
export interface PlannedOrder {
  symbol: string;
  side: "buy" | "sell";
  intent: "buy" | "sell";
  qty9?: D9;        // sells: share quantity (capped at held)
  notional9?: D9;   // buys: dollar notional
  estPrice9: D9;
  reason: string;   // "initial-build" | "manager-follow" | "drift>band" | "membership-change" …
}
