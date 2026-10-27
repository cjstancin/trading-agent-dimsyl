import os
import random
import unittest
from datetime import date, datetime, timedelta
from types import SimpleNamespace as NS

from bull import broker
from bull.backtest import metrics, passes, run_portfolio, simulate_exit
from bull.config import ET, assert_paper, load_config, shadow_variants, variants
from bull.models import Bar, DayContext, Signal
from bull.risk import DayState, entry_block, sell_fees, size_position
from bull.strategies import evaluate
from bull.trades import round_trips
from bull.watchlist import pick

DAY = date(2026, 10, 20)
CFG = load_config()


def t(hh, mm):
    return datetime(DAY.year, DAY.month, DAY.day, hh, mm, tzinfo=ET)


def bars_from(prices, start=(9, 30), spread=0.05, vol=1000):
    out, prev = [], prices[0]
    for i, c in enumerate(prices):
        ts = t(*start) + timedelta(minutes=i)
        o = prev
        out.append(Bar(ts, o, max(o, c) + spread, min(o, c) - spread, c, vol))
        prev = c
    return out


def random_day(seed, n=390, start=100.0):
    rnd = random.Random(seed)
    p, prices = start, []
    for _ in range(n):
        p *= 1 + rnd.gauss(0.0002, 0.0015)
        prices.append(round(p, 2))
    return bars_from(prices)


class StrategyTests(unittest.TestCase):
    def test_no_lookahead(self):
        """A strategy must give the same answer at bar k whether it sees the whole day or only bars 0..k."""
        for seed in range(6):
            full = random_day(seed)
            prev_close = full[0].o / (1.04 if seed % 2 else 0.96)
            extra = {"atr": 2.5, "or_vol_avg": 3000.0}
            ctx_full = DayContext("TEST", prev_close, full, extra=extra)
            for v in variants(CFG) + shadow_variants(CFG):
                for k in range(1, len(full), 7):
                    ctx_cut = DayContext("TEST", prev_close, full[:k + 1], extra=extra)
                    a, b = evaluate(v, ctx_full, k), evaluate(v, ctx_cut, k)
                    self.assertEqual(a, b, f"{v['name']} seed {seed} k {k}")

    def test_orb_breakout(self):
        prices = [100 + (0.1 if i % 2 else -0.1) for i in range(15)] + [100.05, 100.2, 100.6]
        ctx = DayContext("X", 99.0, bars_from(prices))
        v = {"name": "orb", "strategy": "orb", "params": {"side": "long", "or_minutes": 15, "target_r": 2.0}}
        hits = [evaluate(v, ctx, k) for k in range(len(prices))]
        sig = next(s for s in hits if s)
        self.assertEqual(sig.side, "long")
        self.assertLess(sig.stop, sig.ref)
        self.assertAlmostEqual(sig.target - sig.ref, 2 * (sig.ref - sig.stop), delta=0.02)

    def test_vwap_pullback_long(self):
        up = [100 + i * 0.05 for i in range(40)]
        dip = [up[-1] - 0.3, up[-1] - 0.6, up[-1] - 0.8, up[-1] - 0.7, up[-1] - 0.5]
        resume = [up[-1] + 0.2]
        ctx = DayContext("X", 99.0, bars_from(up + dip + resume, spread=0.02))
        v = {"name": "vw", "strategy": "vwap_pullback", "params": {"side": "long", "target_r": 2.0, "touch_pct": 0.5}}
        k = len(ctx.bars) - 1
        sig = evaluate(v, ctx, k)
        if sig is None:  # make the dip actually touch VWAP for this synthetic path
            vw = ctx.vw[k - 3]
            dip = [vw + 0.02, vw - 0.01, vw + 0.05, vw + 0.1, vw + 0.15]
            ctx = DayContext("X", 99.0, bars_from(up + dip + [max(dip) + 0.4], spread=0.02))
            sig = evaluate(v, ctx, len(ctx.bars) - 1)
        self.assertIsNotNone(sig)
        self.assertEqual(sig.side, "long")

    def test_gap_and_go(self):
        prices = [104.0, 104.2, 104.1, 104.3, 104.2, 104.25, 104.9]
        ctx = DayContext("X", 100.0, bars_from(prices, spread=0.02))
        v = {"name": "gap", "strategy": "gap_and_go", "params": {"side": "long", "min_gap_pct": 3.0}}
        self.assertIsNotNone(evaluate(v, ctx, 6))
        ctx_small = DayContext("X", 103.0, bars_from(prices, spread=0.02))
        self.assertIsNone(evaluate(v, ctx_small, 6))


