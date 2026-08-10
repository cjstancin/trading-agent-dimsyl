// Bull v2 insider sleeve — ingestion orchestration (design: EDGAR Atom feed getcurrent&type=4
// polled every 2–5 min 06:00–22:05 ET weekdays; nightly daily-index reconciliation; dedupe by
// accession — index rows repeat once per FILER; 4/A supersedes by transaction key and re-qualifies
// the cluster, with a live position whose cluster dies getting a thesis-review flag, never an
// auto-sell). This module owns the PARSING (pure, fixture-tested) and the per-accession pipeline;
// the actual timer lives with Phase 4/5 scheduling — pollDelaySeconds/shouldPollNow are the
// contract it consumes.
import type { DatabaseSync } from "node:sqlite";
import { parseForm4 } from "./form4.js";
import type { EdgarPort } from "./ports.js";
import { accessionSeen, logAccession, storeForm4 } from "./store.js";
import { requalifyCluster } from "./exits.js";
import type { ClusterCfg } from "./cluster.js";

export interface FeedEntry {
  accession: string;
  formType: string;    // "4" | "4/A"
  cik: string;         // filer/issuer CIK usable for the archive path
  updated?: string;
}

/** Parse the getcurrent Atom feed. Only forms 4 and 4/A survive (the feed can interleave other
 *  ownership forms when EDGAR is busy). Accession from the <id> urn; CIK from the entry link's
 *  /Archives/edgar/data/{cik}/ path (any filer's CIK resolves the archive — EDGAR mirrors the
 *  filing under every filer). Deduped by accession within the page. */
export function parseAtomForm4Entries(xml: string): FeedEntry[] {
  const out: FeedEntry[] = [];
  const seen = new Set<string>();
  const entryRe = /<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(xml)) !== null) {
    const e = m[1];
    const term = /<category[^>]*\bterm\s*=\s*"([^"]+)"/.exec(e)?.[1] ?? "";
    if (term !== "4" && term !== "4/A") continue;
    const acc = /accession-number=([\d-]+)/.exec(e)?.[1];
    if (!acc || seen.has(acc)) continue;
    const cik = /\/Archives\/edgar\/data\/(\d+)\//.exec(e)?.[1]
      ?? /\((\d{7,10})\)/.exec(e)?.[1]; // fallback: "(0001234567)" in the title
    if (!cik) continue;
    seen.add(acc);
    out.push({
      accession: acc,
      formType: term,
      cik,
      updated: /<updated(?:\s[^>]*)?>([^<]+)<\/updated>/.exec(e)?.[1]?.trim(),
    });
  }
  return out;
}

/** Parse a daily form index (form.YYYYMMDD.idx): fixed-ish columns "Form Type / Company / CIK /
 *  Date Filed / File Name". A filing appears ONCE PER FILER (issuer + each reporting owner) —
 *  dedupe by accession is the whole reason this parser exists. */
export function parseDailyIndexForm4(text: string): FeedEntry[] {
  const out: FeedEntry[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^(4(?:\/A)?)\s{2,}.*?\s{2,}(\d+)\s{2,}(\d{4}-?\d{2}-?\d{2})\s{2,}(\S+\.txt)\s*$/.exec(line.trim().length ? line : "");
    if (!m) continue;
    const file = m[4];
    const acc = /(\d{10}-\d{2}-\d{6})\.txt$/.exec(file)?.[1];
    if (!acc || seen.has(acc)) continue;
    seen.add(acc);
    out.push({ accession: acc, formType: m[1], cik: m[2] });
  }
  return out;
}

/** Poll window guard: weekdays 06:00–22:05 ET (Form 4s disseminate until 10pm ET; the 22:05 tail
 *  catches the last batch). Caller passes ET wall-clock parts — this stays pure/testable. */
export function shouldPollNow(etWeekday: number, etHHMM: string): boolean {
  if (etWeekday === 0 || etWeekday === 6) return false; // Sun/Sat
  return etHHMM >= "06:00" && etHHMM <= "22:05";
}

