"""Filter test: replay the pre-registered [[shadow]] variants over years of history.

Compares the control (the live gap-and-go rule) against each filter and all filters combined,
with the same costs, sizing and portfolio rules as the bake-off. Writes runtime/experiment.json
and never touches runtime/bakeoff.json, so the live engine is unaffected.
"""
from __future__ import annotations

import json
import logging
import math
from datetime import datetime

from .backtest import metrics, run_portfolio, trade_dicts
from .bakeoff import trading_days
from .config import ET, runtime_dir, shadow_variants
from .replay import replay, spy_returns

log = logging.getLogger("bull.experiment")


def run(cfg: dict, days_n: int = 1000) -> dict:
    days = trading_days(days_n)
    vs = shadow_variants(cfg)
    log.info("experiment over %d days %s..%s", len(days), days[0], days[-1])
    rep = replay(cfg, vs, days, min_gap=min(v["params"].get("min_gap_pct", 3.0) for v in vs))

    start_eq = float(cfg["account"]["start_equity"])
    results, all_trades = {}, {}
    for v in vs:
        trades = run_portfolio(rep["cands"].get(v["name"], {}), cfg)
        m = metrics(trades, start_eq, days)
        m["params"] = v["params"]
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

    spy_total, spy_years = spy_returns(rep["daily"], days)
    summary = {
        "generated_at": datetime.now(ET).isoformat(timespec="seconds"),
        "period": [days[0].isoformat(), days[-1].isoformat()],
        "days": len(days),
        "candidate_symbol_days": rep["symbol_days"],
        "start_equity": start_eq,
        "spy_return_pct": spy_total,
        "spy_by_year": spy_years,
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