class FilterTests(unittest.TestCase):
    def gap_day(self, open_vol=1000):
        prices = [104.0, 104.2, 104.1, 104.3, 104.2, 104.25, 104.9]
        bars = bars_from(prices, spread=0.02, vol=open_vol)
        return DayContext("X", 100.0, bars, extra={"atr": 2.0, "or_vol_avg": 2000.0})

    def v(self, **params):
        return {"name": "g", "strategy": "gap_and_go", "params": {"side": "long", "min_gap_pct": 3.0, **params}}

    def test_rvol_filter(self):
        self.assertIsNone(evaluate(self.v(min_rvol=2.0), self.gap_day(open_vol=500), 6))   # 2500/2000 = 1.25x
        self.assertIsNotNone(evaluate(self.v(min_rvol=2.0), self.gap_day(open_vol=1000), 6))  # 5000/2000 = 2.5x
        no_hist = DayContext("X", 100.0, self.gap_day().bars)
        self.assertIsNone(evaluate(self.v(min_rvol=2.0), no_hist, 6), "no history means no rvol, so no trade")

    def test_gap_and_time_filters(self):
        self.assertIsNone(evaluate(self.v(min_gap_pct=5.0), self.gap_day(), 6))          # +4% gap
        self.assertIsNone(evaluate(self.v(last_entry="09:36"), self.gap_day(), 6))        # fires at 09:36
        self.assertIsNotNone(evaluate(self.v(last_entry="09:40"), self.gap_day(), 6))

    def test_atr_stop(self):
        ctx = self.gap_day()
        lo = min(b.l for b in ctx.bars[:5])
        wide = evaluate(self.v(stop_atr=0.5, max_stop_pct=5.0), ctx, 6)        # ATR 2.0 -> cap 1.0
        self.assertEqual(wide.stop, round(lo, 2), "range low is closer than half an ATR")
        ctx.extra["atr"] = 0.6                                                  # cap 0.3
        tight = evaluate(self.v(stop_atr=0.5, max_stop_pct=5.0), ctx, 6)
        self.assertEqual(tight.stop, round(104.9 - 0.3, 2), "half an ATR is closer than the range low")
        ctx.extra["atr"] = None
        self.assertIsNone(evaluate(self.v(stop_atr=0.5), ctx, 6), "no ATR history, no ATR-stop trade")

    def test_features(self):
        from bull.features import atr14, entry_features, or_volume_avg
        daily = [Bar(t(0, 0) - timedelta(days=20 - i), 100, 102, 99, 101, 1) for i in range(20)]
        self.assertAlmostEqual(atr14(daily, DAY), 3.0)
        self.assertIsNone(atr14(daily[:10], DAY))
        vols = {DAY - timedelta(days=i): 100.0 * i for i in range(1, 20)}
        self.assertAlmostEqual(or_volume_avg(vols, DAY), sum(100.0 * i for i in range(1, 15)) / 14)
        f = entry_features(self.gap_day(), 6, 103.0, -0.4)
        self.assertEqual((f["gap_pct"], f["rvol"], f["minute"], f["spy_chg"]), (4.0, 2.5, 6, -0.4))


