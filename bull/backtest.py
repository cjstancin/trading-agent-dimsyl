"""Replay strategies on historical 1-min bars with the same rules the live engine follows.

Fills are pessimistic on purpose: entry at the next bar's open plus slippage, a stop that gaps is
filled at the worse open, and a bar that touches both stop and target counts as the stop.
"""
from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import asdict, dataclass
from datetime import date, datetime

from .config import hhmm
from .models import Bar, DayContext, Signal
from .risk import sell_fees, size_position
from .strategies import evaluate


@dataclass
class Exit:
    t_entry: datetime
    t_exit: datetime
    entry: float
    exit: float
    reason: str  # "target" | "stop" | "close"


@dataclass
class Trade:
    variant: str
    symbol: str
    side: str
    day: str
    t_entry: str
    t_exit: str
    entry: float
    exit: float
    qty: int
    reason: str
    fees: float
    pnl: float
    r: float
    why: str


def simulate_exit(bars: list[Bar], k: int, sig: Signal, slip_bps: float, flatten_at: str) -> Exit | None:
    if k + 1 >= len(bars):
        return None
    slip = slip_bps / 10_000
    flat = hhmm(flatten_at)
    long = sig.side == "long"
    first = bars[k + 1]
    if first.t.time() >= flat:
        return None
    entry = first.o * (1 + slip) if long else first.o * (1 - slip)
    if (long and not sig.stop < entry < sig.target) or (not long and not sig.target < entry < sig.stop):
        return None  # price already ran through an exit; live, Alpaca would reject the bracket
    for b in bars[k + 1:]:
        if b.t.time() >= flat:
            px = b.o * (1 - slip) if long else b.o * (1 + slip)
            return Exit(first.t, b.t, entry, px, "close")
        if long:
            if b.l <= sig.stop:
                return Exit(first.t, b.t, entry, min(sig.stop, b.o) * (1 - slip), "stop")
            if b.h >= sig.target:
                return Exit(first.t, b.t, entry, max(sig.target, b.o), "target")
        else:
            if b.h >= sig.stop:
                return Exit(first.t, b.t, entry, max(sig.stop, b.o) * (1 + slip), "stop")
            if b.l <= sig.target:
                return Exit(first.t, b.t, entry, min(sig.target, b.o), "target")
    last = bars[-1]
    return Exit(first.t, last.t, entry, last.c, "close")


def day_candidates(variants: list[dict], ctx: DayContext, cfg: dict) -> list[tuple[Signal, Exit]]:
    """First signal of each variant on one symbol-day, with its simulated exit."""
    out = []
    pending = list(variants)
    for k in range(1, len(ctx.bars)):
        for v in list(pending):
            sig = evaluate(v, ctx, k)
            if sig is None:
                continue
            pending.remove(v)
            ex = simulate_exit(ctx.bars, k, sig, cfg["costs"]["slippage_bps"], cfg["risk"]["flatten_at"])
            if ex:
                out.append((sig, ex))
        if not pending:
            break
    return out


def run_portfolio(cands: dict[date, list[tuple[Signal, Exit]]], cfg: dict) -> list[Trade]:
    """Apply the live risk rules day by day: sizing off equity, max positions, trade and loss caps."""
    risk, costs = cfg["risk"], cfg["costs"]
    equity = float(cfg["account"]["start_equity"])
    trades: list[Trade] = []
    for day in sorted(cands):
        start_equity = equity
        open_exits: list[tuple[datetime, float]] = []
        taken = 0
        for sig, ex in sorted(cands[day], key=lambda c: c[1].t_entry):
            if ex.t_entry.time() >= hhmm(risk["no_new_entries_after"]):
                continue
            realized_before = sum(p for t, p in open_exits if t <= ex.t_entry)
            if realized_before / start_equity * 100 <= -risk["daily_loss_limit_pct"]:
                break
            live = [t for t, _ in open_exits if t > ex.t_entry]
            if len(live) >= risk["max_positions"] or taken >= risk["max_trades_per_day"]:
                continue
            qty = size_position(start_equity, start_equity, sig.ref, sig.stop, risk)
            if qty < 1:
                continue
            sgn = 1 if sig.side == "long" else -1
            sell_px = ex.exit if sig.side == "long" else ex.entry
            fees = sell_fees(sell_px, qty, costs)
            pnl = sgn * (ex.exit - ex.entry) * qty - fees
            r = pnl / (sig.risk_per_share * qty) if sig.risk_per_share else 0.0
            open_exits.append((ex.t_exit, pnl))
            taken += 1
            trades.append(Trade(sig.variant, sig.symbol, sig.side, day.isoformat(), ex.t_entry.isoformat(),
                                ex.t_exit.isoformat(), round(ex.entry, 4), round(ex.exit, 4), qty, ex.reason,
                                round(fees, 4), round(pnl, 2), round(r, 3), sig.why))
        day_pnl = sum(p for _, p in open_exits)
        equity += day_pnl
    return trades


