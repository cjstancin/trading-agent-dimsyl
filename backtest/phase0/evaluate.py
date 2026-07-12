#!/usr/bin/env python3
"""
Phase 0 evaluator — the verdict step of the LLM edge test.

WHAT THIS DOES
--------------
Reads out/picks.jsonl (Sonnet 4.6's per-date rankings of the 18-ticker universe, produced by
phase0-picker.ts from prompts built by gen_prompts.py) plus the cached OHLC CSVs, recomputes
21-trading-day forward returns and the mechanical MOM5 baseline straight from prices, and
answers two questions:
  1. Does the LLM's top-5 beat top-5-by-63d-momentum OUT of its training window
     (OOS: decisions from 2026-02-02)?
  2. How much bigger was the apparent edge INSIDE the training window (IN: 2024-01-02 →
     2025-06-30) — i.e. the Glasserman & Lin "profit mirage" / memorization gap?
Sonnet 4.6 cutoffs: training data Jan 2026, reliable knowledge Aug 2025 — so the IN window is
memorization-contaminated by construction and the OOS window is clean.

Outputs: out/per_date.csv (one row per decision date), PHASE0_RESULTS.md (committed report in
the phase0 root), and a headline table + verdict on stdout.

Run:  python evaluate.py
"""
import json
import os
import sys

import numpy as np
import pandas as pd
from scipy import stats

# ───────────────────────── contract constants (must match gen_prompts.py) ─────────────────────────
UNIVERSE = [
    "AAPL", "MSFT", "NVDA", "GOOGL", "META", "AMZN", "HD",
    "JPM", "V", "XOM", "CVX", "UNH", "JNJ", "PG", "KO", "WMT", "CAT", "BA",
]
BENCH = "SPY"
HORIZON = 21        # forward-return horizon, trading days (positional on the SPY calendar)
TOPK = 5
BOOT_N = 10_000
SEED = 42
MIN_OOS = 5         # below this many usable OOS dates, refuse to issue a verdict
MIN_IN = 10         # below this many usable IN dates, the memorization gap is not computable
BLOCK = 5           # block length for the circular block bootstrap: ceil(HORIZON/stride) = ceil(21/5).
                    # Weekly decisions with a 21-day horizon overlap ~4 neighbors, so an IID bootstrap
                    # understates variance ~2x; resampling blocks of consecutive dates preserves the
                    # local autocorrelation and keeps the CI honest.

BASE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.normpath(os.path.join(BASE, "..", "data"))
OUT_DIR = os.path.join(BASE, "out")
PICKS_FP = os.path.join(OUT_DIR, "picks.jsonl")
META_FP = os.path.join(OUT_DIR, "meta.json")
PER_DATE_FP = os.path.join(OUT_DIR, "per_date.csv")
REPORT_FP = os.path.join(BASE, "PHASE0_RESULTS.md")


# ───────────────────────── formatting helpers ─────────────────────────
def pct(x, dec=2):
    return "n/a" if x is None or not np.isfinite(x) else f"{x * 100:+.{dec}f}%"


def upct(x):  # unsigned, for the ± term
    return "n/a" if x is None or not np.isfinite(x) else f"{x * 100:.2f}%"


def num(x, dec=3):
    return "n/a" if x is None or not np.isfinite(x) else f"{x:+.{dec}f}"


def unum(x, dec=3):
    return "n/a" if x is None or not np.isfinite(x) else f"{x:.{dec}f}"


def hitpct(x):
    return "n/a" if x is None or not np.isfinite(x) else f"{x * 100:.0f}%"


def md_table(header, rows):
    lines = ["| " + " | ".join(header) + " |", "|" + "|".join([" --- "] * len(header)) + "|"]
    lines += ["| " + " | ".join(r) + " |" for r in rows]
    return "\n".join(lines)


# ───────────────────────── data ─────────────────────────
def load_closes():
    """Close matrix aligned to the SPY trading calendar (reindex, no ffill — sessions align)."""
    fp = os.path.join(DATA_DIR, f"{BENCH}.csv")
    if not os.path.exists(fp):
        sys.exit(f"missing {fp} — run gen_prompts.py (or backtest.py) first to cache the data")
    spy = pd.read_csv(fp, index_col=0, parse_dates=True)
    cal = spy.index
    cols = {BENCH: spy["Close"]}
    for sym in UNIVERSE:
        df = pd.read_csv(os.path.join(DATA_DIR, f"{sym}.csv"), index_col=0, parse_dates=True)
        cols[sym] = df["Close"].reindex(cal)
    return cal, pd.DataFrame(cols, index=cal)