class BacktestTests(unittest.TestCase):
    def sig(self, side="long", stop=99.0, target=102.0):
        return Signal("v", "X", side, t(10, 0), 100.0, stop, target, "test")

    def test_stop_wins_when_both_touched(self):
        bars = [Bar(t(10, 0), 100, 100, 100, 100, 1), Bar(t(10, 1), 100, 103, 98, 100, 1)]
        ex = simulate_exit(bars, 0, self.sig(), 0, "15:50")
        self.assertEqual(ex.reason, "stop")
        self.assertEqual(ex.exit, 99.0)

    def test_gap_through_stop_fills_at_open(self):
        bars = [Bar(t(10, 0), 100, 100, 100, 100, 1), Bar(t(10, 1), 100, 100.5, 99.8, 100, 1),
                Bar(t(10, 2), 97, 97.5, 96.5, 97, 1)]
        ex = simulate_exit(bars, 0, self.sig(), 0, "15:50")
        self.assertEqual((ex.reason, ex.exit), ("stop", 97))

    def test_flatten_at_close(self):
        bars = [Bar(t(15, 48), 100, 100, 100, 100, 1), Bar(t(15, 49), 100, 100.5, 99.8, 100.2, 1),
                Bar(t(15, 50), 100.3, 100.4, 100.2, 100.3, 1)]
        ex = simulate_exit(bars, 0, self.sig(), 0, "15:50")
        self.assertEqual((ex.reason, ex.exit), ("close", 100.3))

    def test_short_target(self):
        bars = [Bar(t(10, 0), 100, 100, 100, 100, 1), Bar(t(10, 1), 100, 100.2, 97.5, 98, 1)]
        ex = simulate_exit(bars, 0, self.sig("short", stop=101.0, target=98.0), 0, "15:50")
        self.assertEqual((ex.reason, ex.exit), ("target", 98.0))

    def test_portfolio_caps_positions(self):
        from bull.backtest import Exit
        cands = {DAY: []}
        for i in range(5):
            s = Signal("v", f"S{i}", "long", t(10, i), 100.0, 99.0, 102.0, "")
            cands[DAY].append((s, Exit(t(10, i + 1), t(11, 0), 100.0, 102.0, "target")))
        trades = run_portfolio(cands, CFG)
        self.assertEqual(len(trades), CFG["risk"]["max_positions"])
        m = metrics(trades, 5000, [DAY])
        self.assertEqual(m["trades"], 3)
        self.assertFalse(passes(m, CFG["bakeoff"]))  # too few trades to trust


class PassRuleTests(unittest.TestCase):
    def trades(self, per_year):
        from bull.backtest import Trade
        out = []
        for year, pnls in per_year.items():
            for i, p in enumerate(pnls):
                out.append(Trade("v", "X", "long", f"{year}-06-{(i % 28) + 1:02d}", "", "", 100, 101, 10, "target",
                                 0, p, p / 50, ""))
        return out

    def test_t_stat_and_years(self):
        from bull.backtest import metrics, passes
        rule = CFG["bakeoff"]
        strong = self.trades({"2023": [60, -50, 70] * 15, "2024": [60, -50, 70] * 15, "2025": [-50, 55, -50] * 5})
        m = metrics(strong, 5000, [DAY])
        self.assertEqual((m["positive_years"], m["counted_years"]), (2, 3))
        self.assertGreaterEqual(m["t_stat"], 2.0)
        self.assertTrue(passes(m, rule))
        coinflip = self.trades({"2023": [50, -50] * 40, "2024": [52, -50] * 40})
        m2 = metrics(coinflip, 5000, [DAY])
        self.assertLess(m2["t_stat"], 2.0)
        self.assertFalse(passes(m2, rule), "a tiny positive edge with t < 2 is not proven")
        one_good_year = self.trades({"2023": [90, -50] * 40, "2024": [-50, 40] * 20, "2025": [-50, 40] * 20})
        m3 = metrics(one_good_year, 5000, [DAY])
        self.assertEqual(m3["positive_years"], 1)
        self.assertFalse(passes(m3, rule), "profitable in only 1 of 3 years fails")

    def test_candidate_pool_dedupes_control(self):
        from bull.bakeoff import candidates
        names = [v["name"] for v in candidates(CFG)]
        self.assertIn("gap_early", names)
        self.assertNotIn("gap_control", names, "gap_control is the same rule as gap_long_2r")
        self.assertEqual(len(names), len(set(names)))


