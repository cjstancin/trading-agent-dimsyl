"""Market data through Alpaca's official SDK.

Live: free IEX feed. Backtest: full SIP history (free on Basic once it is >15 minutes old),
cached on disk per symbol-day so re-runs don't re-download.
"""
from __future__ import annotations

import gzip
import json
import logging
import time as _time
from datetime import date, datetime, time, timedelta, timezone

from alpaca.data.enums import DataFeed
from alpaca.data.historical import StockHistoricalDataClient
from alpaca.data.requests import StockBarsRequest, StockSnapshotRequest
from alpaca.data.timeframe import TimeFrame, TimeFrameUnit

from .config import ET, alpaca_keys, runtime_dir
from .models import Bar

log = logging.getLogger("bull.data")
OPEN, CLOSE = time(9, 30), time(16, 0)


def client() -> StockHistoricalDataClient:
    key, secret = alpaca_keys()
    return StockHistoricalDataClient(key, secret, raw_data=True)


def _parse(raw) -> dict[str, list[dict]]:
    if isinstance(raw, dict) and "bars" in raw and isinstance(raw["bars"], dict):
        raw = raw["bars"]
    return raw or {}


def _to_bar(d: dict) -> Bar:
    t = datetime.fromisoformat(d["t"].replace("Z", "+00:00")).astimezone(ET)
    return Bar(t, float(d["o"]), float(d["h"]), float(d["l"]), float(d["c"]), float(d["v"]))


def _session(bars: list[Bar]) -> list[Bar]:
    return [b for b in bars if OPEN <= b.t.time() < CLOSE]


def _fetch(c: StockHistoricalDataClient, symbols, timeframe, start, end, feed) -> dict[str, list[Bar]]:
    req = StockBarsRequest(symbol_or_symbols=list(symbols), timeframe=timeframe, start=start, end=end,
                           feed=feed, adjustment="raw")
    for attempt in range(4):
        try:
            raw = _parse(c.get_stock_bars(req))
            return {s: [_to_bar(d) for d in rows] for s, rows in raw.items()}
        except Exception as exc:  # network blips and 429s: back off, then give up loudly
            if attempt == 3:
                raise
            log.warning("bars fetch failed (%s), retrying", exc)
            _time.sleep(5 * (attempt + 1))
    return {}


def today_minute_bars(c, symbols: list[str], day: date) -> dict[str, list[Bar]]:
    """Live: today's regular-session 1-min bars so far, IEX feed (one request for all symbols)."""
    start = datetime.combine(day, OPEN, ET)
    bars = _fetch(c, symbols, TimeFrame.Minute, start, None, DataFeed.IEX)
    return {s: _session(b) for s, b in bars.items()}


def daily_bars(c, symbols: list[str], start: date, end: date) -> dict[str, list[Bar]]:
    """Completed daily SIP bars (end is exclusive-ish: pass yesterday+1 for 'through yesterday')."""
    out: dict[str, list[Bar]] = {}
    end_dt = min(datetime.combine(end, time(0), ET), datetime.now(timezone.utc) - timedelta(minutes=16))
    for i in range(0, len(symbols), 50):
        out.update(_fetch(c, symbols[i:i + 50], TimeFrame.Day, datetime.combine(start, time(0), ET),
                          end_dt, DataFeed.SIP))
    return out


def _cache_path(symbol: str, day: date):
    p = runtime_dir() / "cache" / "sip-1m" / symbol
    p.mkdir(parents=True, exist_ok=True)
    return p / f"{day.isoformat()}.json.gz"


def history_minute_bars(c, symbol: str, days: list[date]) -> dict[date, list[Bar]]:
    """Backtest: SIP 1-min regular-session bars for the given days, from cache or Alpaca."""
    out: dict[date, list[Bar]] = {}
    missing = []
    for d in days:
        path = _cache_path(symbol, d)
        if path.exists():
            rows = json.loads(gzip.decompress(path.read_bytes()))
            out[d] = [Bar(datetime.fromisoformat(r[0]), *r[1:]) for r in rows]
        else:
            missing.append(d)
    if missing:
        start = datetime.combine(min(missing), OPEN, ET)
        end = datetime.combine(max(missing), CLOSE, ET)
        fetched = _session(_fetch(c, [symbol], TimeFrame.Minute, start, end, DataFeed.SIP).get(symbol, []))
        by_day: dict[date, list[Bar]] = {}
        for b in fetched:
            by_day.setdefault(b.t.date(), []).append(b)
        for d in missing:
            rows = by_day.get(d, [])
            out[d] = rows
            if rows:  # don't cache an empty day; it may be a fetch gap rather than a holiday
                payload = [[b.t.isoformat(), b.o, b.h, b.l, b.c, b.v] for b in rows]
                _cache_path(symbol, d).write_bytes(gzip.compress(json.dumps(payload).encode()))
    return out


def snapshots(c, symbols: list[str]) -> dict[str, dict]:
    """Last price, change vs prior close and today's gap, IEX feed. Display only.

    Before the open the snapshot's daily bar is still yesterday's, so the gap is the premarket
    price against yesterday's close (an indicative gap), and high/low are blank.
    """
    if not symbols:
        return {}
    today = datetime.now(ET).date()
    raw = c.get_stock_snapshot(StockSnapshotRequest(symbol_or_symbols=symbols, feed=DataFeed.IEX)) or {}
    out = {}
    for sym, snap in raw.items():
        snap = snap or {}
        day = snap.get("dailyBar") or {}
        trade = snap.get("latestTrade") or {}
        last = trade.get("p") or day.get("c")
        if not last:
            continue
        day_date = datetime.fromisoformat(day["t"].replace("Z", "+00:00")).astimezone(ET).date() if day.get("t") else None
        if day_date and day_date < today:  # premarket / holiday: today's session hasn't printed a daily bar
            ref = day.get("c")
            out[sym] = {"last": float(last), "chg_pct": round((last / ref - 1) * 100, 2) if ref else None,
                        "gap_pct": round((last / ref - 1) * 100, 2) if ref else None, "high": None, "low": None,
                        "premarket": True, "prev": ref, "t": trade.get("t")}
            continue
        prev = (snap.get("prevDailyBar") or {}).get("c")
        out[sym] = {
            "last": float(last),
            "chg_pct": round((last / prev - 1) * 100, 2) if prev else None,
            "gap_pct": round((day["o"] / prev - 1) * 100, 2) if prev and day.get("o") else None,
            "high": day.get("h"), "low": day.get("l"), "premarket": False, "prev": prev, "t": trade.get("t"),
        }
    return out


