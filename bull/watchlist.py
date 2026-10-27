"""Morning pick: the biggest gappers plus the most liquid names, up to the stream limit."""
from __future__ import annotations


def pick(stats: dict[str, dict], wl_cfg: dict) -> list[str]:
    """stats[symbol] = {prev_close, open, prev_dollar_volume}. Same rule live and in backtest."""
    eligible = {
        s: d for s, d in stats.items()
        if d.get("prev_close") and d.get("open")
        and d["open"] >= wl_cfg["min_price"]
        and d.get("prev_dollar_volume", 0) >= wl_cfg["min_dollar_volume"]
    }
    gaps = {s: (d["open"] / d["prev_close"] - 1) * 100 for s, d in eligible.items()}
    gappers = sorted(
        (s for s, g in gaps.items() if abs(g) >= wl_cfg["min_gap_pct"]),
        key=lambda s: -abs(gaps[s]),
    )[: wl_cfg["gappers"]]
    rest = sorted(
        (s for s in eligible if s not in gappers),
        key=lambda s: -eligible[s]["prev_dollar_volume"],
    )
    return (gappers + rest)[: wl_cfg["size"]]
