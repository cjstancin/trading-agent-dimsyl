"""Live prices for the site: one Alpaca IEX trade stream, pushed to the page as server-sent events.

The free feed allows one market-data connection and 30 symbols, so the site owns the stream (the
engine doesn't use one) and subscribes to what matters most right now: the tape and open positions,
then the charted symbol, then the bot's watchlist. Everything else stays on the snapshot poll, and
if the stream is down the page simply keeps polling.
"""
from __future__ import annotations

import logging
import threading
import time
from datetime import datetime
from datetime import time as dtime

from alpaca.data.enums import DataFeed
from alpaca.data.live import StockDataStream

from .config import ET, alpaca_keys

log = logging.getLogger("bull.live")
MAX_SYMBOLS = 30
SESSION = (dtime(4), dtime(20))  # IEX prints pre- and post-market; outside this the stream sleeps
CHART_TTL_S = 120                # a charted symbol stays subscribed this long after its last fetch


class LiveFeed:
    def __init__(self):
        self.cv = threading.Condition()
        self.version = 0
        self.last: dict[str, dict] = {}
        self.first: list[str] = []
        self.rest: list[str] = []
        self.charts: dict[str, float] = {}
        self.stream: StockDataStream | None = None
        self.subscribed: set[str] = set()

    # --- what to stream -------------------------------------------------------------------------
    def set_priority(self, first: list[str], rest: list[str]) -> None:
        """first: tape + open positions (always streamed); rest: watchlist, streamed if room."""
        self.first, self.rest = list(first), list(rest)

    def note_chart(self, symbol: str) -> None:
        self.charts[symbol] = time.time()

    def desired(self) -> list[str]:
        now = time.time()
        charts = [s for s, t in sorted(self.charts.items(), key=lambda x: -x[1]) if now - t < CHART_TTL_S]
        out: list[str] = []
        for s in self.first + charts + self.rest:
            if s not in out:
                out.append(s)
        return out[:MAX_SYMBOLS]

    # --- what the page reads --------------------------------------------------------------------
    def on(self) -> bool:
        return bool(self.stream and getattr(self.stream, "_running", False))

    def wait(self, since: int, timeout: float) -> tuple[int, dict]:
        """Block until a price newer than `since` arrives (or timeout); return only what changed."""
        with self.cv:
            self.cv.wait_for(lambda: self.version > since, timeout)
            return self.version, {s: {"p": q["p"], "t": q["t"]} for s, q in self.last.items() if q["n"] > since}

    def record(self, symbol: str, price: float) -> None:
        with self.cv:
            self.version += 1
            self.last[symbol] = {"p": price, "t": datetime.now(ET).strftime("%H:%M:%S"), "n": self.version}
            self.cv.notify_all()

    async def _on_trade(self, t: dict) -> None:
        if t.get("S") and t.get("p"):
            self.record(t["S"], float(t["p"]))

    # --- connection -----------------------------------------------------------------------------
    def start(self) -> None:
        threading.Thread(target=self._manage, daemon=True, name="live-feed").start()

    @staticmethod
    def _in_session() -> bool:
        now = datetime.now(ET)
        return now.weekday() < 5 and SESSION[0] <= now.time() < SESSION[1]

    def _manage(self) -> None:
        while True:
            try:
                if self._in_session() and not self.stream:
                    self._open()
                elif not self._in_session() and self.stream:
                    self._close()
                elif self.stream:
                    self._sync()
            except Exception:
                log.exception("live feed manager")
            time.sleep(2)

    def _open(self) -> None:
        key, secret = alpaca_keys()
        st = StockDataStream(key, secret, raw_data=True, feed=DataFeed.IEX)
        syms = self.desired() or ["SPY"]  # the stream won't connect with nothing subscribed
        st.subscribe_trades(self._on_trade, *syms)
        self.stream, self.subscribed = st, set(syms)
        threading.Thread(target=st.run, daemon=True, name="live-stream").start()
        log.info("live stream opened, %d symbols", len(syms))

    def _close(self) -> None:
        try:
            self.stream.stop()
        except Exception as exc:
            log.warning("live stream stop: %s", exc)
        self.stream, self.subscribed = None, set()
        log.info("live stream closed (outside session)")

    def _sync(self) -> None:
        want = set(self.desired())
        if not want:
            return
        drop, add = self.subscribed - want, want - self.subscribed
        if drop:  # unsubscribe first so we never ask for more than the 30-symbol cap
            self.stream.unsubscribe_trades(*drop)
            self.subscribed -= drop
        if add:
            self.stream.subscribe_trades(self._on_trade, *add)
            self.subscribed |= add