_prev_day_cache: dict[tuple[str, date], Bar | None] = {}


def _prev_day(c, symbol: str, day: date) -> Bar | None:
    key = (symbol, day)
    if key not in _prev_day_cache:
        bars = [b for b in daily_bars(c, [symbol], day - timedelta(days=10), day).get(symbol, []) if b.t.date() < day]
        _prev_day_cache[key] = bars[-1] if bars else None
    return _prev_day_cache[key]


def session_bars(c, symbol: str, minutes: int = 5) -> dict:
    """Chart data for the latest session: N-minute candles with VWAP, key levels, and the forming
    candle pushed to the latest trade so the chart moves between minute bars."""
    from .features import bucket_bars, key_levels
    now = datetime.now(ET)
    raw = _fetch(c, [symbol], TimeFrame.Minute, now - timedelta(days=6), None, DataFeed.IEX).get(symbol, [])
    session = _session(raw)
    if not session:
        return {"symbol": symbol, "day": None, "bars": [], "levels": []}
    day = session[-1].t.date()
    session = [b for b in session if b.t.date() == day]
    premarket = [b for b in raw if b.t.date() == day and time(4) <= b.t.time() < OPEN]
    out = bucket_bars(session, minutes)
    live = day == now.date() and OPEN <= now.time() < CLOSE
    if live and out:
        try:
            last = snapshots(c, [symbol]).get(symbol, {}).get("last")
        except Exception:
            last = None
        if last:
            out[-1].update(c=last, h=max(out[-1]["h"], last), l=min(out[-1]["l"], last))
    return {"symbol": symbol, "day": day.isoformat(), "minutes": minutes, "bars": out, "live": live,
            "levels": key_levels(_prev_day(c, symbol, day), premarket, session)}


def day_minute_bars(c, day: date, symbols: list[str]) -> dict[str, list[Bar]]:
    """Backtest: one day's SIP 1-min session bars for several symbols in one request, cached."""
    out: dict[str, list[Bar]] = {}
    missing = []
    for s in symbols:
        path = _cache_path(s, day)
        if path.exists():
            rows = json.loads(gzip.decompress(path.read_bytes()))
            out[s] = [Bar(datetime.fromisoformat(r[0]), *r[1:]) for r in rows]
        else:
            missing.append(s)
    if missing:
        fetched = _fetch(c, missing, TimeFrame.Minute, datetime.combine(day, OPEN, ET),
                         datetime.combine(day, CLOSE, ET), DataFeed.SIP)
        for s in missing:
            rows = _session(fetched.get(s, []))
            out[s] = rows
            if rows or fetched:  # an empty symbol in a successful request = no trading that day
                payload = [[b.t.isoformat(), b.o, b.h, b.l, b.c, b.v] for b in rows]
                _cache_path(s, day).write_bytes(gzip.compress(json.dumps(payload).encode()))
    return out


def opening_volumes(c, symbol: str, start: date, end: date, feed=DataFeed.SIP) -> dict[date, float]:
    """Volume of the 09:30 five-minute bar per session (the opening range), cached per symbol."""
    path = runtime_dir() / "cache" / f"or-vol-{feed.value}" / f"{symbol}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    cached = {}
    fetch_from = start
    if path.exists():
        blob = json.loads(path.read_text(encoding="utf-8"))
        if blob["start"] <= start.isoformat() and blob["end"] >= end.isoformat():
            return {date.fromisoformat(d): v for d, v in blob["vols"].items()}
        cached = blob["vols"]
        if blob["start"] <= start.isoformat():  # only the newer days are missing: fetch the tail
            fetch_from = date.fromisoformat(blob["end"]) + timedelta(days=1)
            start = date.fromisoformat(blob["start"])
    bars = _fetch(c, [symbol], TimeFrame(5, TimeFrameUnit.Minute), datetime.combine(fetch_from, time(9, 30), ET),
                  min(datetime.combine(end, time(10, 0), ET), datetime.now(timezone.utc) - timedelta(minutes=16)),
                  feed).get(symbol, [])
    vols = {**cached, **{b.t.date().isoformat(): b.v for b in bars if b.t.time() == OPEN}}
    path.write_text(json.dumps({"start": start.isoformat(), "end": end.isoformat(), "vols": vols}), encoding="utf-8")
    return {date.fromisoformat(d): v for d, v in vols.items()}


def opening_volumes_multi(c, symbols: list[str], start: date, end: date, feed=DataFeed.IEX) -> dict[str, dict[date, float]]:
    """Live: opening-range (09:30 five-minute bar) volume per session for many symbols in one request."""
    if not symbols:
        return {}
    bars = _fetch(c, symbols, TimeFrame(5, TimeFrameUnit.Minute), datetime.combine(start, time(9, 30), ET),
                  datetime.combine(end, time(10, 0), ET), feed)
    return {s: {b.t.date(): b.v for b in rows if b.t.time() == OPEN} for s, rows in bars.items()}
