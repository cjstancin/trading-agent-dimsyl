"""Bake-off: replay every candidate over years of history with costs, keep only proven survivors.

Candidates are the [[variant]] methods plus the pre-registered [[shadow]] filters. "Proven" is
the [bakeoff] rule: enough trades, net profit, a t-stat on mean R of at least min_t_stat, and
profitable in most years. Writes runtime/bakeoff.json (read by the engine and site) and
runtime/bakeoff-trades.json.
"""
from __future__ import annotations

import json
import logging
from datetime import date, datetime, timedelta

from alpaca.trading.requests import GetCalendarRequest

from . import broker
from .backtest import metrics, passes, rank_key, run_portfolio, trade_dicts
from .config import ET, runtime_dir, shadow_variants, variants
from .replay import replay, spy_returns

log = logging.getLogger("bull.bakeoff")


def trading_days(n: int) -> list[date]:
    today = datetime.now(ET).date()
    cal = broker.client().get_calendar(GetCalendarRequest(start=today - timedelta(days=n * 2 + 10), end=today))
    days = [c.date if isinstance(c.date, date) else date.fromisoformat(str(c.date)) for c in cal]
    return [d for d in days if d < today][-n:]


def candidates(cfg: dict) -> list[dict]:
    """Methods plus filters, dropping a filter that is the same rule as an existing method."""
    pool = list(variants(cfg))
    seen = {(v["strategy"], json.dumps(v.get("params", {}), sort_keys=True)) for v in pool}
    for v in shadow_variants(cfg):
        key = (v["strategy"], json.dumps(v.get("params", {}), sort_keys=True))
        if key not in seen:
            pool.append(v)
            seen.add(key)
    return pool


def run(cfg: dict, days_n: int | None = None) -> dict:
    days_n = days_n or cfg["bakeoff"]["days"]
    days = trading_days(days_n)
    vs = candidates(cfg)
    log.info("bake-off over %d days %s..%s, %d candidates", len(days), days[0], days[-1], len(vs))
    rep = replay(cfg, vs, days)

    start_eq = float(cfg["account"]["start_equity"])
    results, all_trades = {}, {}
    for v in vs:
        trades = run_portfolio(rep["cands"].get(v["name"], {}), cfg)
        m = metrics(trades, start_eq, days)
        m["passed"] = passes(m, cfg["bakeoff"])
        m["strategy"] = v["strategy"]
        m["params"] = v.get("params", {})
        results[v["name"]] = m
        all_trades[v["name"]] = trade_dicts(trades)

    ranking = sorted(results, key=lambda n: rank_key(n, results[n]), reverse=True)
    spy_total, spy_years = spy_returns(rep["daily"], days)
    summary = {
        "generated_at": datetime.now(ET).isoformat(timespec="seconds"),
        "period": [days[0].isoformat(), days[-1].isoformat()],
        "days": len(days),
        "symbol_days": rep["symbol_days"],
        "start_equity": start_eq,
        "spy_return_pct": spy_total,
        "spy_by_year": spy_years,
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
    r = summary["rules"]
    print(f"Bake-off {summary['period'][0]}..{summary['period'][1]} ({summary['days']} days), "
          f"${summary['start_equity']:,.0f} book, SPY {summary['spy_return_pct']}%")
    print(f"Pass rule: >= {r['min_trades']} trades, net > 0, t >= {r['min_t_stat']}, "
          f"positive in > {r['min_positive_year_share']:.0%} of years (10+ trades)")
    print(f"{'variant':<17}{'trades':>7}{'win%':>7}{'net $':>11}{'ret%':>8}{'PF':>6}{'avgR':>8}{'t':>6}"
          f"{'yrs+':>7}{'maxDD%':>8}  pass")
    for n in summary["ranking"]:
        m = summary["results"][n]
        print(f"{n:<17}{m['trades']:>7}{m['win_rate']:>7}{m['net_pnl']:>11}{m['return_pct']:>8}"
              f"{m['profit_factor']:>6}{m['mean_r']:>8.3f}{m['t_stat']:>6}"
              f"{str(m['positive_years']) + '/' + str(m['counted_years']):>7}{m['max_drawdown_pct']:>8}"
              f"  {'YES' if m['passed'] else 'no'}")
