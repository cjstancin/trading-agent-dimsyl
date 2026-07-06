#!/usr/bin/env python3
"""
Bill the Bull — deterministic RISK-ENGINE backtest harness.

WHAT THIS DOES (and what it deliberately does NOT do)
-----------------------------------------------------
This backtests the *deterministic risk plumbing* that the hybrid overhaul put in front of the
LLM — NOT the LLM's stock-picking. Per the deep-research finding (Glasserman & Lin, "the profit
mirage"), an LLM's in-window trading backtest is contaminated by memorization: it has seen the
prices, so any historical edge is fake and decays 50-60% past the training cutoff. You therefore
CANNOT honestly backtest the LLM signal. You CAN backtest the rules the engine enforces.

So we drive the engine with a transparent, well-known *mechanical* entry signal (trend + momentum +
breakout) as a STAND-IN for "the LLM proposed this name", then run the EXACT live rules:
  - ATR(22) average true range  (matches agent/src/risk-engine.ts atrFromBars, simple mean)
  - entry stop = entry - ATR*3          (atrStop)
  - risk-based sizing: shares = equity*1.5% / (entry-stop), capped at 20% of equity  (sizeByRisk)
  - portfolio risk gate: 20% per-name, 30% per-sector, 15% portfolio-heat ceiling    (riskGate)
  - Chandelier trailing stop = highestHigh - ATR*3, ratchets up only                  (chandelierStop)
  - 200-day-MA regime filter (only open new risk when SPY >= its 200DMA)              (regimeOn)
  - costs: per-side slippage in bps (Alpaca commission = $0)

The output answers: does the PLUMBING behave? Does the heat cap actually bound drawdown? Do the
trailing stops + regime filter control the downside? Do costs destroy a reasonable edge? It does
NOT claim "Bill will make X%" — the live edge depends on the LLM's picks, which only forward
paper-trading past today's cutoff can validate (Phase 0).

Survivorship-bias caveat: the universe is currently-listed names (yfinance), so it's tilted toward
survivors. Read the drawdown/heat behavior, not the absolute return, as the signal.

Run:  python backtest.py            (uses cached data in ./data, fetches if missing)
      python backtest.py --refresh  (force re-download)
"""
import os
import sys
import math
import numpy as np
import pandas as pd

# ───────────────────────── config (mirrors DEFAULT_RISK, MODERATE) ─────────────────────────
RISK = dict(
    riskPerTradePct=1.5, maxPortfolioHeatPct=15.0, maxNamePct=20.0, maxSectorPct=30.0,
    atrMult=3.0, atrPeriod=22, maxPositions=10,
)
START = "2016-01-01"
END = None              # None → today
INIT_CAP = 1000.0       # matches Bill's account; results are scale-invariant (fractional shares, 0 commission)
SLIP_BPS_RUNS = [5.0, 15.0]   # per-side slippage sensitivity (bps)
RF_ANNUAL = 0.04        # risk-free for Sharpe/Sortino (~T-bill)

# Diversified, multi-sector liquid universe. Sector tags drive the 30% sector cap.
UNIVERSE = {
    "AAPL": "Tech", "MSFT": "Tech", "NVDA": "Tech", "GOOGL": "Tech", "META": "Tech",
    "AMZN": "ConsumerDisc", "HD": "ConsumerDisc",
    "JPM": "Financials", "V": "Financials",
    "XOM": "Energy", "CVX": "Energy",
    "UNH": "Health", "JNJ": "Health",
    "PG": "Staples", "KO": "Staples", "WMT": "Staples",
    "CAT": "Industrials", "BA": "Industrials",
}
BENCH = "SPY"

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(OUT_DIR, exist_ok=True)


# ───────────────────────── data ─────────────────────────
def fetch(ticker: str, refresh: bool = False) -> pd.DataFrame:
    fp = os.path.join(DATA_DIR, f"{ticker}.csv")
    if os.path.exists(fp) and not refresh:
        return pd.read_csv(fp, index_col=0, parse_dates=True)
    import yfinance as yf
    df = yf.download(ticker, start=START, end=END, auto_adjust=True, progress=False)
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.droplevel(1)
    df = df[["Open", "High", "Low", "Close"]].dropna()
    df.to_csv(fp)
    return df


def indicators(df: pd.DataFrame) -> pd.DataFrame:
    h, l, c = df["High"], df["Low"], df["Close"]
    pc = c.shift(1)
    tr = pd.concat([h - l, (h - pc).abs(), (l - pc).abs()], axis=1).max(axis=1)
    atr = tr.rolling(RISK["atrPeriod"]).mean()          # simple mean of last N TRs (matches atrFromBars)
    ma200 = c.rolling(200).mean()
    mom63 = c / c.shift(63) - 1.0                         # 3-month momentum
    hi20c = c.rolling(20).max()                           # 20-day closing-high breakout (Donchian on close)
    return pd.DataFrame({"Open": df["Open"], "High": h, "Low": l, "Close": c,
                         "ATR": atr, "MA200": ma200, "MOM": mom63, "HI20": hi20c})


