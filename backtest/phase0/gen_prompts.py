#!/usr/bin/env python3
"""
Phase 0 prompt generator — LLM edge-test for Bill the Bull.

Per Glasserman & Lin ("the profit mirage"), an LLM backtested INSIDE its training window has
memorized the prices, so any apparent edge is fake. To measure the real edge we ask Sonnet 4.6
(training cutoff Jan 2026) to rank the same 18-name universe in TWO windows — IN (2024-01 →
2025-06, memorization-contaminated) and OOS (2026-02+, clean) — and compare. This script builds
the deterministic, stats-only prompts for every decision date; the picker + evaluator do the rest.

Run:  python gen_prompts.py     (reads cached CSVs from ../data — no network)
"""
import json
import os
import sys
from datetime import datetime, timezone

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "..", "data")
OUT_DIR = os.path.join(HERE, "out")

HORIZON = 21          # forward-return horizon in trading days
STRIDE = 5            # decision every 5th trading day
MIN_HISTORY = 252     # require >= 252 prior calendar rows so r252 / 200DMA are well-defined
IN_START, IN_END = "2024-01-02", "2025-06-30"
OOS_START = "2026-02-02"

# Identical to backtest.py UNIVERSE (order matters — prompt rows follow this order).
UNIVERSE = {
    "AAPL": "Tech", "MSFT": "Tech", "NVDA": "Tech", "GOOGL": "Tech", "META": "Tech",
    "AMZN": "ConsumerDisc", "HD": "ConsumerDisc",
    "JPM": "Financials", "V": "Financials",
    "XOM": "Energy", "CVX": "Energy",
    "UNH": "Health", "JNJ": "Health",
    "PG": "Staples", "KO": "Staples", "WMT": "Staples",
    "CAT": "Industrials", "BA": "Industrials",
}

PROMPT_TEMPLATE = """You are a systematic equity analyst. Today's date is {date}. Using ONLY the statistics below
(computed through the close of {date}), rank ALL 18 tickers from strongest to weakest expected
total return over the NEXT 21 TRADING DAYS (about one month).

Market context (SPY): close {spy_close} | vs 200DMA {spy_vs200} | regime {regime} | 21d {spy_r21} | 63d {spy_r63}

Ticker | Sector | Close | 21d | 63d | 126d | 252d | vs200DMA | vs20dHigh | ATR%
{rows}

Respond with ONLY a JSON object — no markdown fences, no commentary:
{{"ranking": ["TICKER", ... all 18 tickers, strongest first], "rationale": "<=25 words"}}
"ranking" must contain each of the 18 tickers exactly once."""

FEATURE_DEFS = {
    "r21": "c[t]/c[t-21]-1 (21 trading days, positional on SPY calendar)",
    "r63": "c[t]/c[t-63]-1",
    "r126": "c[t]/c[t-126]-1",
    "r252": "c[t]/c[t-252]-1",
    "vs200dma": "c[t]/mean(c[t-199..t])-1 (200-session SMA incl. t)",
    "vs20dhi": "c[t]/max(c[t-19..t])-1 (20-session closing high incl. t)",
    "atrPct": "ATR22[t]/c[t]; ATR22 = simple mean of last 22 TRs; TR = max(H-L,|H-prevC|,|L-prevC|)",
    "regime": "SPY close >= SPY 200DMA ? ON : OFF",
}


def load_csv(sym):
    fp = os.path.join(DATA_DIR, f"{sym}.csv")
    if not os.path.exists(fp):
        sys.exit(f"ERROR: missing {fp} — run \"python ../backtest.py --refresh\" to fetch cached data.")
    return pd.read_csv(fp, index_col=0, parse_dates=True)


def compute_features(df):
    """Per-ticker feature frame; every value uses rows <= t only (shifts/rollers look back)."""
    c, h, l = df["Close"], df["High"], df["Low"]
    pc = c.shift(1)
    tr = pd.concat([h - l, (h - pc).abs(), (l - pc).abs()], axis=1).max(axis=1)
    out = pd.DataFrame(index=df.index)
    out["close"] = c
    out["r21"] = c / c.shift(21) - 1
    out["r63"] = c / c.shift(63) - 1
    out["r126"] = c / c.shift(126) - 1
    out["r252"] = c / c.shift(252) - 1
    out["vs200dma"] = c / c.rolling(200).mean() - 1
    out["vs20dhi"] = c / c.rolling(20).max() - 1
    out["atrPct"] = tr.rolling(22).mean() / c
    return out