def load_picks():
    """picks.jsonl → usable records. Skips error lines (counted), validates rankings,
    dedupes by date keeping the last occurrence (resume-runs append)."""
    if not os.path.exists(PICKS_FP):
        sys.exit(f"missing {PICKS_FP} — run phase0-picker.ts first")
    ok, err_dates, n_bad = {}, set(), 0
    with open(PICKS_FP, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                n_bad += 1
                continue
            if rec.get("error") is not None or rec.get("ranking") is None:
                err_dates.add(rec.get("date"))
                continue
            r = rec["ranking"]
            if not isinstance(r, list) or len(r) != 18 or set(r) != set(UNIVERSE):
                n_bad += 1
                continue
            if rec.get("window") not in ("IN", "OOS"):
                n_bad += 1
                continue
            ok[rec["date"]] = rec
    # A resumed run legitimately appends a good line after an earlier error line for the same
    # date — only count dates that never got a good line as errored.
    n_err = len(err_dates - set(ok.keys()))
    return list(ok.values()), n_err, n_bad


# ───────────────────────── per-date arms ─────────────────────────
def per_date_rows(cal, C, picks):
    """fwd(sym) = Close[pos+21]/Close[pos] - 1; MOM5 = top-5 by r63 (ties alphabetical,
    NaN r63 excluded); IC = Spearman(predicted score 18..1, realized fwd)."""
    rows, skipped, n_nan = [], 0, 0
    for rec in sorted(picks, key=lambda r: r["date"]):
        ts = pd.Timestamp(rec["date"])
        if ts not in cal:
            skipped += 1
            continue
        pos = int(cal.get_loc(ts))
        if pos + HORIZON >= len(cal):
            skipped += 1
            continue
        c0, c1 = C.iloc[pos], C.iloc[pos + HORIZON]
        fwd = c1 / c0 - 1.0
        # A missing Close anywhere silently shrinks one arm's equal-weight basket but not the
        # others' (different effective universes per arm) — skip the whole date instead.
        if not (np.isfinite([fwd[s] for s in UNIVERSE]).all() and np.isfinite(fwd[BENCH])):
            n_nan += 1
            continue
        r63 = (c0 / C.iloc[pos - 63] - 1.0) if pos >= 63 else pd.Series(np.nan, index=C.columns)
        mom = sorted((s for s in UNIVERSE if np.isfinite(r63[s])), key=lambda s: (-r63[s], s))[:TOPK]
        if len(mom) < TOPK:
            n_nan += 1
            continue
        rank = rec["ranking"]
        llm5 = float(np.mean([fwd[s] for s in rank[:TOPK]]))
        bot5 = float(np.mean([fwd[s] for s in rank[-TOPK:]]))
        mom5 = float(np.mean([fwd[s] for s in mom]))
        univ = float(np.mean([fwd[s] for s in UNIVERSE]))
        spy = float(fwd[BENCH])
        realized = np.array([fwd[s] for s in rank], dtype=float)
        scores = np.arange(18, 0, -1, dtype=float)      # 18 = strongest .. 1 = weakest
        ic = float(stats.spearmanr(scores, realized).statistic)
        rows.append(dict(
            date=rec["date"], window=rec["window"], pos=pos,
            llm5=llm5, llmbot5=bot5, mom5=mom5, univ=univ, spy=spy, ic=ic,
            exc_univ=llm5 - univ, exc_mom5=llm5 - mom5, exc_spy=llm5 - spy, spread=llm5 - bot5,
        ))
    return pd.DataFrame(rows), skipped, n_nan


def non_overlapping(df):
    """Keep a date only if its calendar position >= previous kept position + HORIZON."""
    keep, prev = [], None
    for pos in df["pos"]:
        ok = prev is None or pos >= prev + HORIZON
        keep.append(ok)
        if ok:
            prev = pos
    return df[np.array(keep, dtype=bool)] if len(df) else df


# ───────────────────────── aggregation & bootstrap ─────────────────────────
def agg(df):
    out = {"n": len(df)}
    for key in ("llm5", "exc_univ", "exc_mom5", "exc_spy", "spread", "ic"):
        v = df[key].dropna().to_numpy(dtype=float) if len(df) else np.array([])
        m = float(v.mean()) if v.size else np.nan
        se = float(v.std(ddof=1) / np.sqrt(v.size)) if v.size > 1 else np.nan
        out[key] = (m, se)
    ic = df["ic"].dropna().to_numpy(dtype=float) if len(df) else np.array([])
    out["ic_t"] = float(ic.mean() / ic.std(ddof=1) * np.sqrt(ic.size)) if ic.size > 1 and ic.std(ddof=1) > 0 else np.nan
    out["n_exc_mom5"] = int(df["exc_mom5"].dropna().size) if len(df) else 0  # n behind the verdict metric
    for name, col in (("hit_univ", "exc_univ"), ("hit_mom5", "exc_mom5"), ("hit_spy", "exc_spy")):
        v = df[col].dropna() if len(df) else pd.Series(dtype=float)
        out[name] = float((v > 0).mean()) if len(v) else np.nan
    return out


def block_boot_means(rng, values, block=BLOCK):
    """BOOT_N circular-block-bootstrap means of `values` (MUST be in date order).
    Resamples blocks of `block` consecutive dates (wrapping) so the CI respects the
    autocorrelation from overlapping horizons; an IID bootstrap here would be ~2x too tight."""
    v = np.asarray(values, dtype=float)
    v = v[np.isfinite(v)]
    n = v.size
    if n == 0:
        return None
    if n <= block:  # too short for blocks — plain resample (upstream gates keep this display-only)
        idx = rng.integers(0, n, size=(BOOT_N, n))
        return v[idx].mean(axis=1)
    nblocks = int(np.ceil(n / block))
    starts = rng.integers(0, n, size=(BOOT_N, nblocks))
    idx = (starts[:, :, None] + np.arange(block)[None, None, :]) % n
    return v[idx.reshape(BOOT_N, nblocks * block)[:, :n]].mean(axis=1)


AGG_ROWS = [
    ("Decision dates (n)", lambda a: str(a["n"])),
    ("n used for LLM5−MOM5", lambda a: str(a["n_exc_mom5"])),
    ("LLM5 mean 21d fwd", lambda a: f"{pct(a['llm5'][0])} ± {upct(a['llm5'][1])}"),
    ("LLM5 − UNIV", lambda a: f"{pct(a['exc_univ'][0])} ± {upct(a['exc_univ'][1])}"),
    ("LLM5 − MOM5", lambda a: f"{pct(a['exc_mom5'][0])} ± {upct(a['exc_mom5'][1])}"),
    ("LLM5 − SPY", lambda a: f"{pct(a['exc_spy'][0])} ± {upct(a['exc_spy'][1])}"),
    ("Spread (LLM5 − LLMbot5)", lambda a: f"{pct(a['spread'][0])} ± {upct(a['spread'][1])}"),
    ("Mean rank IC", lambda a: f"{num(a['ic'][0])} ± {unum(a['ic'][1])}"),
    ("IC t-stat", lambda a: num(a["ic_t"], 2)),
    ("Hit rate LLM5>UNIV", lambda a: hitpct(a["hit_univ"])),
    ("Hit rate LLM5>MOM5", lambda a: hitpct(a["hit_mom5"])),
    ("Hit rate LLM5>SPY", lambda a: hitpct(a["hit_spy"])),
]


def agg_table(cols):
    """cols = [(colname, aggdict), ...] → markdown table string."""
    header = ["Metric"] + [c[0] for c in cols]
    rows = [[label] + [fmt(a) for _, a in cols] for label, fmt in AGG_ROWS]
    return md_table(header, rows)


# ───────────────────────── main ─────────────────────────
def main():
    # Windows consoles default to cp1252, which can't print the report's Unicode minus/dashes
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    cal, C = load_closes()
    picks, n_err, n_bad = load_picks()
    df, n_skip, n_nan = per_date_rows(cal, C, picks)
    if df.empty:
        sys.exit(f"no usable picks (errors={n_err}, malformed={n_bad}, skipped={n_skip}, nan={n_nan}) — nothing to evaluate")
    df = df.sort_values("pos").reset_index(drop=True)

    meta = {}
    if os.path.exists(META_FP):
        try:
            with open(META_FP, encoding="utf-8") as f:
                meta = json.load(f)
        except Exception:
            meta = {}

    # Data-drift guard: refreshing the CSVs between picking and evaluating rescores MOM5/forward
    # returns on newer back-adjusted prices than the LLM was shown. Warn loudly if that happened.
    drift_note = ""
    meta_last = meta.get("last_spy_data_date")
    if meta_last and meta_last != cal[-1].strftime("%Y-%m-%d"):
        drift_note = (f"⚠ DATA DRIFT: prompts were generated with data through {meta_last}, but the CSVs "
                      f"now end {cal[-1].date()}. If you refreshed between picking and evaluating, arms are "
                      "scored on newer back-adjusted prices than the LLM saw — regenerate prompts and re-pick "
                      "for a clean run.")
        print(drift_note + "\n")

    # per-date table
    out = df.rename(columns={"exc_mom5": "llm5_minus_mom5", "exc_univ": "llm5_minus_univ"})
    out[["date", "window", "llm5", "llmbot5", "mom5", "univ", "spy", "ic",
         "llm5_minus_mom5", "llm5_minus_univ"]].to_csv(PER_DATE_FP, index=False, lineterminator="\n")

    in_full = df[df["window"] == "IN"]
    oos_full = df[df["window"] == "OOS"]
    in_nov, oos_nov = non_overlapping(in_full), non_overlapping(oos_full)
    a_in, a_oos, a_in_nov, a_oos_nov = agg(in_full), agg(oos_full), agg(in_nov), agg(oos_nov)
    n_oos = len(oos_full)

    rng = np.random.default_rng(SEED)

    # verdict: OOS mean(llm5-mom5) + 90% circular-block-bootstrap CI. Gated on the array actually
    # bootstrapped (oos_exc), not the row count; symmetric rule — the CI decides, not the sign of
    # the point estimate (at n~19 a -0.01% mean must not trigger demotion a +0.01% mean wouldn't).
    oos_exc = oos_full["exc_mom5"].dropna().to_numpy(dtype=float)  # date-ordered (df sorted by pos)
    if oos_exc.size < MIN_OOS:
        verdict = (f"INSUFFICIENT DATA — only {oos_exc.size} usable OOS decision dates (<{MIN_OOS}). "
                   f"No verdict beyond 'insufficient data'; extend the forward window and rerun.")
    else:
        m = float(oos_exc.mean())
        lo, hi = np.percentile(block_boot_means(rng, oos_exc), [5.0, 95.0])
        ci_txt = (f"OOS mean(LLM5−MOM5) = {pct(m)}, 90% block-bootstrap CI [{pct(lo)}, {pct(hi)}], "
                  f"n={oos_exc.size}")
        if hi <= 0:
            verdict = (f"NO DETECTABLE OOS PICKING EDGE over the mechanical baseline — the CI excludes "
                       f"positive values ({ci_txt}). Recommend demoting the LLM to screener/veto duty; "
                       "the deterministic engine carries selection.")
        elif lo > 0:
            verdict = f"POSITIVE OOS edge ({ci_txt}) — keep LLM as picker, continue forward-paper to confirm."
        else:
            lean = "positive" if m > 0 else "negative"
            verdict = (f"WEAK/INCONCLUSIVE — the CI straddles 0 (point estimate leans {lean}; {ci_txt}). "
                       "Stay in forward-paper validation; do not expand LLM authority.")

    # memorization gap: IN_mean - OOS_mean with a block-bootstrap CI (resample within each window
    # independently). Gated on the same minimum-N rule as the verdict — at OOS n=1 the resampled
    # OOS mean is degenerate and would "confirm" a mirage from a single date.
    gap_rows, mirage_hits = [], []
    gap_ok = True
    for key, label in (("exc_univ", "LLM5 − UNIV"), ("exc_mom5", "LLM5 − MOM5"),
                       ("ic", "Rank IC"), ("spread", "Spread")):
        fmt = num if key == "ic" else pct
        vin = in_full[key].dropna().to_numpy(dtype=float)      # date-ordered
        voos = oos_full[key].dropna().to_numpy(dtype=float)
        if vin.size < MIN_IN or voos.size < MIN_OOS:
            gap_ok = False
            gap_rows.append([label, fmt(vin.mean()) if vin.size else "n/a",
                             fmt(voos.mean()) if voos.size else "n/a",
                             "n/a (insufficient n)", "n/a"])
            continue
        gaps = block_boot_means(rng, vin) - block_boot_means(rng, voos)
        gap = float(vin.mean() - voos.mean())
        lo, hi = np.percentile(gaps, [5.0, 95.0])
        gap_rows.append([label, fmt(vin.mean()), fmt(voos.mean()), fmt(gap),
                         f"[{fmt(lo)}, {fmt(hi)}]"])
        if gap > 0 and lo > 0:
            mirage_hits.append(label)
    if not gap_ok and not mirage_hits:
        mirage = (f"Memorization gap not (fully) computable — needs ≥{MIN_IN} usable IN dates and "
                  f"≥{MIN_OOS} usable OOS dates per metric.")
    elif mirage_hits:
        mirage = (f"MEMORIZATION MIRAGE CONFIRMED for {', '.join(mirage_hits)}: the IN-window edge "
                  "exceeds OOS with the 90% bootstrap CI of the gap excluding 0. Any in-sample LLM "
                  "backtest must be treated as fake — it measures recall of seen prices, not skill.")
    else:
        mirage = ("Memorization mirage NOT confirmed at 90% confidence — no gap CI excludes 0 "
                  "(note the thin OOS sample limits power).")

    # ── report ──
    win_table = agg_table([(f"IN (memorized)", a_in), (f"OOS (clean)", a_oos)])
    nov_table = agg_table([("IN non-overlap", a_in_nov), ("OOS non-overlap", a_oos_nov)])
    gap_table = md_table(["Metric", "IN mean", "OOS mean", "Gap (IN−OOS)", "90% CI"], gap_rows)
    meta_line = f"\nGeneration meta (`out/meta.json`): `{json.dumps(meta)[:400]}`\n" if meta else ""
    drift_line = f"\n**{drift_note}**\n" if drift_note else ""

    report = f"""# Phase 0 Results — LLM Picking Edge Test (Sonnet 4.6)

## Experiment design
- **Question:** does Claude Sonnet 4.6's ranking of 18 mega-cap tickers beat a mechanical 63-day-momentum top-5 over the next {HORIZON} trading days — and does any edge survive outside its training data?
- **Model cutoffs:** training data **Jan 2026**; reliable knowledge **Aug 2025** — so the IN window is memorization-contaminated by construction (Glasserman & Lin "profit mirage").
- **IN window:** decisions 2024-01-02 → 2025-06-30, every 5th trading day (n={len(in_full)} usable).
- **OOS window (clean):** decisions 2026-02-02 → last date with a full {HORIZON}-day horizon (n={n_oos} usable).
- **Arms:** LLM5 (model's top 5, equal weight), LLMbot5 (bottom 5), MOM5 (top 5 by 63d return, ties alphabetical), UNIV (all 18 equal weight), SPY. Rank IC = Spearman(predicted score 18..1, realized {HORIZON}d return).
- **Inputs:** price-derived stats only (momentum / 200DMA / 20d-high / ATR%) — the same numbers MOM5 sees. Skipped picks: {n_err} errored, {n_bad} malformed, {n_skip} outside the calendar/horizon, {n_nan} with missing prices.
{drift_line}{meta_line}
## IN vs OOS (all decision dates, weekly — horizons overlap)
{win_table}

_IC t-stat above is nominal — weekly decisions with a {HORIZON}-day horizon overlap, inflating it ~2×; the non-overlapping table below is the honest read._

## Robustness: non-overlapping decision dates (~every {HORIZON} trading days)
{nov_table}

## Memorization gap (IN mean − OOS mean, {BOOT_N:,}-resample circular block bootstrap, block={BLOCK}, 90% CI)
{gap_table}

{mirage}

## Verdict
{verdict}

## Caveats
- **Thin OOS window** (~5 months of clean data) — low power; the verdict is provisional until more forward months accrue.
- **Price-only context:** the live picker gets news + web access; this test isolates the ranking-from-statistics skill only.
- **Survivorship-tilted universe:** currently-listed mega caps — read relative arms, not absolute returns.
- **Overlapping weekly horizons** make per-date returns autocorrelated — the verdict and gap CIs use a circular block bootstrap (block={BLOCK}) to respect this, and the non-overlapping rows are a further robustness check. The plain SE/t columns in the tables are nominal.
- **Back-adjusted price levels:** the Close shown for IN dates is today's dividend/split-adjusted level, not the price the model saw in training — IN memorization operates through dates and return patterns, so the measured mirage is, if anything, conservative.
- **Single model, single run** — no seed/temperature variance estimate; rerun before major authority changes.
"""
    with open(REPORT_FP, "w", encoding="utf-8", newline="\n") as f:
        f.write(report)

    # ── stdout headline ──
    print(f"Phase 0 evaluation — {len(df)} usable decision dates "
          f"(IN={len(in_full)}, OOS={n_oos}; skipped: {n_err} errored, {n_bad} malformed, "
          f"{n_skip} no-horizon, {n_nan} missing-price)\n")
    print(win_table + "\n")
    print("Memorization gap:")
    print(gap_table + "\n")
    print(mirage + "\n")
    print("VERDICT: " + verdict)
    print(f"\nWrote {PER_DATE_FP}")
    print(f"Wrote {REPORT_FP}")


if __name__ == "__main__":
    main()