def metrics(trades: list[Trade], start_equity: float, days: list[date]) -> dict:
    pnl = [t.pnl for t in trades]
    wins = [p for p in pnl if p > 0]
    losses = [p for p in pnl if p <= 0]
    eq, peak, max_dd = start_equity, start_equity, 0.0
    for p in pnl:
        eq += p
        peak = max(peak, eq)
        max_dd = max(max_dd, (peak - eq) / peak * 100)
    mid = days[len(days) // 2].isoformat() if days else ""
    first = sum(t.pnl for t in trades if t.day < mid)
    second = sum(t.pnl for t in trades if t.day >= mid)
    gross_loss = abs(sum(losses))
    rs = [t.r for t in trades]
    mean_r = sum(rs) / len(rs) if rs else 0.0
    se_r = (math.sqrt(sum((r - mean_r) ** 2 for r in rs) / (len(rs) - 1)) / math.sqrt(len(rs))) if len(rs) > 1 else None
    by_year = defaultdict(list)
    for t in trades:
        by_year[t.day[:4]].append(t)
    years = {y: {"trades": len(ts), "net_pnl": round(sum(t.pnl for t in ts), 2),
                 "win_rate": round(sum(t.pnl > 0 for t in ts) / len(ts) * 100, 1)}
             for y, ts in sorted(by_year.items())}
    # A year counts only with enough trades to mean something; a 2-trade stub year is noise.
    counted = [y for y in years.values() if y["trades"] >= 10]
    positive = sum(1 for y in counted if y["net_pnl"] > 0)
    return {
        "trades": len(trades),
        "win_rate": round(len(wins) / len(trades) * 100, 1) if trades else 0.0,
        "net_pnl": round(sum(pnl), 2),
        "return_pct": round(sum(pnl) / start_equity * 100, 2),
        "fees": round(sum(t.fees for t in trades), 2),
        "profit_factor": round(sum(wins) / gross_loss, 2) if gross_loss else (99.0 if wins else 0.0),
        "avg_r": round(sum(t.r for t in trades) / len(trades), 3) if trades else 0.0,
        "max_drawdown_pct": round(max_dd, 2),
        "first_half_pnl": round(first, 2),
        "second_half_pnl": round(second, 2),
        "exits": {r: sum(1 for t in trades if t.reason == r) for r in ("target", "stop", "close")},
        "mean_r": round(mean_r, 4),
        "se_r": round(se_r, 4) if se_r else None,
        "t_stat": round(mean_r / se_r, 2) if se_r else 0.0,
        "by_year": years,
        "positive_years": positive,
        "counted_years": len(counted),
        "positive_year_share": round(positive / len(counted), 3) if counted else 0.0,
    }


def passes(m: dict, bcfg: dict) -> bool:
    """Proven means: enough trades, net profit after costs, a mean R at least t_stat standard errors
    above zero, and profitable in MORE than min_positive_year_share of the years it traded."""
    return (m["trades"] >= bcfg["min_trades"]
            and m["net_pnl"] > 0
            and m["profit_factor"] >= bcfg.get("min_profit_factor", 1.0)
            and m["t_stat"] >= bcfg["min_t_stat"]
            and m["positive_year_share"] > bcfg["min_positive_year_share"])


def rank_key(name: str, m: dict) -> tuple:
    """Passing variants first, then by statistical strength (t-stat), not raw dollars."""
    return (m["passed"], m["t_stat"], m["net_pnl"])


def trade_dicts(trades: list[Trade]) -> list[dict]:
    return [asdict(t) for t in trades]
