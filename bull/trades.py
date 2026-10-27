"""Turn Alpaca's orders into round-trip trades for display. Read-only; Alpaca stays the record."""
from __future__ import annotations

from datetime import datetime

from .broker import _status, parse_coid
from .config import ET
from .strategies import LABELS


def _f(x) -> float | None:
    return float(x) if x not in (None, "") else None


def _t(x) -> datetime | None:
    return x.astimezone(ET) if x else None


def round_trips(orders: list, variant_strategy: dict[str, str]) -> list[dict]:
    """Pair each filled v3 bracket entry with whichever exit filled: target leg, stop leg or the close-out."""
    fills = [o for o in orders if _status(o.status) == "filled"]
    entries = [o for o in fills if parse_coid(o.client_order_id)]
    used: set = set()
    out = []
    for e in sorted(entries, key=lambda o: o.filled_at):
        variant, symbol = parse_coid(e.client_order_id)
        side = "long" if _status(e.side) == "buy" else "short"
        qty = float(e.filled_qty)
        entry_px = float(e.filled_avg_price)
        exit_px = exit_t = None
        reason = "open"
        for leg in e.legs or []:
            if _status(leg.status) == "filled":
                exit_px, exit_t = float(leg.filled_avg_price), leg.filled_at
                reason = "stop" if "stop" in _status(leg.type) else "target"
                break
        if exit_px is None:  # closed by the end-of-day flatten or a protection close
            for o in sorted(fills, key=lambda o: o.filled_at):
                if (o.symbol == symbol and o.id not in used and not parse_coid(o.client_order_id)
                        and _status(o.side) != _status(e.side) and o.filled_at >= e.filled_at):
                    used.add(o.id)
                    exit_px, exit_t, reason = float(o.filled_avg_price), o.filled_at, "close"
                    break
        sgn = 1 if side == "long" else -1
        pnl = round(sgn * (exit_px - entry_px) * qty, 2) if exit_px is not None else None
        strategy = variant_strategy.get(variant, "")
        out.append({
            "symbol": symbol, "side": side, "qty": qty, "variant": variant,
            "strategy": LABELS.get(strategy, variant),
            "entry": entry_px, "exit": exit_px, "reason": reason, "pnl": pnl,
            "stop": _f(next((l.stop_price for l in e.legs or [] if "stop" in _status(l.type)), None)),
            "target": _f(next((l.limit_price for l in e.legs or [] if _status(l.type) == "limit"), None)),
            "t_entry": _t(e.filled_at).isoformat(timespec="minutes"),
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
