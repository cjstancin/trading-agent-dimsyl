"""Multi-year replay shared by the weekly bake-off and the filter experiment.

Picks each day's watchlist from daily bars exactly as the engine does at 09:31, loads 1-min SIP
bars only for the symbol-days that are needed (one cached request per day), attaches the
before-today facts the filters use (ATR14, opening-volume average) and collects every variant's
first signal per symbol-day with its simulated exit.
"""
from __future__ import annotations

import logging
from collections import defaultdict
from datetime import date, timedelta

from . import data
from .backtest import day_candidates
from .config import universe
from .features import atr14, or_volume_avg
from .models import DayContext
from .watchlist import pick

log = logging.getLogger("bull.replay")


def needs_history(vs: list[dict]) -> bool:
    return any(v.get("params", {}).get(k) for v in vs for k in ("min_rvol", "stop_atr"))


def replay(cfg: dict, vs: list[dict], days: list[date], min_gap: float | None = None) -> dict:
    """Return {"cands": {variant: {day: [(Signal, Exit)]}}, "daily": {sym: [Bar]}, "symbol_days": n}.

    min_gap: only replay watchlist symbol-days that gapped up at least this much (gap-only tests).
    """
    dc = data.client()
    syms = universe()
    daily = data.daily_bars(dc, syms + ["SPY"], days[0] - timedelta(days=40), days[-1] + timedelta(days=1))
    by_sym = {s: {b.t.date(): b for b in bars} for s, bars in daily.items()}
    prev_day = {s: dict(zip(sorted(b)[1:], sorted(b))) for s, b in by_sym.items()}

    todo: dict[date, list[str]] = defaultdict(list)
    prev_close: dict[tuple[str, date], float] = {}
    for d in days:
        stats = {}
        for s, bars in by_sym.items():
            if d in bars and d in prev_day[s]:
                p = bars[prev_day[s][d]]
                stats[s] = {"prev_close": p.c, "open": bars[d].o, "prev_dollar_volume": p.c * p.v}
        for s in pick(stats, cfg["watchlist"]):
            if min_gap is None or (stats[s]["open"] / stats[s]["prev_close"] - 1) * 100 >= min_gap:
                todo[d].append(s)
                prev_close[(s, d)] = stats[s]["prev_close"]
    n = sum(len(v) for v in todo.values())
    log.info("replay: %d symbol-days on %d days", n, len(todo))

    or_vols: dict[str, dict] = {}
    if needs_history(vs):
        needed = sorted({s for v in todo.values() for s in v})
        for i, s in enumerate(needed):
            if i % 20 == 0:
                log.info("opening volumes %d/%d", i + 1, len(needed))
            or_vols[s] = data.opening_volumes(dc, s, days[0] - timedelta(days=30), days[-1])

    cands: dict[str, dict[date, list]] = {v["name"]: defaultdict(list) for v in vs}
    for i, d in enumerate(sorted(todo)):
        if i % 100 == 0:
            log.info("replaying day %d/%d (%s)", i + 1, len(todo), d)
        bars_by_sym = data.day_minute_bars(dc, d, todo[d])
        for s in todo[d]:
            bars = bars_by_sym.get(s) or []
            if len(bars) < 30:
                continue
            extra = {"atr": atr14(daily.get(s, []), d), "or_vol_avg": or_volume_avg(or_vols.get(s, {}), d)}
            ctx = DayContext(s, prev_close[(s, d)], bars, extra=extra)
            for sig, ex in day_candidates(vs, ctx, cfg):
                cands[sig.variant][d].append((sig, ex))
    return {"cands": {k: dict(v) for k, v in cands.items()}, "daily": by_sym, "symbol_days": n}


def spy_returns(by_sym: dict, days: list[date]) -> tuple[float | None, dict[str, float]]:
    spy = by_sym.get("SPY", {})
    rows = [spy[d] for d in days if d in spy]
    total = round((rows[-1].c / rows[0].o - 1) * 100, 2) if rows else None
    per_year = {}
    for y in sorted({d.year for d in days}):
        ys = [spy[d] for d in days if d.year == y and d in spy]
        if ys:
            per_year[str(y)] = round((ys[-1].c / ys[0].o - 1) * 100, 2)
    return total, per_year
