"""The live day-trading loop. One tick per minute during market hours.

Every tick re-reads the account from Alpaca, so nothing is lost on restart. Exits are broker-side
bracket legs; this loop only opens trades, guards them and flattens at the end of the day.
"""
from __future__ import annotations

import json
import logging
import threading
import time
from datetime import date, datetime, timedelta

from alpaca.trading.stream import TradingStream

from . import broker, data, journal, notify
from .config import ET, alpaca_keys, hhmm, runtime_dir, shadow_variants, universe, variants
from .features import atr14, entry_features, or_volume_avg
from .models import DayContext
from .risk import entry_block, size_position
from .strategies import LABELS, evaluate
from .trades import round_trips
from .watchlist import pick

log = logging.getLogger("bull.engine")
MAX_KEEP = 3  # trade at most this many passing variants at once


def active_variants(cfg: dict) -> tuple[list[dict], str]:
    """Which variants trade today, and a one-line reason the site shows."""
    by_name = {v["name"]: v for v in variants(cfg)}
    enabled = cfg["strategies"]["enabled"]
    if enabled != "bakeoff":
        chosen = [by_name[n] for n in enabled if n in by_name]
        return chosen, "set by hand in config"
    path = runtime_dir() / "bakeoff.json"
    if not path.exists():
        return [], "waiting for the first bake-off"
    res = json.loads(path.read_text(encoding="utf-8"))
    passed = [n for n in res.get("passed", []) if n in by_name][:MAX_KEEP]
    if passed:
        return [by_name[n] for n in passed], "passed the bake-off"
    ranking = [n for n in res.get("ranking", []) if n in by_name]
    if cfg["strategies"].get("paper_trade_best_if_none_pass") and ranking:
        return [by_name[ranking[0]]], "probation: nothing passed, paper-testing the best"
    return [], "nothing passed the bake-off"


def read_events(day: date) -> list[dict]:
    prefix = '{"t": "' + day.isoformat()
    out = []
    try:
        with open(runtime_dir() / "events.jsonl", encoding="utf-8") as f:
            out = [json.loads(line) for line in f if line.startswith(prefix)]
    except (OSError, ValueError):
        pass
    return out


def append_event(kind: str, **fields) -> None:
    row = {"t": datetime.now(ET).isoformat(timespec="seconds"), "kind": kind, **fields}
    with open(runtime_dir() / "events.jsonl", "a", encoding="utf-8") as f:
        f.write(json.dumps(row) + "\n")


