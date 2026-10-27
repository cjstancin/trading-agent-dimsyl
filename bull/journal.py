"""The trade journal: one small CSV row per trade, real or shadow, written once at the close.

Each row records what the setup looked like at entry (gap, relative volume, ATR, stop width,
minute, SPY), how far price went against and for the trade (MAE/MFE in R), and for losers a
plain label of why. Around 300 bytes a row, so years of trading stay well under a few MB.
"""
from __future__ import annotations

import csv
import json
import logging
from collections import defaultdict
from datetime import date, datetime

from .backtest import simulate_exit
from .config import ET, runtime_dir
from .models import Bar, Signal
from .risk import sell_fees, size_position

log = logging.getLogger("bull.journal")

FIELDS = ["date", "kind", "variant", "symbol", "side", "t_entry", "entry", "stop", "target", "qty",
          "t_exit", "exit", "reason", "pnl", "r", "gap_pct", "rvol", "atr_pct", "stop_pct", "minute",
          "spy_chg", "mae_r", "mfe_r", "loss_type"]
FEATURES = ["gap_pct", "rvol", "atr_pct", "stop_pct", "minute", "spy_chg"]


def path():
    return runtime_dir() / "journal.csv"


def excursions(bars: list[Bar], t_entry: datetime, t_exit: datetime | None, entry: float, stop: float,
               side: str) -> tuple[float | None, float | None]:
    """Worst and best move while the trade was open, in R (risk per share). MAE <= 0 <= MFE."""
    risk = abs(entry - stop)
    held = [b for b in bars if t_entry <= b.t and (t_exit is None or b.t <= t_exit)]
    if not risk or not held:
        return None, None
    if side == "long":
        mae, mfe = (min(b.l for b in held) - entry) / risk, (max(b.h for b in held) - entry) / risk
    else:
        mae, mfe = (entry - max(b.h for b in held)) / risk, (entry - min(b.l for b in held)) / risk
    return round(min(mae, 0.0), 2), round(max(mfe, 0.0), 2)


def loss_type(row: dict, spy_day_chg: float | None) -> str:
    """Why a losing trade lost, in four buckets. Winners get an empty label."""
    if row["pnl"] is None or row["pnl"] > 0:
        return ""
    risk = abs(row["entry"] - row["stop"])
    if row["reason"] == "stop" and risk and row["exit"] is not None:
        slip = (row["stop"] - row["exit"]) if row["side"] == "long" else (row["exit"] - row["stop"])
        if slip > 0.25 * risk:
            return "bad fill"
    if row["mfe_r"] is not None and row["mfe_r"] >= 1.0:
        return "gave back"
    if spy_day_chg is not None and spy_day_chg <= -1.0:
        return "market down"
    return "setup failed"


def _row(day: date, kind: str, variant: str, symbol: str, side: str, t_entry, entry, stop, target, qty,
         t_exit, exit_px, reason, pnl, features: dict, bars: list[Bar], spy_day_chg) -> dict:
    risk = abs(entry - stop) * qty if qty else 0
    te = t_entry if isinstance(t_entry, datetime) else datetime.fromisoformat(t_entry)
    tx = None if t_exit is None else (t_exit if isinstance(t_exit, datetime) else datetime.fromisoformat(t_exit))
    mae, mfe = excursions(bars, te, tx, entry, stop, side)
    row = {
        "date": day.isoformat(), "kind": kind, "variant": variant, "symbol": symbol, "side": side,
        "t_entry": te.strftime("%H:%M"), "entry": round(entry, 4), "stop": round(stop, 4),
        "target": round(target, 4) if target is not None else None, "qty": qty,
        "t_exit": tx.strftime("%H:%M") if tx else None,
        "exit": round(exit_px, 4) if exit_px is not None else None, "reason": reason,
        "pnl": round(pnl, 2) if pnl is not None else None,
        "r": round(pnl / risk, 3) if pnl is not None and risk else None,
        **{f: features.get(f) for f in FEATURES}, "mae_r": mae, "mfe_r": mfe,
    }
    row["loss_type"] = loss_type(row, spy_day_chg)
    return row


def journaled_days() -> set[str]:
    try:
        with open(path(), newline="", encoding="utf-8") as f:
            return {r["date"] for r in csv.DictReader(f)}
    except OSError:
        return set()


