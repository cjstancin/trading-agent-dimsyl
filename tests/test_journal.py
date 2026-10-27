import csv
import os
import tempfile
import unittest
from datetime import date, datetime, timedelta

from bull.config import ET, load_config
from bull.models import Bar

DAY = date(2026, 10, 28)
CFG = load_config()


def t(h, m):
    return datetime(DAY.year, DAY.month, DAY.day, h, m, tzinfo=ET)


def path_bars(prices, start=(9, 30)):
    out, prev = [], prices[0]
    for i, c in enumerate(prices):
        out.append(Bar(t(*start) + timedelta(minutes=i), prev, max(prev, c) + 0.05, min(prev, c) - 0.05, c, 1000))
        prev = c
    return out


class JournalTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.environ["BULL_RUNTIME"] = self.tmp.name
        from bull import journal
        self.j = journal

    def tearDown(self):
        del os.environ["BULL_RUNTIME"]
        self.tmp.cleanup()

    def test_excursions(self):
        bars = path_bars([100, 101, 99.5, 102, 100.5])
        mae, mfe = self.j.excursions(bars, t(9, 31), t(9, 34), 100.0, 99.0, "long")
        self.assertEqual((mae, mfe), (-0.55, 2.05))
        mae, mfe = self.j.excursions(bars, t(9, 31), t(9, 34), 100.0, 101.0, "short")
        self.assertEqual((mae, mfe), (-2.05, 0.55))

    def test_loss_types(self):
        base = {"pnl": -50.0, "entry": 100.0, "stop": 98.0, "side": "long", "reason": "stop", "exit": 98.0, "mfe_r": 0.2}
        self.assertEqual(self.j.loss_type(base, 0.1), "setup failed")
        self.assertEqual(self.j.loss_type({**base, "exit": 97.2}, 0.1), "bad fill")
        self.assertEqual(self.j.loss_type({**base, "mfe_r": 1.3}, 0.1), "gave back")
        self.assertEqual(self.j.loss_type(base, -1.4), "market down")
        self.assertEqual(self.j.loss_type({**base, "pnl": 20.0}, -2.0), "")

    def test_close_day_real_and_shadow_once(self):
        bars = path_bars([100] * 6 + [101, 102, 103, 104, 105, 106])
        trips = [{"symbol": "AAA", "side": "long", "qty": 10, "variant": "gap_long_2r", "entry": 101.0, "exit": 105.0,
                  "reason": "target", "pnl": 40.0, "stop": 99.0, "target": 105.0,
                  "t_entry": t(9, 36).isoformat(timespec="minutes"), "t_exit": t(9, 40).isoformat(timespec="minutes")}]
        entries = [{"kind": "entry", "variant": "gap_long_2r", "symbol": "AAA",
                    "features": {"gap_pct": 4.1, "rvol": 2.3, "minute": 6, "stop_pct": 2.0}}]
        shadows = [{"variant": "gap_early", "symbol": "AAA", "side": "long", "t": bars[6].t.isoformat(),
                    "ref": 101.0, "stop": 99.0, "target": 105.0, "why": "x", "features": {"gap_pct": 4.1}}]
        n = self.j.close_day(DAY, trips, entries, shadows, {"AAA": bars}, 0.3, 5000.0, CFG)
        self.assertEqual(n, 2)
        self.assertEqual(self.j.close_day(DAY, trips, entries, shadows, {"AAA": bars}, 0.3, 5000.0, CFG), 0)
        with open(self.j.path(), newline="") as f:
            rows = list(csv.DictReader(f))
        real = next(r for r in rows if r["kind"] == "real")
        self.assertEqual((real["rvol"], real["r"], real["loss_type"]), ("2.3", "2.0", ""))
        shadow = next(r for r in rows if r["kind"] == "shadow")
        self.assertEqual(shadow["reason"], "target")
        s = self.j.summary()
        self.assertEqual(s["real"]["n"], 1)
        self.assertEqual(s["shadow"]["gap_early"]["n"], 1)
        self.assertLess(os.path.getsize(self.j.path()), 1000)

    def test_shadow_persistence(self):
        self.j.save_shadows(DAY, [{"variant": "v"}])
        self.assertEqual(self.j.load_shadows(DAY), [{"variant": "v"}])
        self.assertEqual(self.j.load_shadows(DAY + timedelta(days=1)), [])


if __name__ == "__main__":
    unittest.main()
