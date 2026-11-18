import os
import tempfile
import unittest
from datetime import datetime, timedelta
from types import SimpleNamespace as NS
from unittest.mock import Mock, patch

from bull import broker, journal
from bull.config import ET, load_config
from bull.engine import Engine
from bull.trades import round_trips


class CloseoutTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        env = patch.dict(os.environ, {"BULL_RUNTIME": tmp.name})
        env.start()
        self.addCleanup(env.stop)
        self.now = datetime.now(ET).replace(hour=15, minute=50, second=0, microsecond=0)
        self.day = self.now.date()
        self.market_close = self.now + timedelta(minutes=10)
        self.tc = Mock()
        self.tc.get_account.return_value = NS(equity="5000", last_equity="5000")
        self.tc.get_all_positions.return_value = []
        self.tc.get_orders.return_value = []

    def engine(self):
        with patch("bull.engine.broker.client", return_value=self.tc), patch("bull.engine.data.client"):
            return Engine(load_config())

    def order(self, oid, qty, price, side, *, status="filled", kind="market", coid="broker", legs=None):
        return NS(id=oid, symbol="XYZ", status=status, type=kind, side=side, client_order_id=coid,
                  filled_qty=str(qty), filled_avg_price=str(price), filled_at=self.now, legs=legs,
                  stop_price="98" if kind == "stop" else None, limit_price="104" if kind == "limit" else None)

    def test_waits_for_cancel_then_orders_only_the_remaining_position(self):
        pos = NS(symbol="XYZ", side="long")
        stop = self.order("stop", 0, 0, "sell", status="new", kind="stop")
        working = self.order("close", 3, 103, "sell", status="partially_filled")
        self.tc.get_all_positions.return_value = [pos]
        self.tc.get_orders.return_value = [stop]
        self.assertEqual(broker.flatten(self.tc)[2][0]["action"], "cancel")
        self.tc.cancel_order_by_id.assert_called_once_with("stop")
        stop.status = "pending_cancel"
        self.assertEqual(broker.flatten(self.tc)[2], [])
        self.tc.close_position.assert_not_called()

        self.tc.get_orders.return_value = []
        self.tc.close_position.return_value = working
        self.assertEqual(broker.flatten(self.tc)[2][0]["status"], "partially_filled")
        self.tc.get_orders.return_value = [working]
        self.assertEqual(broker.flatten(self.tc)[2], [])
        self.tc.close_position.assert_called_once_with("XYZ")
        self.tc.cancel_order_by_id.assert_called_once()

    def test_partial_exit_waits_for_residual_and_counts_each_fill_once(self):
        target = self.order("target", 4, 104, "sell", status="canceled", kind="limit")
        entry = self.order("entry", 10, 100, "buy", status="canceled",
                           coid=f"v3-gap_early-XYZ-{self.day:%Y%m%d}-0935", legs=[target])
        close = self.order("close", 6, 102, "sell")
        close.filled_at += timedelta(seconds=5)
        incomplete, = round_trips([entry, target], {})
        self.assertIsNone(incomplete["exit"])
        trip, = round_trips([entry, target, close], {})
        self.assertEqual((trip["exit"], trip["pnl"], trip["reason"]), (102.8, 28.0, "close"))

    def test_engine_retries_then_recovers_journal_after_restart(self):
        entry = self.order("entry", 2, 100, "buy", coid=f"v3-gap_early-XYZ-{self.day:%Y%m%d}-0935")
        close = self.order("close", 2, 101, "sell")
        self.tc.get_all_positions.return_value = [NS(symbol="XYZ", side="long")]
        self.tc.close_position.return_value = close
        engine = self.engine()
        with patch("bull.engine.notify.ping") as ping:
            self.assertEqual(engine.close_tick(self.now + timedelta(minutes=2), self.now, self.market_close), 5)
        ping.assert_called_once()
        self.assertEqual(journal.journaled_days(), set())
        self.assertEqual(journal.pending_days(), [self.day])

        self.tc.get_all_positions.return_value = []
        self.tc.get_orders.side_effect = lambda req: [] if req.status.value == "open" else [entry]
        with patch("bull.engine.data.today_minute_bars", return_value={}):
            self.assertEqual(engine.close_tick(self.now + timedelta(minutes=3), self.now, self.market_close), 15)
        self.assertEqual(journal.journaled_days(), set())

        self.tc.get_clock.return_value = NS(is_open=False, next_open=self.now + timedelta(days=1))
        self.tc.get_orders.side_effect = lambda req: [] if req.status.value == "open" else [entry, close]
        with patch("bull.engine.data.today_minute_bars", return_value={}), patch("bull.engine.datetime", wraps=datetime) as dt:
            dt.now.return_value = self.market_close
            self.engine().tick()
        self.assertEqual(journal.journaled_days(), {self.day.isoformat()})
        self.assertEqual(journal.pending_days(), [])
        self.assertEqual(len([r for r in journal._read_rows() if r["kind"] == "real"]), 1)

    def test_early_market_close_flattens_even_without_morning_start(self):
        early = self.market_close.replace(hour=13)
        self.tc.get_clock.return_value = NS(is_open=True, next_close=early)
        engine = self.engine()
        with patch("bull.engine.datetime", wraps=datetime) as dt:
            dt.now.return_value = early - timedelta(minutes=10)
            engine.tick()
        self.assertEqual(journal.pending_day(self.day)["flatten_at"], "12:50")
        self.assertEqual(engine.status["state"], "done")