def close_day(day: date, trips: list[dict], entry_events: list[dict], shadows: list[dict],
              bars: dict[str, list[Bar]], spy_day_chg: float | None, equity: float, cfg: dict) -> int:
    """Append today's real trades and resolved shadow signals. Idempotent per day."""
    if day.isoformat() in journaled_days():
        return 0
    feats = {(e.get("variant"), e.get("symbol")): e.get("features") or {} for e in entry_events}
    rows = []
    for t in trips:
        if t["exit"] is None:
            continue
        rows.append(_row(day, "real", t["variant"], t["symbol"], t["side"], t["t_entry"], t["entry"],
                         t["stop"] or t["entry"], t["target"], int(t["qty"]), t["t_exit"], t["exit"],
                         t["reason"], t["pnl"], feats.get((t["variant"], t["symbol"]), {}),
                         bars.get(t["symbol"], []), spy_day_chg))
    for s in shadows:
        sym_bars = bars.get(s["symbol"], [])
        t_sig = datetime.fromisoformat(s["t"])
        k = next((i for i, b in enumerate(sym_bars) if b.t == t_sig), None)
        if k is None:
            continue
        sig = Signal(s["variant"], s["symbol"], s["side"], t_sig, s["ref"], s["stop"], s["target"], s["why"])
        ex = simulate_exit(sym_bars, k, sig, cfg["costs"]["slippage_bps"], cfg["risk"]["flatten_at"])
        if ex is None:
            continue
        qty = size_position(equity, equity, sig.ref, sig.stop, cfg["risk"])
        if qty < 1:
            continue
        sgn = 1 if sig.side == "long" else -1
        pnl = sgn * (ex.exit - ex.entry) * qty - sell_fees(ex.exit if sgn > 0 else ex.entry, qty, cfg["costs"])
        rows.append(_row(day, "shadow", s["variant"], s["symbol"], s["side"], ex.t_entry, ex.entry, sig.stop,
                         sig.target, qty, ex.t_exit, ex.exit, ex.reason, pnl, s.get("features") or {},
                         sym_bars, spy_day_chg))
    if not rows:  # still mark the day so we don't redo it; a row with only a date is cheap
        rows.append({"date": day.isoformat(), "kind": "none"})
    new = not path().exists()
    with open(path(), "a", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        if new:
            w.writeheader()
        for r in rows:
            w.writerow(r)
    return sum(1 for r in rows if r.get("kind") != "none")


def _bucket(v, edges):
    if v in (None, ""):
        return "n/a"
    v = float(v)
    for lo, hi, label in edges:
        if lo <= v < hi:
            return label
    return "n/a"


MINUTE = [(0, 10, "9:30–9:40"), (10, 20, "9:40–9:50"), (20, 60, "9:50–10:30"), (60, 999, "later")]
GAP = [(-99, 5, "<5%"), (5, 8, "5–8%"), (8, 999, "8%+")]
RVOL = [(0, 1, "<1x"), (1, 2, "1–2x"), (2, 999, "2x+")]


def summary() -> dict:
    """Small aggregates for the site: shadow scoreboard, loss reasons and what wins/loses."""
    try:
        with open(path(), newline="", encoding="utf-8") as f:
            rows = [r for r in csv.DictReader(f) if r.get("kind") in ("real", "shadow") and r.get("r") not in ("", None)]
    except OSError:
        rows = []
    for r in rows:
        r["r"] = float(r["r"])
        r["pnl"] = float(r["pnl"])

    def agg(rs):
        n = len(rs)
        return {"n": n, "win_rate": round(sum(x["pnl"] > 0 for x in rs) / n * 100, 1) if n else None,
                "avg_r": round(sum(x["r"] for x in rs) / n, 3) if n else None,
                "total_r": round(sum(x["r"] for x in rs), 2), "net": round(sum(x["pnl"] for x in rs), 2)}

    by_var = defaultdict(list)
    for r in rows:
        if r["kind"] == "shadow":
            by_var[r["variant"]].append(r)
    real = [r for r in rows if r["kind"] == "real"]
    basis = real if len(real) >= 10 else [r for r in rows if r["kind"] == "shadow" and r["variant"] == "gap_control"]
    buckets = {}
    for name, key, edges in (("entry time", "minute", MINUTE), ("gap", "gap_pct", GAP), ("rel. volume", "rvol", RVOL)):
        g = defaultdict(list)
        for r in basis:
            g[_bucket(r.get(key), edges)].append(r)
        buckets[name] = {label: agg(g[label]) for _, _, label in edges if g[label]}
    losses = defaultdict(int)
    for r in real:
        if r.get("loss_type"):
            losses[r["loss_type"]] += 1
    days = journaled_days()
    return {
        "days": len(days),
        "real": agg(real),
        "shadow": {v: agg(rs) for v, rs in sorted(by_var.items())},
        "loss_types": dict(losses),
        "buckets": buckets,
        "buckets_from": "real trades" if basis is real else "control shadow trades",
        "recent": [{k: r.get(k) for k in ("date", "kind", "variant", "symbol", "t_entry", "reason", "r", "mae_r",
                                         "mfe_r", "gap_pct", "rvol", "minute", "loss_type")}
                   for r in rows if r["kind"] == "real"][-25:],
    }


def save_shadows(day: date, shadows: list[dict]) -> None:
    (runtime_dir() / "shadow-today.json").write_text(json.dumps({"day": day.isoformat(), "signals": shadows}),
                                                    encoding="utf-8")


def load_shadows(day: date) -> list[dict]:
    try:
        blob = json.loads((runtime_dir() / "shadow-today.json").read_text(encoding="utf-8"))
        return blob["signals"] if blob.get("day") == day.isoformat() else []
    except (OSError, ValueError, KeyError):
        return []


def prune_events(keep_days: int = 14) -> None:
    """events.jsonl is a running activity feed; the journal is the record. Keep it short."""
    p = runtime_dir() / "events.jsonl"
    if not p.exists():
        return
    cutoff = datetime.now(ET).date().toordinal() - keep_days
    keep = []
    with open(p, encoding="utf-8") as f:
        for line in f:
            try:
                if date.fromisoformat(json.loads(line)["t"][:10]).toordinal() >= cutoff:
                    keep.append(line)
            except (ValueError, KeyError):
                continue
    tmp = p.with_suffix(".tmp")
    tmp.write_text("".join(keep), encoding="utf-8")
    tmp.replace(p)
