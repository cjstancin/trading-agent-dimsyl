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
    """Last price, change vs prior close and today's gap, IEX feed. Display only."""
    if not symbols:
        return {}
    raw = c.get_stock_snapshot(StockSnapshotRequest(symbol_or_symbols=symbols, feed=DataFeed.IEX)) or {}
    out = {}
    for sym, snap in raw.items():
        snap = snap or {}
        prev = (snap.get("prevDailyBar") or {}).get("c")
        day = snap.get("dailyBar") or {}
        last = (snap.get("latestTrade") or {}).get("p") or day.get("c")
        if not last:
            continue
        out[sym] = {
            "last": float(last),
            "chg_pct": round((last / prev - 1) * 100, 2) if prev else None,
            "gap_pct": round((day["o"] / prev - 1) * 100, 2) if prev and day.get("o") else None,
            "high": day.get("h"), "low": day.get("l"),
        }
    return out


def session_bars(c, symbol: str, minutes: int = 5) -> dict:
    """The latest session's bars for one symbol (today if trading has started), bucketed, with VWAP."""
    now = datetime.now(ET)
    raw = _fetch(c, [symbol], TimeFrame.Minute, now - timedelta(days=6), None, DataFeed.IEX).get(symbol, [])
    bars = _session(raw)
    if not bars:
        return {"symbol": symbol, "day": None, "bars": []}
    day = bars[-1].t.date()
    bars = [b for b in bars if b.t.date() == day]
    out, pv, vol = [], 0.0, 0.0
    bucket = None
    for b in bars:
        pv += (b.h + b.l + b.c) / 3 * b.v
        vol += b.v
        key = b.t.replace(minute=b.t.minute - b.t.minute % minutes, second=0)
        if bucket and bucket["t"] == key.strftime("%H:%M"):
            bucket.update(h=max(bucket["h"], b.h), l=min(bucket["l"], b.l), c=b.c, v=bucket["v"] + b.v)
        else:
            bucket = {"t": key.strftime("%H:%M"), "o": b.o, "h": b.h, "l": b.l, "c": b.c, "v": b.v}
            out.append(bucket)
        bucket["vwap"] = round(pv / vol, 4) if vol else b.c
    return {"symbol": symbol, "day": day.isoformat(), "minutes": minutes, "bars": out}


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
    if path.exists():
        blob = json.loads(path.read_text(encoding="utf-8"))
        if blob["start"] <= start.isoformat() and blob["end"] >= end.isoformat():
            return {date.fromisoformat(d): v for d, v in blob["vols"].items()}
        cached = blob["vols"]
    bars = _fetch(c, [symbol], TimeFrame(5, TimeFrameUnit.Minute), datetime.combine(start, time(9, 30), ET),
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