class LiveChartTests(unittest.TestCase):
    def test_bucket_bars(self):
        from bull.features import bucket_bars
        bars = bars_from([100 + i * 0.1 for i in range(12)])
        five = bucket_bars(bars, 5)
        self.assertEqual([b["t"] for b in five], ["09:30", "09:35", "09:40"])
        self.assertEqual(five[0]["o"], bars[0].o)
        self.assertEqual(five[1]["c"], bars[9].c)
        self.assertEqual(len(bucket_bars(bars, 1)), 12)

    def test_key_levels(self):
        from bull.features import key_levels
        prev = Bar(t(0, 0) - timedelta(days=1), 99, 101.5, 98.2, 100.4, 1)
        pre = bars_from([100.5, 100.9, 100.2], start=(8, 0))
        sess = bars_from([101 + (i % 4) * 0.1 for i in range(20)])
        lv = {x["k"]: x["v"] for x in key_levels(prev, pre, sess)}
        self.assertEqual((lv["PDH"], lv["PDL"], lv["PDC"]), (101.5, 98.2, 100.4))
        self.assertEqual((lv["PMH"], lv["PML"]), (round(max(b.h for b in pre), 2), round(min(b.l for b in pre), 2)))
        self.assertIn("OR15H", lv)
        early = {x["k"] for x in key_levels(prev, [], sess[:8])}
        self.assertIn("OR5H", early)
        self.assertNotIn("OR15H", early, "15-min range isn't drawn until 15 minutes have passed")

    def test_snapshot_premarket_gap(self):
        from bull import data
        today = datetime.now(ET).date()
        yday = (today - timedelta(days=1)).isoformat() + "T04:00:00Z"
        tday = today.isoformat() + "T04:00:00Z"
        class C:
            def __init__(self, raw): self.raw = raw
            def get_stock_snapshot(self, req): return self.raw
        pre = C({"X": {"dailyBar": {"t": yday, "o": 9, "h": 11, "l": 9, "c": 10}, "latestTrade": {"p": 10.5}}})
        q = data.snapshots(pre, ["X"])["X"]
        self.assertTrue(q["premarket"])
        self.assertEqual((q["gap_pct"], q["high"]), (5.0, None))
        live = C({"X": {"dailyBar": {"t": tday, "o": 10.4, "h": 10.9, "l": 10.1, "c": 10.6},
                        "prevDailyBar": {"t": yday, "c": 10.0}, "latestTrade": {"p": 10.8}}})
        q = data.snapshots(live, ["X"])["X"]
        self.assertFalse(q["premarket"])
        self.assertEqual((q["gap_pct"], q["chg_pct"], q["high"]), (4.0, 8.0, 10.9))


class RiskTests(unittest.TestCase):
    def test_sizing(self):
        r = CFG["risk"]
        self.assertEqual(size_position(5000, 20000, 100, 99, r), 50)       # $50 risk / $1
        self.assertEqual(size_position(5000, 20000, 100, 99.9, r), 50)     # capped at 100% of equity
        self.assertEqual(size_position(5000, 1000, 100, 99, r), 9)         # capped by buying power
        self.assertEqual(size_position(5000, 20000, 100, 100, r), 0)

    def test_entry_block(self):
        r = CFG["risk"]
        self.assertIsNone(entry_block(DayState(), t(10, 0), "v", "X", r))
        self.assertEqual(entry_block(DayState(day_pnl_pct=-2.5), t(10, 0), "v", "X", r), "daily loss limit")
        self.assertEqual(entry_block(DayState(), t(15, 31), "v", "X", r), "past last entry time")
        self.assertEqual(entry_block(DayState(open_positions=3), t(10, 0), "v", "X", r), "max positions open")
        self.assertEqual(entry_block(DayState(taken={("v", "X")}), t(10, 0), "v", "X", r),
                         "already traded this setup today")

    def test_fees(self):
        c = CFG["costs"]
        self.assertAlmostEqual(sell_fees(100, 100, c), 100 * 100 * 20.60 / 1e6 + 100 * 0.000195, places=4)
        self.assertLessEqual(sell_fees(10, 1_000_000, c) - 10 * 1_000_000 * 20.60 / 1e6, 9.79 + 1e-9)