/** Next poll delay: uniform in [pollSecondsMin, pollSecondsMax] (config). Jitter is deliberate —
 *  a fixed cadence synchronized with EDGAR's own batch ticks would alias the feed. */
export function pollDelaySeconds(cfg: { pollSecondsMin: number; pollSecondsMax: number }): number {
  const span = Math.max(cfg.pollSecondsMax - cfg.pollSecondsMin, 0);
  return cfg.pollSecondsMin + Math.floor(Math.random() * (span + 1));
}

export interface ProcessResult {
  accession: string;
  status: "processed" | "skipped" | "error";
  symbol?: string;
  qualifyingBuys?: number;
  superseded?: number;
  deadClusters?: string[];
  error?: string;
}

/** Fetch + parse + store ONE accession. Idempotent (ins_accessions ledger). On a 4/A that
 *  superseded rows, every active cluster on that symbol is re-qualified — a dead cluster with a
 *  live position raises the thesis-review approval inside requalifyCluster. */
export async function processAccession(
  db: DatabaseSync, edgar: EdgarPort, entry: FeedEntry, source: string, clusterCfg: ClusterCfg,
): Promise<ProcessResult> {
  if (accessionSeen(db, entry.accession)) return { accession: entry.accession, status: "skipped" };
  try {
    const raw = await edgar.getFiling(entry.accession, entry.cik);
    const parsed = parseForm4(raw);
    const res = storeForm4(db, entry.accession, parsed, entry.updated ?? null);
    logAccession(db, {
      accession: entry.accession, formType: parsed.documentType || entry.formType,
      issuerCik: parsed.issuerCik, symbol: parsed.symbol, source, status: "processed",
    });

    const deadClusters: string[] = [];
    if (res.superseded > 0) {
      const rows = db.prepare(
        "SELECT cluster_id FROM ins_clusters WHERE symbol=? AND status='active'",
      ).all(parsed.symbol) as { cluster_id: string }[];
      for (const r of rows) {
        if (requalifyCluster(db, r.cluster_id, clusterCfg) === "dead") deadClusters.push(r.cluster_id);
      }
    }
    return {
      accession: entry.accession, status: "processed", symbol: parsed.symbol,
      qualifyingBuys: res.qualifyingBuys, superseded: res.superseded, deadClusters,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logAccession(db, { accession: entry.accession, formType: entry.formType, source, status: "error", note: msg.slice(0, 200) });
    return { accession: entry.accession, status: "error", error: msg };
  }
}

/** One Atom poll pass: fetch feed → new accessions → process each. Returns per-accession results
 *  (the caller decides whether new qualifying buys warrant a cluster re-scan). */
export async function pollOnce(db: DatabaseSync, edgar: EdgarPort, clusterCfg: ClusterCfg): Promise<ProcessResult[]> {
  const xml = await edgar.getCurrentForm4Atom();
  const entries = parseAtomForm4Entries(xml);
  const out: ProcessResult[] = [];
  for (const e of entries) out.push(await processAccession(db, edgar, e, "atom", clusterCfg));
  return out;
}

/** Nightly reconciliation: the daily index is the truth the best-effort Atom poll is checked
 *  against. Any accession the poll missed is fetched + processed here. */
export async function reconcileDaily(db: DatabaseSync, edgar: EdgarPort, date: string, clusterCfg: ClusterCfg): Promise<{
  indexed: number; missed: number; results: ProcessResult[];
}> {
  const text = await edgar.getDailyIndex(date);
  const entries = parseDailyIndexForm4(text);
  const missing = entries.filter((e) => !accessionSeen(db, e.accession));
  const results: ProcessResult[] = [];
  for (const e of missing) results.push(await processAccession(db, edgar, e, "daily-index", clusterCfg));
  return { indexed: entries.length, missed: missing.length, results };
}
