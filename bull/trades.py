"""Turn Alpaca's orders into round-trip trades for display. Read-only; Alpaca stays the record."""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from .broker import _status, parse_coid
from .config import ET
from .strategies import LABELS


def _f(x) -> float | None:
    return float(x) if x not in (None, "") else None


def _t(x) -> datetime | None:
    return x.astimezone(ET) if x else None


def _fill_time(order) -> datetime:
    return order.filled_at or order.updated_at or order.submitted_at


def round_trips(orders: list, variant_strategy: dict[str, str]) -> list[dict]:
    """Pair filled quantities, including canceled partials and a residual close-out."""
    fills = [o for o in orders if Decimal(o.filled_qty or "0") > 0]
    entries = [o for o in fills if parse_coid(o.client_order_id)]
    legs = {leg.id for e in entries for leg in e.legs or []}
    closes = sorted((o for o in fills if o.id not in legs and not parse_coid(o.client_order_id)), key=_fill_time)
    available = {o.id: Decimal(o.filled_qty) for o in closes}
    out = []
    for e in sorted(entries, key=_fill_time):
        variant, symbol = parse_coid(e.client_order_id)
        side = "long" if _status(e.side) == "buy" else "short"
        qty = Decimal(e.filled_qty)
        entry_px = Decimal(e.filled_avg_price)
        left, proceeds = qty, Decimal(0)
        exits = []
        for leg in e.legs or []:
            filled = Decimal(leg.filled_qty or "0")
            if filled:
                proceeds += filled * Decimal(leg.filled_avg_price)
                left -= filled
                exits.append((_fill_time(leg), "stop" if "stop" in _status(leg.type) else "target"))
        for o in closes:
            if left <= 0:
                break
            if (o.symbol != symbol or _status(o.side) == _status(e.side)
                    or _fill_time(o) < _fill_time(e) or not available[o.id]):
                continue
            filled = min(left, available[o.id])
            available[o.id] -= filled
            proceeds += filled * Decimal(o.filled_avg_price)
            left -= filled
            exits.append((_fill_time(o), "close"))
        exit_px = float(proceeds / qty) if left == 0 else None
        exit_t, reason = max(exits) if left == 0 else (None, "open")
        sgn = 1 if side == "long" else -1
        pnl = float(round(sgn * (proceeds - entry_px * qty), 2)) if exit_px is not None else None
        strategy = variant_strategy.get(variant, "")
        out.append({
            "symbol": symbol, "side": side, "qty": float(qty), "variant": variant,
            "strategy": LABELS.get(strategy, variant),
            "entry": float(entry_px), "exit": exit_px, "reason": reason, "pnl": pnl,
            "stop": _f(next((l.stop_price for l in e.legs or [] if "stop" in _status(l.type)), None)),
            "target": _f(next((l.limit_price for l in e.legs or [] if _status(l.type) == "limit"), None)),
            "t_entry": _t(_fill_time(e)).isoformat(timespec="minutes"),
            "t_exit": _t(exit_t).isoformat(timespec="minutes") if exit_t else None,
        })
    return out


def summarize(trips: list[dict]) -> dict:
    closed = [t for t in trips if t["pnl"] is not None]
    wins = [t for t in closed if t["pnl"] > 0]
    return {
        "trades": len(closed),
        "win_rate": round(len(wins) / len(closed) * 100, 1) if closed else None,
        "net": round(sum(t["pnl"] for t in closed), 2),
    }