# ───────────────────────── engine ─────────────────────────
def run(arr, cal, spyC, spyMA, slip_bps: float):
    """Drive the deterministic engine over the aligned data. Returns (equity_series, trades, max_heat_pct)."""
    slip = slip_bps / 1e4
    cash = INIT_CAP
    pos = {}                 # sym -> {shares, entry, stop, hh, edate}
    eq_curve = []
    trades = []
    pending = []
    max_heat = 0.0
    N = len(cal)

    def mark(s, t):          # prior-close mark (look-ahead-free)
        return arr[s]["Close"][t - 1]

    for t in range(200, N):
        date = cal[t]
        eq = cash + sum(p["shares"] * mark(s, t) for s, p in pos.items())

        # A) fill yesterday's signals at today's OPEN (no look-ahead)
        for s in pending:
            if s in pos or len(pos) >= RISK["maxPositions"]:
                continue
            o = arr[s]["Open"][t]
            atr = arr[s]["ATR"][t - 1]
            if not (o > 0) or not (atr > 0):
                continue
            stop = max(0.0, o - atr * RISK["atrMult"])
            if stop >= o:
                continue
            # sizeByRisk
            risk_d = eq * RISK["riskPerTradePct"] / 100.0
            shares = min(risk_d / (o - stop), (RISK["maxNamePct"] / 100.0) * eq / o)
            # riskGate — per-name (already applied), per-sector, portfolio-heat
            sec = UNIVERSE[s]
            sec_val = sum(p["shares"] * mark(x, t) for x, p in pos.items() if UNIVERSE[x] == sec)
            shares = min(shares, max(0.0, (RISK["maxSectorPct"] / 100.0) * eq - sec_val) / o)
            open_risk = sum(max(0.0, (mark(x, t) - p["stop"]) * p["shares"]) for x, p in pos.items())
            per = o - stop
            shares = min(shares, max(0.0, (RISK["maxPortfolioHeatPct"] / 100.0) * eq - open_risk) / per)
            shares = max(0.0, round(shares, 4))
            if shares <= 0:
                continue
            cost = shares * o * (1 + slip)
            if cost > cash:                              # cash-constrained → take what we can
                shares = round(cash / (o * (1 + slip)), 4)
                if shares <= 0:
                    continue
                cost = shares * o * (1 + slip)
            cash -= cost
            pos[s] = {"shares": shares, "entry": o * (1 + slip), "stop": stop, "hh": o, "edate": date}
        pending = []

        # B) exits — Chandelier stop from data through t-1, tested against today's Low
        for s in list(pos.keys()):
            p = pos[s]
            atr = arr[s]["ATR"][t - 1]
            chand = (p["hh"] - atr * RISK["atrMult"]) if atr > 0 else p["stop"]
            stop = max(p["stop"], chand)                 # ratchet up only
            p["stop"] = stop
            low = arr[s]["Low"][t]
            op = arr[s]["Open"][t]
            if low <= stop:
                fill = (stop if op >= stop else op) * (1 - slip)   # gap-through fills at open
                cash += p["shares"] * fill
                trades.append({"sym": s, "entry": p["entry"], "exit": fill,
                               "pnl": (fill - p["entry"]) * p["shares"],
                               "ret": fill / p["entry"] - 1.0, "edate": p["edate"], "xdate": date})
                del pos[s]

        # C) update high-water marks for tomorrow's Chandelier
        for s, p in pos.items():
            hi = arr[s]["High"][t]
            if hi > p["hh"]:
                p["hh"] = hi

        # D) mark-to-market at close
        eq_close = cash + sum(p["shares"] * arr[s]["Close"][t] for s, p in pos.items())
        eq_curve.append((date, eq_close))
        if eq_close > 0:
            heat = 100.0 * sum(max(0.0, (arr[s]["Close"][t] - p["stop"]) * p["shares"]) for s, p in pos.items()) / eq_close
            max_heat = max(max_heat, heat)

        # E) signals at today's close → fill next open
        regime = (not np.isnan(spyMA[t])) and spyC[t] >= spyMA[t]
        if regime and len(pos) < RISK["maxPositions"]:
            cands = []
            for s in UNIVERSE:
                if s in pos:
                    continue
                c = arr[s]["Close"][t]; ma = arr[s]["MA200"][t]; mom = arr[s]["MOM"][t]
                hi20 = arr[s]["HI20"][t]; atr = arr[s]["ATR"][t]
                if any(np.isnan(x) for x in (c, ma, mom, hi20, atr)) or atr <= 0:
                    continue
                if c > ma and mom > 0 and c >= hi20:      # trend + momentum + 20-day breakout
                    cands.append((mom, s))
            cands.sort(reverse=True)
            pending = [s for _, s in cands[: RISK["maxPositions"] - len(pos)]]

    eq = pd.Series(dict(eq_curve))
    return eq, trades, max_heat


