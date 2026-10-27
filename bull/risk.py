"""Position sizing, entry gates and trading costs. Pure functions shared by live and backtest."""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime

from .config import hhmm


def size_position(equity: float, buying_power: float, ref: float, stop: float, risk_cfg: dict) -> int:
    """Whole shares (Alpaca brackets can't be fractional) so a stop-out loses ~risk_per_trade_pct."""
    per_share = abs(ref - stop)
    if per_share <= 0 or ref <= 0:
        return 0
    risk_dollars = equity * risk_cfg["risk_per_trade_pct"] / 100
    qty = math.floor(risk_dollars / per_share)
    cap = min(equity * risk_cfg["max_position_pct"] / 100, buying_power * 0.95)
    return max(0, min(qty, math.floor(cap / ref)))


@dataclass
class DayState:
    """What has happened today, rebuilt from Alpaca on every restart (Alpaca is the truth)."""
    open_positions: int = 0
    trades_today: int = 0
    taken: set[tuple[str, str]] = field(default_factory=set)   # (variant, symbol)
    day_pnl_pct: float = 0.0


def entry_block(state: DayState, now: datetime, variant: str, symbol: str, risk_cfg: dict) -> str | None:
    """Reason a new entry is not allowed, or None."""
    if state.day_pnl_pct <= -risk_cfg["daily_loss_limit_pct"]:
        return "daily loss limit"
    if now.time() >= hhmm(risk_cfg["no_new_entries_after"]):
        return "past last entry time"
    if state.open_positions >= risk_cfg["max_positions"]:
        return "max positions open"
    if state.trades_today >= risk_cfg["max_trades_per_day"]:
        return "max trades for the day"
    if (variant, symbol) in state.taken:
        return "already traded this setup today"
    return None


def sell_fees(price: float, qty: int, costs: dict) -> float:
    """SEC Section 31 + FINRA TAF, charged on every sell (including the opening sell of a short)."""
    sec = price * qty * costs["sec_fee_per_million"] / 1_000_000
    taf = min(qty * costs["taf_per_share"], costs["taf_max"])
    return round(sec + taf, 4)
