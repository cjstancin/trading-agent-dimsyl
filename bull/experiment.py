"""Filter test: replay the pre-registered [[shadow]] variants over years of history.

Compares the control (the live gap-and-go rule) against each filter and all filters combined,
with the same costs, sizing and portfolio rules as the bake-off. Writes runtime/experiment.json
and never touches runtime/bakeoff.json, so the live engine is unaffected.
"""
from __future__ import annotations

import json
import logging
import math
from collections import defaultdict
from datetime import date, datetime, timedelta

from . import data
from .backtest import day_candidates, metrics, run_portfolio, trade_dicts
from .bakeoff import trading_days
from .config import ET, runtime_dir, shadow_variants, universe
from .features import atr14, or_volume_avg
from .models import DayContext
from .watchlist import pick

log = logging.getLogger("bull.experiment")


def _r_stats(trades) -> dict:
    rs = [t.r for t in trades]
    if len(rs) < 2:
        return {"mean_r": rs[0] if rs else None, "se_r": None}
    m = sum(rs) / len(rs)
    sd = math.sqrt(sum((r - m) ** 2 for r in rs) / (len(rs) - 1))
    return {"mean_r": round(m, 4), "se_r": round(sd / math.sqrt(len(rs)), 4)}


def run(cfg: dict, days_n: int = 1000) -> dict:
    days = trading_days(days_n)
    dc = data.client()
    syms = universe()
    log.info("experiment over %d days %s..%s, %d symbols", len(days), days[0], days[-1], len(syms))

    daily = data.daily_bars(dc, syms + ["SPY"], days[0] - timedelta(days=40), days[-1] + timedelta(days=1))
    by_sym = {s: {b.t.date(): b for b in bars} for s, bars in daily.items()}

    # The watchlist each day, then only the symbol-days that could ever fire (gap >= the smallest min gap).
    vs = shadow_variants(cfg)
    min_gap = min(v["params"].get("min_gap_pct", 3.0) for v in vs)
    todo: dict[date, list[str]] = defaultdict(list)
    prev_close: dict[tuple[str, date], float] = {}
    prev_day = {s: dict(zip(sorted(b)[1:], sorted(b))) for s, b in by_sym.items()}
    for d in days:
        stats = {}
        for s, bars in by_sym.items():
            if d not in bars or d not in prev_day[s]:
                continue
            p = bars[prev_day[s][d]]
            stats[s] = {"prev_close": p.c, "open": bars[d].o, "prev_dollar_volume": p.c * p.v}
        for s in pick(stats, cfg["watchlist"]):
            if (stats[s]["open"] / stats[s]["prev_close"] - 1) * 100 >= min_gap:
                todo[d].append(s)
                prev_close[(s, d)] = stats[s]["prev_close"]
    n_cand = sum(len(v) for v in todo.values())
    log.info("%d candidate symbol-days on %d days", n_cand, len(todo))

    needed = sorted({s for v in todo.values() for s in v})
    or_vols = {}
    for i, s in enumerate(needed):
        log.info("opening volumes [%d/%d] %s", i + 1, len(needed), s)
        or_vols[s] = data.opening_volumes(dc, s, days[0] - timedelta(days=30), days[-1])

    cands: dict[str, dict[date, list]] = {v["name"]: defaultdict(list) for v in vs}
    for i, d in enumerate(sorted(todo)):
        if i % 50 == 0:
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

    start_eq = float(cfg["account"]["start_equity"])
    results, all_trades = {}, {}
    for v in vs:
        trades = run_portfolio(dict(cands[v["name"]]), cfg)
        m = metrics(trades, start_eq, days)
        m.update(_r_stats(trades))
        m["params"] = v["params"]
        by_year = defaultdict(list)
        for t in trades:
            by_year[t.day[:4]].append(t)
        m["by_year"] = {y: {"trades": len(ts), "net_pnl": round(sum(t.pnl for t in ts), 2),
                            "win_rate": round(sum(t.pnl > 0 for t in ts) / len(ts) * 100, 1)}
                        for y, ts in sorted(by_year.items())}
        results[v["name"]] = m
        all_trades[v["name"]] = trade_dicts(trades)

    ctrl = results.get("gap_control")
    if ctrl and ctrl["se_r"]:
        for name, m in results.items():
            if name != "gap_control" and m["se_r"]:
                diff = m["mean_r"] - ctrl["mean_r"]
                m["vs_control"] = {"mean_r_diff": round(diff, 4),
                                   "t_stat": round(diff / math.sqrt(m["se_r"] ** 2 + ctrl["se_r"] ** 2), 2),
                                   "net_pnl_diff": round(m["net_pnl"] - ctrl["net_pnl"], 2)}

    spy = by_sym.get("SPY", {})
    spy_year = {}
    for y in sorted({d.year for d in days}):
        ys = [spy[d] for d in days if d.year == y and d in spy]
        if ys:
            spy_year[str(y)] = round((ys[-1].c / ys[0].o - 1) * 100, 2)
    spy_all = [spy[d] for d in days if d in spy]
    summary = {
        "generated_at": datetime.now(ET).isoformat(timespec="seconds"),
        "period": [days[0].isoformat(), days[-1].isoformat()],
        "days": len(days),
        "candidate_symbol_days": n_cand,
        "start_equity": start_eq,
        "spy_return_pct": round((spy_all[-1].c / spy_all[0].o - 1) * 100, 2) if spy_all else None,
        "spy_by_year": spy_year,
        "costs": cfg["costs"],
        "results": results,
    }
    rt = runtime_dir()
    (rt / "experiment.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    (rt / "experiment-trades.json").write_text(json.dumps(all_trades), encoding="utf-8")
    return summary


def print_table(s: dict) -> None:
    print(f"Filter test {s['period'][0]}..{s['period'][1]} ({s['days']} days, {s['candidate_symbol_days']} "
          f"gap symbol-days), ${s['start_equity']:,.0f} book, SPY {s['spy_return_pct']}%")
    print(f"{'variant':<17}{'trades':>7}{'win%':>7}{'net $':>11}{'ret%':>8}{'PF':>6}{'avgR':>8}{'±se':>7}"
          f"{'maxDD%':>8}{'vs ctrl R':>10}{'t':>6}")
    for name, m in s["results"].items():
        vc = m.get("vs_control", {})
        print(f"{name:<17}{m['trades']:>7}{m['win_rate']:>7}{m['net_pnl']:>11}{m['return_pct']:>8}"
              f"{m['profit_factor']:>6}{(m['mean_r'] or 0):>8.3f}{(m['se_r'] or 0):>7.3f}{m['max_drawdown_pct']:>8}"
              f"{vc.get('mean_r_diff', ''):>10}{vc.get('t_stat', ''):>6}")
    print("by year (net $):")
    years = sorted({y for m in s["results"].values() for y in m["by_year"]})
    print(f"{'':<17}" + "".join(f"{y:>10}" for y in years))
    for name, m in s["results"].items():
        print(f"{name:<17}" + "".join(f"{m['by_year'].get(y, {}).get('net_pnl', 0):>10}" for y in years))
    print(f"{'SPY %':<17}" + "".join(f"{s['spy_by_year'].get(y, ''):>10}" for y in years))