class Engine:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.tc = broker.client()
        self.dc = data.client()
        self.day: date | None = None
        self.watch: list[str] = []
        self.prev_close: dict[str, float] = {}
        self.active: list[dict] = []
        self.active_why = ""
        self.last_eval: dict[str, datetime] = {}
        self.flattened = False
        self.loss_pinged = False
        self.failures = 0
        self.status: dict = {}
        self.extra: dict[str, dict] = {}
        self.spy_prev: float | None = None
        self.shadow_vs = shadow_variants(cfg)
        self.shadows: list[dict] = []
        self.journaled = False

    # ---- status the site reads -------------------------------------------------------------
    def write_status(self, state: str, message: str, **extra) -> None:
        self.status = {
            "updated": datetime.now(ET).isoformat(timespec="seconds"),
            "state": state,
            "message": message,
            "watchlist": self.watch,
            "strategies": [{"name": v["name"], "label": LABELS[v["strategy"]], "params": v.get("params", {})}
                           for v in self.active],
            "strategies_why": self.active_why,
            **extra,
        }
        tmp = runtime_dir() / "status.json.tmp"
        tmp.write_text(json.dumps(self.status, indent=2), encoding="utf-8")
        tmp.replace(runtime_dir() / "status.json")

    # ---- day setup -------------------------------------------------------------------------
    def start_day(self, today: date) -> bool:
        """Pick the watchlist once the first minute bar exists. Deterministic, so a restart re-picks the same list."""
        syms = universe()
        daily = data.daily_bars(self.dc, syms, today - timedelta(days=40), today)
        first = data.today_minute_bars(self.dc, syms, today)
        stats = {}
        for s in syms:
            prev = [b for b in daily.get(s, []) if b.t.date() < today]
            opening = first.get(s) or []
            if prev and opening:
                stats[s] = {"prev_close": prev[-1].c, "open": opening[0].o,
                            "prev_dollar_volume": prev[-1].c * prev[-1].v}
        if not stats:
            return False
        self.day = today
        self.watch = pick(stats, self.cfg["watchlist"])
        self.prev_close = {s: stats[s]["prev_close"] for s in self.watch}
        spy_prev = [b for b in daily.get("SPY", []) if b.t.date() < today]
        self.spy_prev = spy_prev[-1].c if spy_prev else None
        try:  # facts from before today for the filters and the journal; a missing one just disables a filter
            vols = data.opening_volumes_multi(self.dc, self.watch, today - timedelta(days=30), today - timedelta(days=1))
        except Exception as exc:
            log.warning("opening volumes unavailable: %s", exc)
            vols = {}
        self.extra = {s: {"atr": atr14(daily.get(s, []), today), "or_vol_avg": or_volume_avg(vols.get(s, {}), today)}
                      for s in self.watch}
        self.active, self.active_why = active_variants(self.cfg)
        self.shadows = journal.load_shadows(today)
        self.journaled = today.isoformat() in journal.journaled_days()
        self.last_eval.clear()
        self.flattened = False
        self.loss_pinged = False
        append_event("day_start", watchlist=self.watch, strategies=[v["name"] for v in self.active],
                     why=self.active_why)
        log.info("day %s: %d symbols, strategies %s (%s)", today, len(self.watch),
                 [v["name"] for v in self.active], self.active_why)
        return True

    # ---- one minute ------------------------------------------------------------------------
    def tick(self) -> float:
        """Run one cycle; return seconds to sleep."""
        clock = self.tc.get_clock()
        now = datetime.now(ET)
        if not clock.is_open:
            if self.day and not self.journaled:  # engine missed the 15:52 window; journal the day now
                self.close_journal(self.day, self.tc.get_account())
            self.day = None
            nxt = clock.next_open.astimezone(ET)
            self.write_status("closed", f"Market closed. Next open {nxt:%a %b %d %H:%M} ET.")
            return min(max((nxt - now).total_seconds() - 120, 30), 1800)

        today = now.date()
        risk = self.cfg["risk"]
        if self.day != today:
            if now.time() < hhmm("09:31") or not self.start_day(today):
                self.write_status("waiting", "Waiting for the first minute of trading.")
                return 20

        account = self.tc.get_account()
        positions = self.tc.get_all_positions()

        if now.time() >= hhmm(risk["flatten_at"]):
            if positions and not self.flattened:
                broker.flatten(self.tc)
                append_event("flatten", symbols=[p.symbol for p in positions])
            self.flattened = True
            if not self.journaled and now.time() >= hhmm("15:52"):
                self.close_journal(today, account)
            left = self.tc.get_all_positions()
            if left and now.time() >= hhmm("15:57"):
                notify.ping("flatten", "positions still open near the close",
                            ", ".join(p.symbol for p in left), "urgent", every_s=600)
                broker.flatten(self.tc)
            self.write_status("done", "Flat for the day.", **self._numbers(account, positions))
            return 60

        for sym in broker.unprotected(self.tc, positions, today):
            broker.close_symbol(self.tc, sym, today)
            append_event("protect", symbol=sym, action="closed: no stop order behind it")
            notify.ping(f"unprotected-{sym}", "closed a position with no stop",
                        f"{sym} had no live stop order, so it was closed at market.")

        state = broker.day_state(self.tc, today, account, positions)
        if state.day_pnl_pct <= -risk["daily_loss_limit_pct"] and not self.loss_pinged:
            self.loss_pinged = True
            append_event("halt", day_pnl_pct=round(state.day_pnl_pct, 2))
            notify.ping(f"loss-{today}", "daily loss limit hit",
                        f"Down {state.day_pnl_pct:.2f}% today. No new trades until tomorrow; open trades keep their stops.",
                        "default", every_s=86_400)

        held = {p.symbol for p in positions}
        if (self.active or self.shadow_vs) and self.watch:
            bars = data.today_minute_bars(self.dc, sorted(set(self.watch) | {"SPY"}), today)
            spy = bars.get("SPY") or []
            spy_chg = (spy[-1].c / self.spy_prev - 1) * 100 if spy and self.spy_prev else None
            for sym in self.watch:
                done = [b for b in bars.get(sym, []) if b.t + timedelta(minutes=1) <= now]
                if len(done) < 2 or now - done[-1].t > timedelta(minutes=3):
                    continue  # no fresh completed bar: never act on stale data
                if self.last_eval.get(sym) == done[-1].t:
                    continue
                self.last_eval[sym] = done[-1].t
                ctx = DayContext(sym, self.prev_close.get(sym), done, extra=self.extra.get(sym, {}))
                k = len(done) - 1
                self.record_shadows(ctx, k, spy_chg)
                for v in self.active:
                    sig = evaluate(v, ctx, k)
                    if not sig:
                        continue
                    sig.features = entry_features(ctx, k, sig.stop, spy_chg)
                    block = entry_block(state, now, sig.variant, sym, risk)
                    if not block and sym in held:
                        block = "already holding this symbol"
                    qty = 0 if block else size_position(float(account.equity), float(account.buying_power),
                                                         sig.ref, sig.stop, risk)
                    if not block and qty < 1:
                        block = "position size rounds to zero"
                    if block:
                        append_event("skip", variant=sig.variant, symbol=sym, side=sig.side, reason=block)
                        continue
                    try:
                        broker.submit_bracket(self.tc, sig, qty)
                    except Exception as exc:
                        append_event("rejected", variant=sig.variant, symbol=sym, side=sig.side, error=str(exc)[:300])
                        log.warning("order rejected %s %s: %s", sig.variant, sym, exc)
                        continue
                    held.add(sym)
                    state.open_positions += 1
                    state.trades_today += 1
                    state.taken.add((sig.variant, sym))
                    append_event("entry", variant=sig.variant, symbol=sym, side=sig.side, qty=qty,
                                 ref=sig.ref, stop=sig.stop, target=sig.target, why=sig.why, features=sig.features)
                    log.info("ENTRY %s %s %s x%d stop %.2f target %.2f", sig.variant, sig.side, sym, qty,
                             sig.stop, sig.target)

        halted = state.day_pnl_pct <= -risk["daily_loss_limit_pct"]
        if not self.active:
            st, msg = "idle", f"Not trading: {self.active_why}."
        elif halted:
            st, msg = "halted", "Daily loss limit hit — no new trades today."
        else:
            st, msg = "trading", f"Watching {len(self.watch)} stocks."
        self.write_status(st, msg, trades_today=state.trades_today, **self._numbers(account, positions))
        return max(5.0, 65 - datetime.now(ET).second)  # just after the next minute bar closes

    # ---- shadow tracking + journal -----------------------------------------------------------
    def record_shadows(self, ctx: DayContext, k: int, spy_chg: float | None) -> None:
        """Note what each pre-registered filter variant WOULD do. Never trades; resolved at the close."""
        seen = {(s["variant"], s["symbol"]) for s in self.shadows}
        added = False
        for v in self.shadow_vs:
            if (v["name"], ctx.symbol) in seen:
                continue
            sig = evaluate(v, ctx, k)
            if sig:
                self.shadows.append({"variant": sig.variant, "symbol": sig.symbol, "side": sig.side,
                                     "t": sig.t.isoformat(), "ref": sig.ref, "stop": sig.stop, "target": sig.target,
                                     "why": sig.why, "features": entry_features(ctx, k, sig.stop, spy_chg)})
                added = True
        if added:
            journal.save_shadows(ctx.bars[0].t.date(), self.shadows)

    def close_journal(self, today: date, account) -> None:
        try:
            vmap = {v["name"]: v["strategy"] for v in variants(self.cfg) + self.shadow_vs}
            trips = [t for t in round_trips(broker.todays_orders(self.tc, today), vmap)
                     if t["t_entry"].startswith(today.isoformat())]
            entries = [e for e in read_events(today) if e.get("kind") == "entry"]
            syms = sorted({t["symbol"] for t in trips} | {s["symbol"] for s in self.shadows} | {"SPY"})
            bars = data.today_minute_bars(self.dc, syms, today)
            spy = bars.get("SPY") or []
            spy_day = (spy[-1].c / self.spy_prev - 1) * 100 if spy and self.spy_prev else None
            n = journal.close_day(today, trips, entries, self.shadows, bars, spy_day,
                                  float(account.last_equity or account.equity), self.cfg)
            journal.prune_events()
            append_event("journal", rows=n, real=len(trips), shadow=len(self.shadows))
            log.info("journaled %d rows for %s", n, today)
        except Exception:
            log.exception("journal close failed; will retry next tick")
            return
        self.journaled = True

    @staticmethod
    def _numbers(account, positions) -> dict:
        return {"equity": float(account.equity), "last_equity": float(account.last_equity or 0),
                "open_positions": len(positions)}

    # ---- forever ---------------------------------------------------------------------------
    def run(self) -> None:
        threading.Thread(target=self._stream_forever, daemon=True).start()
        log.info("engine up (paper)")
        while True:
            try:
                wait = self.tick()
                self.failures = 0
            except Exception as exc:
                self.failures += 1
                log.exception("tick failed (%d in a row)", self.failures)
                if self.failures == 5:
                    notify.ping("tick-failing", "engine keeps failing", f"5 failed cycles in a row: {exc}"[:400])
                wait = 30
            time.sleep(wait)

    def _stream_forever(self) -> None:
        """Fill events for the activity feed. Nice to have: if it dies, trading is unaffected."""
        key, secret = alpaca_keys()
        while True:
            try:
                stream = TradingStream(key, secret, paper=True)

                async def on_update(update):
                    order = update.order
                    event = getattr(update.event, "value", str(update.event))
                    if event == "fill" or (event in ("rejected", "canceled", "expired")
                                           and str(order.client_order_id or "").startswith(broker.PREFIX)):
                        append_event(f"order_{event}", symbol=order.symbol,
                                     side=getattr(order.side, "value", str(order.side)),
                                     qty=str(order.filled_qty), price=str(order.filled_avg_price),
                                     type=getattr(order.type, "value", str(order.type)),
                                     coid=order.client_order_id)

                stream.subscribe_trade_updates(on_update)
                stream.run()
            except Exception as exc:
                log.warning("trade stream dropped: %s", exc)
            time.sleep(30)
