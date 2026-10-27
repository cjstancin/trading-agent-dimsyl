"""Per-symbol measurements shared by the live engine, the journal and the backtests.

Everything here looks only at data from BEFORE the bar it describes, so the same numbers come out
live and in replay.
"""
from __future__ import annotations

from datetime import date, time

from .models import Bar, DayContext

OPEN = time(9, 30)
OR_MINUTES = 5


def atr14(daily: list[Bar], before: date) -> float | None:
    """Average true range of the 14 completed sessions before `before`."""
    bars = [b for b in daily if b.t.date() < before][-15:]
    if len(bars) < 15:
        return None
    trs = [max(b.h - b.l, abs(b.h - p.c), abs(b.l - p.c)) for p, b in zip(bars, bars[1:])]
    return sum(trs) / len(trs)


def or_volume_avg(opening: dict[date, float], before: date, n: int = 14) -> float | None:
    """Mean opening-range (first 5 min) volume over the n sessions before `before`."""
    prior = [v for d, v in sorted(opening.items()) if d < before and v > 0][-n:]
    return sum(prior) / len(prior) if len(prior) >= n // 2 else None


def opening_bars(ctx: DayContext, minutes: int = OR_MINUTES) -> list[Bar]:
    """Bars inside the first `minutes` of the session, by clock time (IEX feeds can skip minutes)."""
    cutoff = OPEN.hour * 60 + OPEN.minute + minutes
    return [b for b in ctx.bars if b.t.hour * 60 + b.t.minute < cutoff]


def rvol(ctx: DayContext, minutes: int = OR_MINUTES) -> float | None:
    """Today's opening-range volume vs its 14-session average. 2.0 = twice the usual open."""
    avg = ctx.extra.get("or_vol_avg")
    if not avg:
        return None
    return sum(b.v for b in opening_bars(ctx, minutes)) / avg


def gap_pct(ctx: DayContext) -> float | None:
    if not ctx.prev_close or not ctx.bars:
        return None
    return (ctx.bars[0].o / ctx.prev_close - 1) * 100


def entry_features(ctx: DayContext, k: int, stop: float, spy_chg: float | None) -> dict:
    """What the setup looked like at the moment of entry. Feeds the journal."""
    bar = ctx.bars[k]
    atr = ctx.extra.get("atr")
    rv = rvol(ctx)
    g = gap_pct(ctx)
    return {
        "gap_pct": round(g, 2) if g is not None else None,
        "rvol": round(rv, 2) if rv is not None else None,
        "atr_pct": round(atr / bar.c * 100, 2) if atr else None,
        "stop_pct": round(abs(bar.c - stop) / bar.c * 100, 2),
        "minute": bar.t.hour * 60 + bar.t.minute - (OPEN.hour * 60 + OPEN.minute),
        "spy_chg": round(spy_chg, 2) if spy_chg is not None else None,
    }


def bucket_bars(bars: list[Bar], minutes: int) -> list[dict]:
    """1-min bars -> N-minute candles for the chart, each carrying the running VWAP at its close."""
    out, pv, vol, bucket = [], 0.0, 0.0, None
    for b in bars:
        pv += (b.h + b.l + b.c) / 3 * b.v
        vol += b.v
        key = b.t.replace(minute=b.t.minute - b.t.minute % minutes, second=0).strftime("%H:%M")
        if bucket and bucket["t"] == key:
            bucket.update(h=max(bucket["h"], b.h), l=min(bucket["l"], b.l), c=b.c, v=bucket["v"] + b.v)
        else:
            bucket = {"t": key, "o": b.o, "h": b.h, "l": b.l, "c": b.c, "v": b.v}
            out.append(bucket)
        bucket["vwap"] = round(pv / vol, 4) if vol else b.c
    return out


def key_levels(prev_day: Bar | None, premarket: list[Bar], session: list[Bar]) -> list[dict]:
    """The levels day traders mark: prior day H/L/C, premarket H/L, 5- and 15-minute opening range."""
    levels = []
    if prev_day:
        levels += [{"k": "PDH", "v": prev_day.h}, {"k": "PDL", "v": prev_day.l}, {"k": "PDC", "v": prev_day.c}]
    if premarket:
        levels += [{"k": "PMH", "v": max(b.h for b in premarket)}, {"k": "PML", "v": min(b.l for b in premarket)}]
    for n in (5, 15):
        cutoff = OPEN.hour * 60 + OPEN.minute + n
        first = [b for b in session if b.t.hour * 60 + b.t.minute < cutoff]
        last_needed = session and (session[-1].t.hour * 60 + session[-1].t.minute) >= cutoff - 1
        if first and last_needed:
            levels += [{"k": f"OR{n}H", "v": max(b.h for b in first)}, {"k": f"OR{n}L", "v": min(b.l for b in first)}]
    return [{"k": x["k"], "v": round(x["v"], 2)} for x in levels]