def fmt_pct(v):
    return "n/a" if pd.isna(v) else f"{v * 100:+.1f}%"


def fmt_px(v):
    return "n/a" if pd.isna(v) else f"{v:.2f}"


def main():
    spy = load_csv("SPY")
    cal = spy.index                                   # trading calendar = SPY.csv index
    raw = {s: load_csv(s).reindex(cal) for s in UNIVERSE}   # align sessions, no ffill

    # Data-integrity guard: one missing session poisons rolling features for up to 200 sessions
    # ("n/a" runs in prompts while MOM5 is unaffected — an information asymmetry between arms).
    # Fail loudly instead of silently degrading the experiment.
    holes = {s: df.index[df["Close"].isna()] for s, df in raw.items()}
    holes = {s: idx for s, idx in holes.items() if len(idx)}
    if holes:
        detail = "; ".join(f"{s}: {len(idx)} missing (first {idx[0].date()})" for s, idx in holes.items())
        sys.exit(f"ERROR: NaN Close after aligning to the SPY calendar — {detail}. "
                 f"Re-fetch with \"python ../backtest.py --refresh\" before generating prompts.")

    feats = {s: compute_features(df) for s, df in raw.items()}
    spy_f = compute_features(spy)

    def decision_dates(start, end):
        mask = cal >= start
        if end is not None:
            mask &= cal <= end
        picked = cal[mask][::STRIDE]                  # every 5th trading day within the window
        return [t for t in picked
                if cal.get_loc(t) >= MIN_HISTORY and cal.get_loc(t) + HORIZON < len(cal)]

    windows = {"IN": decision_dates(IN_START, IN_END), "OOS": decision_dates(OOS_START, None)}

    lines = []
    for window, dates in windows.items():
        for t in dates:
            date = t.strftime("%Y-%m-%d")
            s = spy_f.loc[t]
            regime = "ON" if s["vs200dma"] >= 0 else "OFF"
            rows = []
            for sym, sector in UNIVERSE.items():
                f = feats[sym].loc[t]
                rows.append(" | ".join([
                    sym, sector, fmt_px(f["close"]),
                    fmt_pct(f["r21"]), fmt_pct(f["r63"]), fmt_pct(f["r126"]), fmt_pct(f["r252"]),
                    fmt_pct(f["vs200dma"]), fmt_pct(f["vs20dhi"]), fmt_pct(f["atrPct"]),
                ]))
            prompt = PROMPT_TEMPLATE.format(
                date=date, spy_close=fmt_px(s["close"]), spy_vs200=fmt_pct(s["vs200dma"]),
                regime=regime, spy_r21=fmt_pct(s["r21"]), spy_r63=fmt_pct(s["r63"]),
                rows="\n".join(rows),
            )
            lines.append(json.dumps({"date": date, "window": window, "prompt": prompt}))

    os.makedirs(OUT_DIR, exist_ok=True)
    prompts_fp = os.path.join(OUT_DIR, "prompts.jsonl")
    with open(prompts_fp, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(lines) + "\n")

    meta = {
        "experiment": "Phase 0 — Sonnet 4.6 stock-picking vs mechanical momentum; IN window measures memorization (profit mirage), OOS measures real edge",
        "model_cutoffs": {"training": "2026-01", "reliable_knowledge": "2025-08"},
        "universe": UNIVERSE,
        "benchmark": "SPY",
        "horizon_trading_days": HORIZON,
        "decision_stride_trading_days": STRIDE,
        "min_prior_calendar_rows": MIN_HISTORY,
        "windows": {
            "IN": {"start": IN_START, "end": IN_END, "note": "inside training cutoff (memorization-contaminated)"},
            "OOS": {"start": OOS_START, "end": "last t with t+21 in calendar", "note": "past training cutoff (clean)"},
        },
        "decision_dates": {w: [t.strftime("%Y-%m-%d") for t in d] for w, d in windows.items()},
        "features": FEATURE_DEFS,
        "last_spy_data_date": cal[-1].strftime("%Y-%m-%d"),
        "generated_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    meta_fp = os.path.join(OUT_DIR, "meta.json")
    with open(meta_fp, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(meta, fh, indent=2)
        fh.write("\n")

    for w, d in windows.items():
        span = f"{d[0].date()} .. {d[-1].date()}" if d else "(none)"
        print(f"{w:>3}: {len(d)} decision dates  {span}")
    print(f"wrote {prompts_fp}")
    print(f"wrote {meta_fp}")


if __name__ == "__main__":
    main()