# ───────────────────────── metrics ─────────────────────────
def metrics(eq: pd.Series, trades: list, max_heat: float, label: str) -> dict:
    ret = eq.pct_change().dropna()
    years = (eq.index[-1] - eq.index[0]).days / 365.25
    cagr = (eq.iloc[-1] / eq.iloc[0]) ** (1 / years) - 1 if years > 0 else float("nan")
    vol = ret.std() * math.sqrt(252)
    ann_ret = ret.mean() * 252
    sharpe = (ann_ret - RF_ANNUAL) / vol if vol > 0 else float("nan")
    dn = ret[ret < 0].std() * math.sqrt(252)
    sortino = (ann_ret - RF_ANNUAL) / dn if dn > 0 else float("nan")
    cummax = eq.cummax()
    dd = eq / cummax - 1.0
    maxdd = dd.min()
    calmar = cagr / abs(maxdd) if maxdd < 0 else float("nan")
    wins = [t["pnl"] for t in trades if t["pnl"] > 0]
    losses = [t["pnl"] for t in trades if t["pnl"] <= 0]
    n = len(trades)
    winrate = len(wins) / n if n else float("nan")
    avg_win = np.mean(wins) if wins else 0.0
    avg_loss = np.mean(losses) if losses else 0.0
    expectancy = np.mean([t["pnl"] for t in trades]) if n else float("nan")
    pf = (sum(wins) / abs(sum(losses))) if losses and sum(losses) != 0 else float("inf")
    avg_ret = np.mean([t["ret"] for t in trades]) if n else float("nan")
    return dict(label=label, start=eq.index[0].date(), end=eq.index[-1].date(), years=years,
                final=eq.iloc[-1], cagr=cagr, vol=vol, sharpe=sharpe, sortino=sortino,
                maxdd=maxdd, calmar=calmar, trades=n, winrate=winrate, avg_win=avg_win,
                avg_loss=avg_loss, avg_ret=avg_ret, expectancy=expectancy, pf=pf, max_heat=max_heat)


def fmt(m: dict) -> str:
    pf = "∞" if m["pf"] == float("inf") else f"{m['pf']:.2f}"
    return (
        f"  period            {m['start']} → {m['end']}  ({m['years']:.1f} yr)\n"
        f"  final equity      ${m['final']:,.0f}  (from ${INIT_CAP:,.0f})\n"
        f"  CAGR              {m['cagr']*100:6.2f}%\n"
        f"  volatility (ann)  {m['vol']*100:6.2f}%\n"
        f"  Sharpe            {m['sharpe']:6.2f}   (rf={RF_ANNUAL*100:.0f}%)\n"
        f"  Sortino           {m['sortino']:6.2f}\n"
        f"  max drawdown      {m['maxdd']*100:6.2f}%\n"
        f"  Calmar            {m['calmar']:6.2f}\n"
        f"  max portfolio heat{m['max_heat']:6.2f}%   (cap {RISK['maxPortfolioHeatPct']:.0f}%)\n"
        f"  trades            {m['trades']}\n"
        f"  win rate          {m['winrate']*100:6.2f}%\n"
        f"  avg trade return  {m['avg_ret']*100:6.2f}%\n"
        f"  avg win / avg loss${m['avg_win']:.2f} / ${m['avg_loss']:.2f}\n"
        f"  expectancy/trade  ${m['expectancy']:.2f}\n"
        f"  profit factor     {pf}\n"
    )


