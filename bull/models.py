from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime


@dataclass(frozen=True, slots=True)
class Bar:
    t: datetime  # bar START, America/New_York
    o: float
    h: float
    l: float
    c: float
    v: float


@dataclass(slots=True)
class Signal:
    variant: str
    symbol: str
    side: str          # "long" | "short"
    t: datetime        # time of the bar that triggered it (entry happens on the next bar)
    ref: float         # trigger price (bar close)
    stop: float
    target: float
    why: str
    features: dict = field(default_factory=dict)

    @property
    def risk_per_share(self) -> float:
        return abs(self.ref - self.stop)


@dataclass
class DayContext:
    """Per symbol-day indicator state. Arrays are cumulative, so index k never sees bars after k."""
    symbol: str
    prev_close: float | None
    bars: list[Bar]
    vw: list[float] = field(default_factory=list)
    above: list[int] = field(default_factory=list)   # running count of closes above VWAP
    memo: dict = field(default_factory=dict)
    extra: dict = field(default_factory=dict)        # atr, or_vol_avg: facts from before today

    def __post_init__(self) -> None:
        self.refresh()

    def refresh(self) -> None:
        """Recompute from self.bars. Live calls this each minute; backtest calls it once."""
        pv = vol = 0.0
        count = 0
        self.vw, self.above = [], []
        for b in self.bars:
            typical = (b.h + b.l + b.c) / 3
            pv += typical * b.v
            vol += b.v
            vw = pv / vol if vol > 0 else typical
            self.vw.append(vw)
            count += 1 if b.c > vw else 0
            self.above.append(count)
        self.memo.clear()
