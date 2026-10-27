"""Bake-off: run every variant over the same recent days with costs, then keep only survivors.

Writes runtime/bakeoff.json (summary the engine and site read) and runtime/bakeoff-trades.json.
"""
from __future__ import annotations

import json
import logging
from datetime import date, datetime, timedelta

from alpaca.trading.requests import GetCalendarRequest

from . import broker, data
from .backtest import day_candidates, metrics, passes, run_portfolio, trade_dicts
from .config import ET, runtime_dir, universe, variants
from .models import DayContext
from .watchlist import pick

log = logging.getLogger("bull.bakeoff")


def trading_days(n: int) -> list[date]:
    today = datetime.now(ET).date()
    cal = broker.client().get_calendar(GetCalendarRequest(start=today - timedelta(days=n * 2 + 10), end=today))
    days = [c.date if isinstance(c.date, date) else date.fromisoformat(str(c.date)) for c in cal]
    return [d for d in days if d < today][-n:]


def daily_stats(dc, symbols: list[str], days: list[date]) -> dict[date, dict[str, dict]]:
    daily = data.daily_bars(dc, symbols, days[0] - timedelta(days=10), days[-1] + timedelta(days=1))
    out: dict[date, dict[str, dict]] = {d: {} for d in days}
    for sym, bars in daily.items():
        by_day = {b.t.date(): b for b in bars}
        ordered = sorted(by_day)
        for i, d in enumerate(ordered):
            if d not in out or i == 0:
                continue
            prev = by_day[ordered[i - 1]]
            out[d][sym] = {"prev_close": prev.c, "open": by_day[d].o, "prev_dollar_volume": prev.c * prev.v}
    return out


def run(cfg: dict, days_n: int | None = None) -> dict:
    days_n = days_n or cfg["bakeoff"]["days"]
    days = trading_days(days_n)
    dc = data.client()
    syms = universe()
    log.info("bake-off over %d days %s..%s, %d symbols", len(days), days[0], days[-1], len(syms))

    stats = daily_stats(dc, syms + ["SPY"], days)
    watch = {d: pick(stats[d], cfg["watchlist"]) for d in days}
    needed: dict[str, list[date]] = {}
    for d, wl in watch.items():
        for s in wl:
            needed.setdefault(s, []).append(d)

    vs = variants(cfg)
    cands: dict[str, dict[date, list]] = {v["name"]: {d: [] for d in days} for v in vs}
    for i, (sym, sym_days) in enumerate(sorted(needed.items())):
        log.info("[%d/%d] %s: %d days", i + 1, len(needed), sym, len(sym_days))
        bars_by_day = data.history_minute_bars(dc, sym, sym_days)
        for d in sym_days:
            bars = bars_by_day.get(d) or []
            if len(bars) < 30:
                continue
            ctx = DayContext(sym, stats[d].get(sym, {}).get("prev_close"), bars)
            for sig, ex in day_candidates(vs, ctx, cfg):
                cands[sig.variant][d].append((sig, ex))

    start_eq = float(cfg["account"]["start_equity"])
    results, all_trades = {}, {}
    for v in vs:
        trades = run_portfolio(cands[v["name"]], cfg)
        m = metrics(trades, start_eq, days)
        m["passed"] = passes(m, cfg["bakeoff"])
        m["strategy"] = v["strategy"]
        m["params"] = v.get("params", {})
        results[v["name"]] = m
        all_trades[v["name"]] = trade_dicts(trades)

    ranking = sorted(results, key=lambda n: (results[n]["passed"], results[n]["net_pnl"]), reverse=True)
    spy = [b for b in data.daily_bars(dc, ["SPY"], days[0], days[-1] + timedelta(days=1)).get("SPY", [])]
    spy_ret = round((spy[-1].c / spy[0].o - 1) * 100, 2) if spy else None
    summary = {
        "generated_at": datetime.now(ET).isoformat(timespec="seconds"),
        "period": [days[0].isoformat(), days[-1].isoformat()],
        "days": len(days),
        "start_equity": start_eq,
        "spy_return_pct": spy_ret,
        "rules": cfg["bakeoff"],
        "costs": cfg["costs"],
        "results": results,
        "ranking": ranking,
        "passed": [n for n in ranking if results[n]["passed"]],
    }
    rt = runtime_dir()
    (rt / "bakeoff.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    (rt / "bakeoff-trades.json").write_text(json.dumps(all_trades), encoding="utf-8")
    return summary


def print_table(summary: dict) -> None:
    print(f"Bake-off {summary['period'][0]}..{summary['period'][1]} ({summary['days']} days), "
          f"${summary['start_equity']:,.0f} book, SPY {summary['spy_return_pct']}%")
    print(f"{'variant':<16}{'trades':>7}{'win%':>7}{'net $':>10}{'ret%':>7}{'PF':>6}{'avgR':>7}"
          f"{'maxDD%':>8}{'H1 $':>9}{'H2 $':>9}{'fees':>7}  pass")
    for n in summary["ranking"]:
        m = summary["results"][n]
        print(f"{n:<16}{m['trades']:>7}{m['win_rate']:>7}{m['net_pnl']:>10}{m['return_pct']:>7}"
              f"{m['profit_factor']:>6}{m['avg_r']:>7}{m['max_drawdown_pct']:>8}{m['first_half_pnl']:>9}"
              f"{m['second_half_pnl']:>9}{m['fees']:>7}  {'YES' if m['passed'] else 'no'}")