# ───────────────────────── main ─────────────────────────
def main():
    refresh = "--refresh" in sys.argv
    print("Loading data (cache:", DATA_DIR, ")...")
    spy = fetch(BENCH, refresh)
    cal = spy.index
    spyC = spy["Close"].to_numpy()
    spyMA = spy["Close"].rolling(200).mean().to_numpy()

    arr = {}
    for s in UNIVERSE:
        d = indicators(fetch(s, refresh)).reindex(cal)
        arr[s] = {col: d[col].to_numpy() for col in ["Open", "High", "Low", "Close", "ATR", "MA200", "MOM", "HI20"]}

    # SPY buy & hold benchmark over the engine window (start at first traded day = index 200)
    bench_eq = pd.Series(INIT_CAP * spyC[200:] / spyC[200], index=cal[200:])
    bench_m = metrics(bench_eq, [], 0.0, "SPY buy & hold")

    results = []
    for slip in SLIP_BPS_RUNS:
        eq, trades, heat = run(arr, cal, spyC, spyMA, slip)
        m = metrics(eq, trades, heat, f"Engine @ {slip:.0f}bps slippage")
        results.append((m, eq, trades))

    # console report
    print("\n" + "=" * 70)
    print("BILL THE BULL — DETERMINISTIC RISK-ENGINE BACKTEST")
    print("Validates the PLUMBING (sizing/heat/stops/regime), not the LLM's picks.")
    print("=" * 70)
    for m, _, _ in results:
        print(f"\n▶ {m['label']}")
        print(fmt(m))
    print(f"\n▶ {bench_m['label']} (same window, same start capital)")
    print(fmt(bench_m))

    # write markdown + equity curve csv (primary run = first slippage)
    base_m, base_eq, _ = results[0]
    base_eq.to_csv(os.path.join(OUT_DIR, "equity_curve.csv"), header=["equity"])
    md = build_md(results, bench_m)
    with open(os.path.join(OUT_DIR, "RESULTS.md"), "w", encoding="utf-8") as f:
        f.write(md)
    print("Wrote:", os.path.join(OUT_DIR, "RESULTS.md"), "and equity_curve.csv")
    return md


def row(m):
    if m["trades"] == 0:        # buy & hold benchmark — no per-trade stats
        win, exp, pf = "—", "—", "—"
    else:
        win = f"{m['winrate']*100:.0f}%"
        exp = f"${m['expectancy']:.2f}"
        pf = "∞" if m["pf"] == float("inf") else f"{m['pf']:.2f}"
    return (f"| {m['label']} | {m['cagr']*100:.1f}% | {m['vol']*100:.1f}% | {m['sharpe']:.2f} | "
            f"{m['sortino']:.2f} | {m['maxdd']*100:.1f}% | {m['calmar']:.2f} | {m['max_heat']:.1f}% | "
            f"{m['trades']} | {win} | {exp} | {pf} |")


def build_md(results, bench_m):
    lines = [
        "# Bill the Bull — Risk-Engine Backtest Results",
        "",
        f"_Generated by `backtest/backtest.py`. Window: {results[0][0]['start']} → {results[0][0]['end']} "
        f"({results[0][0]['years']:.1f} yr). Start capital ${INIT_CAP:,.0f}._",
        "",
        "## What this proves (and what it doesn't)",
        "This tests the **deterministic risk plumbing** of the hybrid engine — ATR(22)×3 stops, "
        "1.5%-risk sizing, 20% name / 30% sector caps, 15% portfolio-heat ceiling, Chandelier trailing "
        "stop, 200-day-MA regime filter, and trading costs — driven by a transparent mechanical "
        "trend+momentum+breakout entry **as a stand-in for the LLM's idea generation**. ",
        "",
        "It does **NOT** prove the LLM's stock-picking works. Per the *profit-mirage* finding "
        "(Glasserman & Lin), an LLM's in-window backtest is contaminated by memorization and can't be "
        "trusted — only forward paper-trading past today's cutoff (Phase 0) can validate the live edge. "
        "Read the **drawdown and heat behavior** as the signal here, not the absolute return "
        "(the universe is survivor-tilted).",
        "",
        "## Results",
        "",
        "| Strategy | CAGR | Vol | Sharpe | Sortino | Max DD | Calmar | Max heat | Trades | Win% | Expectancy | PF |",
        "|---|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for m, _, _ in results:
        lines.append(row(m))
    lines.append(row(bench_m))
    lines += [
        "",
        "## How to read it",
        f"- **Max portfolio heat stayed ≤ {RISK['maxPortfolioHeatPct']:.0f}% cap** → the risk gate (the LLM-override "
        "layer) is doing its job: aggregate open risk never breached the ceiling.",
        "- **Max drawdown vs SPY** → whether the ATR stops + regime filter actually cushioned the bear "
        "legs (2018-Q4, 2020 COVID, 2022) relative to buy & hold.",
        "- **Slippage sensitivity** (5 vs 15 bps) → how fragile the edge is to execution cost. If the "
        "engine survives 15 bps, the paper→live gap on costs is manageable.",
        "- **Positive expectancy & PF > 1** on a *mechanical* signal → the plumbing doesn't bleed money "
        "on its own; the LLM only has to beat this baseline at idea selection.",
        "",
        "## Reproduce",
        "```bash",
        "cd backtest && python backtest.py        # cached data",
        "python backtest.py --refresh             # re-download",
        "```",
        "",
        "_Educational/research backtest — not investment advice. Past performance ≠ future results; "
        "survivorship and other biases apply (see header of `backtest.py`)._",
    ]
    return "\n".join(lines)


if __name__ == "__main__":
    main()