class SafetyTests(unittest.TestCase):
    def test_live_config_refused(self):
        with self.assertRaises(SystemExit):
            assert_paper({"account": {"paper": False}})

    def test_live_base_url_refused(self):
        os.environ["ALPACA_BASE_URL"] = "https://api.alpaca.markets"
        try:
            with self.assertRaises(SystemExit):
                assert_paper({"account": {"paper": True}})
        finally:
            del os.environ["ALPACA_BASE_URL"]

    def test_coid_roundtrip(self):
        s = Signal("vwap_long_1.5r", "NVDA", "long", t(10, 5), 1, 0.9, 1.2, "")
        self.assertEqual(broker.parse_coid(broker.coid(s)), ("vwap_long_1.5r", "NVDA"))
        self.assertIsNone(broker.parse_coid("c3f1a2b0-uuid-from-dashboard"))


class WatchlistTests(unittest.TestCase):
    def test_gappers_first_then_liquidity(self):
        wl = {"size": 3, "gappers": 1, "min_gap_pct": 2, "min_price": 5, "min_dollar_volume": 1e6}
        stats = {
            "BIG": {"prev_close": 100, "open": 100.5, "prev_dollar_volume": 9e9},
            "MID": {"prev_close": 100, "open": 100.2, "prev_dollar_volume": 5e9},
            "GAP": {"prev_close": 100, "open": 106, "prev_dollar_volume": 2e6},
            "TINY": {"prev_close": 3, "open": 3.5, "prev_dollar_volume": 9e9},
            "THIN": {"prev_close": 100, "open": 110, "prev_dollar_volume": 10},
        }
        self.assertEqual(pick(stats, wl), ["GAP", "BIG", "MID"])


class TradeDisplayTests(unittest.TestCase):
    def test_round_trip_pairs_legs_and_flatten(self):
        f = lambda h, m: t(h, m)
        stop_leg = NS(status="filled", type="stop", filled_avg_price="99.0", filled_at=f(10, 30), stop_price="99.0", limit_price=None)
        tp_leg = NS(status="canceled", type="limit", filled_avg_price=None, filled_at=None, stop_price=None, limit_price="102.0")
        a = NS(id="1", status="filled", side="buy", symbol="AAA", client_order_id="v3-vwap_long_2r-AAA-20261020-1000",
               filled_qty="10", filled_avg_price="100.0", filled_at=f(10, 1), legs=[tp_leg, stop_leg])
        b = NS(id="2", status="filled", side="sell", symbol="BBB", client_order_id="v3-orb15_long_2r-BBB-20261020-1000",
               filled_qty="5", filled_avg_price="50.0", filled_at=f(10, 2), legs=[])
        flat = NS(id="3", status="filled", side="buy", symbol="BBB", client_order_id="abcd-1234",
                  filled_qty="5", filled_avg_price="49.0", filled_at=f(15, 50), legs=[])
        trips = round_trips([flat, b, a], {"vwap_long_2r": "vwap_pullback", "orb15_long_2r": "orb"})
        by = {x["symbol"]: x for x in trips}
        self.assertEqual((by["AAA"]["reason"], by["AAA"]["pnl"]), ("stop", -10.0))
        self.assertEqual((by["BBB"]["side"], by["BBB"]["reason"], by["BBB"]["pnl"]), ("short", "close", 5.0))
        self.assertEqual(by["AAA"]["strategy"], "VWAP pullback")


if __name__ == "__main__":
    unittest.main()
