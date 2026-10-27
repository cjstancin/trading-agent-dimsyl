"""The three day-trading methods in the bake-off.

Each function looks at bars[0..k] of one symbol-day and returns a Signal if bar k triggers an
entry. It must never read past index k: the backtest hands it the whole day, live hands it the
day so far, and both must agree (tests/test_strategies.py checks this).
"""
from __future__ import annotations

from datetime import time

from .features import opening_bars, rvol
from .models import DayContext, Signal

MIN_STOP_PCT = 0.10  # stops tighter than this are noise, not risk control


def _in_window(t, start: str, end: str) -> bool:
    sh, sm = map(int, start.split(":"))
    eh, em = map(int, end.split(":"))
    return time(sh, sm) <= t.time() < time(eh, em)


def _sides(p: dict) -> tuple[str, ...]:
    return ("long", "short") if p.get("side", "long") == "both" else ("long",)


def _signal(name, ctx, k, side, stop, p, why) -> Signal | None:
    ref = ctx.bars[k].c
    risk = ref - stop if side == "long" else stop - ref
    if risk <= 0 or risk / ref * 100 < MIN_STOP_PCT:
        return None
    if risk / ref * 100 > p.get("max_stop_pct", 2.0):
        return None
    r = p.get("target_r", 2.0)
    target = ref + r * risk if side == "long" else ref - r * risk
    return Signal(name, ctx.symbol, side, ctx.bars[k].t, ref, round(stop, 2), round(target, 2), why)


def _range(ctx: DayContext, n: int) -> tuple[float, float]:
    """High/low of the first n minutes by clock time."""
    key = ("range", n)
    if key not in ctx.memo:
        first = opening_bars(ctx, n) or ctx.bars[:1]
        ctx.memo[key] = (max(b.h for b in first), min(b.l for b in first))
    return ctx.memo[key]


def _after_open(t, n: int) -> bool:
    return t.hour * 60 + t.minute >= 9 * 60 + 30 + n


def orb(name: str, ctx: DayContext, k: int, p: dict) -> Signal | None:
    """Opening-range breakout: first close outside the first N minutes' range."""
    n = p.get("or_minutes", 15)
    if k < 1 or not _after_open(ctx.bars[k].t, n) or not _in_window(ctx.bars[k].t, "09:30", p.get("last_entry", "11:30")):
        return None
    hi, lo = _range(ctx, n)
    bar, prev = ctx.bars[k], ctx.bars[k - 1]
    for side in _sides(p):
        if side == "long" and bar.c > hi and prev.c <= hi:
            stop = max(lo, bar.c * (1 - p.get("max_stop_pct", 2.0) / 100 * 0.75))
            return _signal(name, ctx, k, "long", stop, p, f"broke the {n}-min high {hi:.2f}")
        if side == "short" and bar.c < lo and prev.c >= lo:
            stop = min(hi, bar.c * (1 + p.get("max_stop_pct", 2.0) / 100 * 0.75))
            return _signal(name, ctx, k, "short", stop, p, f"broke the {n}-min low {lo:.2f}")
    return None


def vwap_pullback(name: str, ctx: DayContext, k: int, p: dict) -> Signal | None:
    """Trend day pulls back to VWAP, then the next bar resumes the trend."""
    look = p.get("trend_bars", 30)
    if k < look or not _in_window(ctx.bars[k].t, "09:50", p.get("last_entry", "15:00")):
        return None
    bar, prev = ctx.bars[k], ctx.bars[k - 1]
    vw = ctx.vw
    frac_above = (ctx.above[k] - ctx.above[k - look]) / look
    touch = p.get("touch_pct", 0.15) / 100
    pullback = ctx.bars[k - 5:k]
    for side in _sides(p):
        if side == "long":
            if frac_above < p.get("trend_frac", 0.7) or vw[k] <= vw[k - look]:
                continue
            touched = any(b.l <= vw[k - 5 + i] * (1 + touch) for i, b in enumerate(pullback))
            if touched and bar.c > vw[k] and bar.c > prev.h:
                stop = min(b.l for b in pullback + [bar]) * 0.9995
                return _signal(name, ctx, k, "long", stop, p, f"held VWAP {vw[k]:.2f} in an uptrend")
        else:
            if 1 - frac_above < p.get("trend_frac", 0.7) or vw[k] >= vw[k - look]:
                continue
            touched = any(b.h >= vw[k - 5 + i] * (1 - touch) for i, b in enumerate(pullback))
            if touched and bar.c < vw[k] and bar.c < prev.l:
                stop = max(b.h for b in pullback + [bar]) * 1.0005
                return _signal(name, ctx, k, "short", stop, p, f"rejected VWAP {vw[k]:.2f} in a downtrend")
    return None


def gap_and_go(name: str, ctx: DayContext, k: int, p: dict) -> Signal | None:
    """Big overnight gap, then a break of the first few minutes' range in the gap's direction.

    Optional filters (each off unless set): last_entry (time cutoff), min_gap_pct, min_rvol
    (opening volume vs its 14-session average) and stop_atr (stop = range edge, capped at
    stop_atr x ATR14 instead of the flat percentage cap).
    """
    n = p.get("range_minutes", 5)
    if not ctx.prev_close or k < 1 or not _after_open(ctx.bars[k].t, n)             or not _in_window(ctx.bars[k].t, "09:30", p.get("last_entry", "10:30")):
        return None
    gap = (ctx.bars[0].o / ctx.prev_close - 1) * 100
    min_gap = p.get("min_gap_pct", 3.0)
    if abs(gap) < min_gap:
        return None
    if p.get("min_rvol"):
        rv = rvol(ctx, n)
        if rv is None or rv < p["min_rvol"]:
            return None
    hi, lo = _range(ctx, n)
    bar, prev = ctx.bars[k], ctx.bars[k - 1]
    max_stop = p.get("max_stop_pct", 3.0)
    atr = ctx.extra.get("atr")
    if p.get("stop_atr") and not atr:
        return None
    cap = p["stop_atr"] * atr if p.get("stop_atr") else bar.c * max_stop / 100 * 0.75
    for side in _sides(p):
        if side == "long" and gap >= min_gap and bar.c > hi and prev.c <= hi and bar.c > ctx.vw[k]:
            stop = max(lo, bar.c - cap)
            return _signal(name, ctx, k, "long", stop, {**p, "max_stop_pct": max_stop}, f"gapped +{gap:.1f}% and broke {hi:.2f}")
        if side == "short" and gap <= -min_gap and bar.c < lo and prev.c >= lo and bar.c < ctx.vw[k]:
            stop = min(hi, bar.c + cap)
            return _signal(name, ctx, k, "short", stop, {**p, "max_stop_pct": max_stop}, f"gapped {gap:.1f}% and broke {lo:.2f}")
    return None


STRATEGIES = {"orb": orb, "vwap_pullback": vwap_pullback, "gap_and_go": gap_and_go}

LABELS = {"orb": "Opening-range breakout", "vwap_pullback": "VWAP pullback", "gap_and_go": "Gap and go"}


def evaluate(variant: dict, ctx: DayContext, k: int) -> Signal | None:
    return STRATEGIES[variant["strategy"]](variant["name"], ctx, k, variant.get("params", {}))
