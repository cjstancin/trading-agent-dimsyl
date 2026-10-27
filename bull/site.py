"""The one-page site: a tiny read-only HTTP server. Numbers come straight from Alpaca."""
from __future__ import annotations

import json
import logging
import threading
import time
from collections import deque
from datetime import date, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from alpaca.trading.enums import QueryOrderStatus
from alpaca.trading.requests import GetOrdersRequest, GetPortfolioHistoryRequest

from . import broker, data
from .config import ET, ROOT, runtime_dir, variants
from .trades import round_trips, summarize

log = logging.getLogger("bull.site")
CACHE_S = 20


class State:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.tc = broker.client()
        self.dc = data.client()
        self.lock = threading.Lock()
        self.cached: tuple[float, dict] | None = None
        self.spy: tuple[float, list] | None = None
        self.bar_cache: dict[str, tuple[float, dict]] = {}

    def get(self) -> dict:
        with self.lock:
            if self.cached and time.time() - self.cached[0] < CACHE_S:
                return self.cached[1]
            payload = self.build()
            self.cached = (time.time(), payload)
            return payload

    def _read_json(self, name: str):
        try:
            return json.loads((runtime_dir() / name).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def _events(self, n: int = 40) -> list[dict]:
        try:
            with open(runtime_dir() / "events.jsonl", encoding="utf-8") as f:
                return [json.loads(line) for line in deque(f, maxlen=n)][::-1]
        except (OSError, ValueError):
            return []

    def _spy_daily(self, start: date) -> list:
        if not self.spy or time.time() - self.spy[0] > 1800:
            bars = data.daily_bars(self.dc, ["SPY"], start - timedelta(days=7), date.today() + timedelta(days=1))
            self.spy = (time.time(), bars.get("SPY", []))
        return self.spy[1]

    def bars(self, symbol: str) -> dict:
        key = symbol.upper()
        hit = self.bar_cache.get(key)
        if hit and time.time() - hit[0] < 60:
            return hit[1]
        payload = data.session_bars(self.dc, key)
        self.bar_cache[key] = (time.time(), payload)
        return payload

    def build(self) -> dict:
        acct_cfg = self.cfg["account"]
        start = date.fromisoformat(acct_cfg["start_date"])
        account = self.tc.get_account()
        positions = self.tc.get_all_positions()
        equity = float(account.equity)
        last_equity = float(account.last_equity or equity)

        hist = self.tc.get_portfolio_history(GetPortfolioHistoryRequest(
            start=datetime.combine(start, datetime.min.time(), ET), timeframe="1D"))
        curve = [{"d": datetime.fromtimestamp(ts, ET).date().isoformat(), "equity": e}
                 for ts, e in zip(hist.timestamp or [], hist.equity or []) if e]
        today = datetime.now(ET).date().isoformat()
        if not curve or curve[-1]["d"] != today:
            curve.append({"d": today, "equity": equity})
        base_eq = curve[0]["equity"] or acct_cfg["start_equity"]

        spy = self._spy_daily(start)
        spy_before = [b for b in spy if b.t.date() < start]
        spy_base = spy_before[-1].c if spy_before else (spy[0].o if spy else None)
        spy_by_day = {b.t.date().isoformat(): b.c for b in spy}
        last_spy = spy_base
        for pt in curve:
            pt["bull_pct"] = round((pt["equity"] / base_eq - 1) * 100, 2)
            last_spy = spy_by_day.get(pt["d"], last_spy)
            pt["spy_pct"] = round((last_spy / spy_base - 1) * 100, 2) if spy_base and last_spy else None

        intraday = self.tc.get_portfolio_history(GetPortfolioHistoryRequest(
            period="1D", timeframe="5Min", intraday_reporting="market_hours"))
        today_curve = [{"t": datetime.fromtimestamp(ts, ET).strftime("%H:%M"), "equity": e}
                       for ts, e in zip(intraday.timestamp or [], intraday.equity or []) if e]

        orders = self.tc.get_orders(GetOrdersRequest(
            status=QueryOrderStatus.ALL, after=datetime.combine(start, datetime.min.time(), ET),
            limit=500, nested=True, direction="desc"))
        vmap = {v["name"]: v["strategy"] for v in variants(self.cfg)}
        trips = round_trips(orders, vmap)
        today_trips = [t for t in trips if t["t_entry"].startswith(today)]

        status = self._read_json("status.json") or {}
        stale = True
        if status.get("updated"):
            age = (datetime.now(ET) - datetime.fromisoformat(status["updated"])).total_seconds()
            stale = age > 600
        bake = self._read_json("bakeoff.json")
        bake_view = None
        if bake:
            bake_view = {
                "period": bake["period"], "days": bake["days"], "spy_return_pct": bake["spy_return_pct"],
                "generated_at": bake["generated_at"], "passed": bake["passed"],
                "results": [{"name": n, **{k: bake["results"][n][k] for k in (
                    "strategy", "trades", "win_rate", "net_pnl", "return_pct", "profit_factor",
                    "max_drawdown_pct", "passed")}} for n in bake["ranking"]],
            }

        tape = ["SPY", "QQQ", "IWM", "DIA"]
        try:
            quotes = data.snapshots(self.dc, sorted(set(tape + (status.get("watchlist") or []))))
        except Exception as exc:  # quotes are decoration; never fail the page over them
            log.warning("snapshots failed: %s", exc)
            quotes = {}

        return {
            "now": datetime.now(ET).isoformat(timespec="seconds"),
            "tape": [{"symbol": s, **quotes[s]} for s in tape if s in quotes],
            "watchlist": [{"symbol": s, **quotes.get(s, {})} for s in status.get("watchlist") or []],
            "engine": {**status, "stale": stale},
            "account": {
                "equity": equity, "cash": float(account.cash), "start_equity": base_eq,
                "day_pnl": round(equity - last_equity, 2),
                "day_pct": round((equity / last_equity - 1) * 100, 2) if last_equity else 0,
                "since_start_pct": round((equity / base_eq - 1) * 100, 2),
                "spy_since_start_pct": curve[-1].get("spy_pct"),
                "start_date": acct_cfg["start_date"],
            },
            "curve": curve,
            "today_curve": today_curve,
            "positions": [{
                "symbol": p.symbol, "side": "long" if float(p.qty) > 0 else "short", "qty": abs(float(p.qty)),
                "entry": float(p.avg_entry_price), "price": float(p.current_price or 0),
                "pnl": float(p.unrealized_pl or 0),
            } for p in positions],
            "today_trades": today_trips,
            "trades": trips[:500],
            "totals": summarize(trips),
            "today_totals": summarize(today_trips),
            "bakeoff": bake_view,
            "events": self._events(),
        }


def serve(cfg: dict, host: str = "127.0.0.1", port: int = 4326) -> None:
    state = State(cfg)
    page = (ROOT / "web" / "index.html").read_bytes()

    class Handler(BaseHTTPRequestHandler):
        def _send(self, code: int, body: bytes, ctype: str) -> None:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            url = urlparse(self.path)
            if url.path == "/api/bars":
                symbol = (parse_qs(url.query).get("symbol") or [""])[0]
                if not symbol.isalnum() or len(symbol) > 6:
                    return self._send(400, b'{"error":"bad symbol"}', "application/json")
                try:
                    return self._send(200, json.dumps(state.bars(symbol)).encode(), "application/json")
                except Exception as exc:
                    log.warning("bars %s failed: %s", symbol, exc)
                    return self._send(503, json.dumps({"error": str(exc)[:200]}).encode(), "application/json")
            if self.path in ("/", "/index.html"):
                self._send(200, page, "text/html; charset=utf-8")
            elif self.path == "/api/state":
                try:
                    self._send(200, json.dumps(state.get()).encode(), "application/json")
                except Exception as exc:
                    log.exception("state build failed")
                    self._send(503, json.dumps({"error": str(exc)[:300]}).encode(), "application/json")
            elif self.path == "/health":
                self._send(200, b'{"ok":true}', "application/json")
            else:
                self._send(404, b"not found", "text/plain")

        def log_message(self, *args):
            pass

    log.info("site on http://%s:%d", host, port)
    ThreadingHTTPServer((host, port), Handler).serve_forever()
