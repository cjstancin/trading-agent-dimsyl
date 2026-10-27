"""Everything that touches the Alpaca account, through the official SDK.

Alpaca is the only source of truth for cash, positions and fills. v3 keeps no ledger of its own:
day state is rebuilt from today's orders on every tick, so a restart loses nothing.
"""
from __future__ import annotations

import logging
from datetime import date, datetime, time

from alpaca.trading.client import TradingClient
from alpaca.trading.enums import OrderClass, OrderSide, OrderType, QueryOrderStatus, TimeInForce
from alpaca.trading.requests import (GetOrdersRequest, MarketOrderRequest, StopLossRequest,
                                     TakeProfitRequest)

from .config import ET, alpaca_keys
from .models import Signal
from .risk import DayState

log = logging.getLogger("bull.broker")
PREFIX = "v3"
STOP_TYPES = {OrderType.STOP, OrderType.STOP_LIMIT, OrderType.TRAILING_STOP}


def client() -> TradingClient:
    key, secret = alpaca_keys()
    return TradingClient(key, secret, paper=True)  # never url_override: paper is hard-wired


def coid(sig: Signal) -> str:
    return f"{PREFIX}-{sig.variant}-{sig.symbol}-{sig.t:%Y%m%d}-{sig.t:%H%M}"


def parse_coid(value: str | None) -> tuple[str, str] | None:
    parts = (value or "").split("-")
    if len(parts) == 5 and parts[0] == PREFIX:
        return parts[1], parts[2]
    return None


def submit_bracket(tc: TradingClient, sig: Signal, qty: int):
    """Market entry with the stop and target attached. Alpaca holds both exits from the moment of fill."""
    req = MarketOrderRequest(
        symbol=sig.symbol,
        qty=qty,
        side=OrderSide.BUY if sig.side == "long" else OrderSide.SELL,
        time_in_force=TimeInForce.DAY,
        order_class=OrderClass.BRACKET,
        take_profit=TakeProfitRequest(limit_price=sig.target),
        stop_loss=StopLossRequest(stop_price=sig.stop),
        client_order_id=coid(sig),
    )
    return tc.submit_order(req)


def todays_orders(tc: TradingClient, day: date) -> list:
    req = GetOrdersRequest(status=QueryOrderStatus.ALL, after=datetime.combine(day, time(4), ET),
                           limit=500, nested=True)
    return tc.get_orders(req)


def day_state(tc: TradingClient, day: date, account, positions: list) -> DayState:
    state = DayState(open_positions=len(positions))
    for o in todays_orders(tc, day):
        parsed = parse_coid(o.client_order_id)
        if not parsed:
            continue
        state.taken.add(parsed)
        if _status(o.status) not in ("canceled", "rejected", "expired"):
            state.trades_today += 1
    last = float(account.last_equity or 0)
    if last > 0:
        state.day_pnl_pct = (float(account.equity) / last - 1) * 100
    return state


def unprotected(tc: TradingClient, positions: list, day: date) -> list[str]:
    """Symbols held with no live stop order behind them."""
    protected = set()
    for o in todays_orders(tc, day):
        for leg in [o] + list(o.legs or []):
            if leg.type in STOP_TYPES and _is_live(leg.status):
                protected.add(leg.symbol)
    return [p.symbol for p in positions if p.symbol not in protected]


def _status(status) -> str:
    return getattr(status, "value", str(status))


def _is_live(status) -> bool:
    return _status(status) in ("new", "accepted", "held", "partially_filled", "pending_new", "accepted_for_bidding")


def flatten(tc: TradingClient) -> None:
    tc.close_all_positions(cancel_orders=True)


def close_symbol(tc: TradingClient, symbol: str, day: date) -> None:
    """Cancel only this symbol's live orders (they reserve the shares), then close it at market."""
    for o in todays_orders(tc, day):
        for leg in [o] + list(o.legs or []):
            if leg.symbol == symbol and _is_live(leg.status):
                try:
                    tc.cancel_order_by_id(leg.id)
                except Exception as exc:
                    log.warning("cancel %s failed: %s", leg.id, exc)
    tc.close_position(symbol)
