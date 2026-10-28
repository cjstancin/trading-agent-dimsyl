"""Fed-day reader: parse FOMC statements, score them, and show how SPY reacted.

Every statement is scored the same way: the rate decision (change in the top of the target range),
the dissents and which way each one leaned (a dissenter who preferred a higher rate than the decision
is hawkish, lower is dovish), and the sentences that changed vs the previous statement. The lean is
the change in the hawk-minus-dove dissent balance since the last meeting, plus the direction of any
surprise move is left to the reader: the market prices the decision itself in advance.

  python -m bull fed-history   replays every statement on the Fed's calendar against SPY 1-min bars
                               (13:59 -> 14:04 / 14:29, presser 14:30 -> close) -> runtime/fed-history.json
  FedWatcher (site)            on a meeting day polls the statement URL every second from 13:59:45,
                               shows the read on the site within seconds and pings the phone once.

Display only: the bot never trades the Fed. The algorithms react in milliseconds; this is for the
minutes after, and for knowing what history says about days like this one.
"""
from __future__ import annotations

import difflib
import html
import json
import logging
import re
import threading
import time
import urllib.error
import urllib.request
from datetime import date, datetime
from datetime import time as dtime

from . import data
from .config import ET, runtime_dir

log = logging.getLogger("bull.fed")

UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"}
CALENDAR = "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm"
STATEMENT = "https://www.federalreserve.gov/newsevents/pressreleases/monetary{}a.htm"
MONTHS = {m: i for i, m in enumerate(["january", "february", "march", "april", "may", "june", "july", "august",
                                      "september", "october", "november", "december"], 1)}


def _get(url: str) -> str:
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=20).read().decode("utf-8", "replace")


# --- calendar ------------------------------------------------------------------------------------
def calendar() -> tuple[list[date], list[date]]:
    """(dates with a published statement, all scheduled decision days) from the Fed's calendar page."""
    page = _get(CALENDAR)
    released = sorted({datetime.strptime(d, "%Y%m%d").date()
                       for d in re.findall(r"/newsevents/pressreleases/monetary(\d{8})a\.htm", page)})
    scheduled = set(released)
    for ym in re.finditer(r"(\d{4}) FOMC Meetings", page):
        year, end = int(ym.group(1)), page.find("FOMC Meetings", ym.end())
        block = page[ym.end(): end if end > 0 else len(page)]
        for mon, day in re.findall(r"fomc-meeting__month[^>]*>\s*<strong>([^<]+)</strong>.*?fomc-meeting__date[^>]*>([^<]+)<",
                                    block, re.S):
            m = MONTHS.get(mon.split("/")[-1].strip().lower())
            d = re.findall(r"\d+", day)
            if m and d:
                try:
                    scheduled.add(date(year, m, int(d[-1])))
                except ValueError:
                    pass
    return released, sorted(scheduled)


# --- one statement -------------------------------------------------------------------------------
def _frac(s: str) -> float:
    """'3-3/4' -> 3.75, '1/4' -> 0.25, '4' -> 4.0"""
    s = s.replace("‑", "-").replace("–", "-").strip().rstrip("-")
    if "/" not in s:
        return float(s)
    whole, part = s.split("-", 1) if "-" in s else ("0", s)
    n, d = part.split("/")
    return float(whole) + int(n) / int(d)


def _paragraphs(page: str) -> list[str]:
    m = re.search(r'<div class="col-xs-12 col-sm-8 col-md-8">(.*?)<div class="col-xs-12 col-sm-4', page, re.S)
    body = m.group(1) if m else page
    paras = [re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", p))).strip()
             for p in re.findall(r"<p[^>]*>(.*?)</p>", body, re.S)]
    return [p.replace("‑", "-") for p in paras if len(p) > 40 and "media inquiries" not in p]


def _change_words(text: str, default: float = 0.25) -> float | None:
    """'raise ... by 1/2 percentage point' -> +0.5, 'lower' -> -x, 'maintain'/'no change' -> 0."""
    by = re.search(r"by (\d[\d/\-]*) percentage point", text)
    size = _frac(by.group(1)) if by else default
    if re.search(r"\braise\b|\bincrease\b", text):
        return size
    if re.search(r"\blower\b|\breduce\b|\bcut\b", text):
        return -size
    if re.search(r"\bmaintain\b|\bleave\b|\bno change\b|\bunchanged\b", text):
        return 0.0
    return None


def parse(page: str) -> dict:
    paras = _paragraphs(page)
    text = " ".join(paras)
    upper = None
    rng = re.search(r"(?:at|to) (\d[\d/\-]*|\d/\d) to (\d[\d/\-]*) percent", text)
    if rng:
        upper = _frac(rng.group(2))
    dec = re.search(r"decided to (raise|lower|maintain)[^.]*", text)
    decision = dec.group(1) if dec else None
    stated = _change_words(dec.group(0)) if dec else None
    dissents = []
    against = re.search(r"Voting against (?:this|the) (?:monetary policy )?action (?:was|were) (.*?)(?=Voting for|$)", text)
    if against:
        for names, pref in re.findall(r"(.*?), who preferred (.*?)(?:\.\s|\.$|;\s*and\s|;\s)", against.group(1) + " "):
            names = re.sub(r"^(and|;|,|\s)+", "", names)
            n = len([x for x in re.split(r",\s*(?:and\s+)?|\s+and\s+", names) if re.search(r"[A-Z][a-z]", x)])
            dissents.append({"names": names.strip(), "n": max(n, 1), "preferred": pref.strip(),
                             "change": _change_words(pref)})
    vote = re.search(r"by a (\d+)\s*[-–]\s*(\d+) vote", text)
    sentences = [s.strip() for p in paras if not p.startswith("Voting") and "approved the following statement" not in p
                 for s in re.split(r"(?<=\.)\s+(?=[A-Z])", p) if len(s.strip()) > 20]
    return {"decision": decision, "upper": upper, "stated_change": stated, "dissents": dissents,
            "vote": f"{vote.group(1)}-{vote.group(2)}" if vote else None, "sentences": sentences}


def score(cur: dict, prev: dict | None) -> dict:
    """Decision size, hawk/dove dissent counts and the lean vs the previous statement."""
    change = cur["stated_change"]
    if (change is None or cur["decision"] != "maintain") and cur.get("upper") is not None and prev and prev.get("upper") is not None:
        change = round(cur["upper"] - prev["upper"], 4)  # 2022 statements give the new range, not the step
    change = change or 0.0
    hawk = sum(d["n"] for d in cur["dissents"] if d["change"] is not None and d["change"] > change)
    dove = sum(d["n"] for d in cur["dissents"] if d["change"] is not None and d["change"] < change)
    other = sum(d["n"] for d in cur["dissents"] if d["change"] is None)
    balance = hawk - dove
    prev_balance = prev["hawk"] - prev["dove"] if prev and "hawk" in prev else 0
    lean = balance - prev_balance
    changed = []
    if prev:
        sm = difflib.SequenceMatcher(None, prev["sentences"], cur["sentences"], autojunk=False)
        for op, a1, a2, b1, b2 in sm.get_opcodes():
            if op != "equal":
                changed.append({"old": " ".join(prev["sentences"][a1:a2]), "new": " ".join(cur["sentences"][b1:b2])})
    return {"change_bp": round(change * 100), "hawk": hawk, "dove": dove, "other": other, "balance": balance,
            "lean": lean, "lean_label": "HAWKISH" if lean >= 1 else "DOVISH" if lean <= -1 else "NEUTRAL",
            "changed": changed}


# --- history -------------------------------------------------------------------------------------
def _spy_moves(dc, d: date) -> dict | None:
    bars = data.day_minute_bars(dc, d, ["SPY"]).get("SPY") or []
    px = {b.t.strftime("%H:%M"): b.c for b in bars}
    need = ("13:59", "14:04", "14:29", "15:59")
    if not all(k in px for k in need):
        return None
    pct = lambda a, b: round((px[b] / px[a] - 1) * 100, 3)
    return {"m5": pct("13:59", "14:04"), "m30": pct("13:59", "14:29"), "presser": pct("14:29", "15:59"),
            "day_after_2": pct("13:59", "15:59")}


def _bucket(rows: list[dict]) -> dict:
    out = {}
    for k in ("m5", "m30", "presser", "day_after_2"):
        xs = [r["spy"][k] for r in rows]
        out[k] = {"avg": round(sum(xs) / len(xs), 3) if xs else None, "down": sum(x < 0 for x in xs), "n": len(xs),
                  "avg_abs": round(sum(abs(x) for x in xs) / len(xs), 3) if xs else None}
    return out


def history() -> dict:
    released, _ = calendar()
    dc = data.client()
    rows, prev = [], None
    for d in released:
        try:
            cur = parse(_get(STATEMENT.format(d.strftime("%Y%m%d"))))
        except Exception as exc:
            log.warning("statement %s: %s", d, exc)
            continue
        s = score(cur, prev)
        cur.update(hawk=s["hawk"], dove=s["dove"])
        prev = cur
        spy = _spy_moves(dc, d)
        if spy:
            rows.append({"date": d.isoformat(), "vote": cur["vote"], "change_bp": s["change_bp"], "hawk": s["hawk"],
                         "dove": s["dove"], "lean": s["lean"], "lean_label": s["lean_label"],
                         "changed": len(s["changed"]), "spy": spy})
    groups = {
        "all": rows,
        "hawkish lean": [r for r in rows if r["lean_label"] == "HAWKISH"],
        "neutral lean": [r for r in rows if r["lean_label"] == "NEUTRAL"],
        "dovish lean": [r for r in rows if r["lean_label"] == "DOVISH"],
        "any hawkish dissent": [r for r in rows if r["hawk"] > 0],
        "2+ hawkish dissents": [r for r in rows if r["hawk"] >= 2],
        "hike": [r for r in rows if r["change_bp"] > 0],
        "hold": [r for r in rows if r["change_bp"] == 0],
        "cut": [r for r in rows if r["change_bp"] < 0],
    }
    out = {"generated_at": datetime.now(ET).isoformat(timespec="seconds"), "meetings": rows,
           "groups": {k: _bucket(v) for k, v in groups.items()}}
    (runtime_dir() / "fed-history.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    return out


def print_history(h: dict) -> None:
    print(f"{'date':<11}{'vote':>6}{'bp':>5}{'hawk':>5}{'dove':>5}{'lean':>9}{'chg':>5}  SPY: 5m    30m  presser  2pm-close")
    for r in h["meetings"]:
        s = r["spy"]
        print(f"{r['date']:<11}{r['vote'] or '':>6}{r['change_bp']:>5}{r['hawk']:>5}{r['dove']:>5}{r['lean_label']:>9}"
              f"{r['changed']:>5}  {s['m5']:>6.2f}{s['m30']:>7.2f}{s['presser']:>8.2f}{s['day_after_2']:>10.2f}")
    print(f"\n{'group':<22}{'n':>3}   avg% (down/n)  5m | 30m | presser->close | 2pm->close")
    for k, g in h["groups"].items():
        print(f"{k:<22}{g['m5']['n']:>3}   " + " | ".join(
            f"{g[x]['avg']:+.2f} ({g[x]['down']}/{g[x]['n']})" if g[x]["n"] else "-" for x in ("m5", "m30", "presser", "day_after_2")))


# --- live watcher --------------------------------------------------------------------------------
class FedWatcher:
    def __init__(self, feed=None):
        self.feed = feed
        self.view: dict | None = None
        self.scheduled: list[date] = []
        self.released: list[date] = []
        self.cal_day: date | None = None
        self.prev: dict | None = None
        self.prev_day: date | None = None

    def start(self) -> None:
        threading.Thread(target=self._loop, daemon=True, name="fed").start()

    def _history(self) -> dict | None:
        try:
            return json.loads((runtime_dir() / "fed-history.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def _spy(self) -> float | None:
        q = (self.feed.last.get("SPY") if self.feed else None) or {}
        return q.get("p")

    def _loop(self) -> None:
        while True:
            now = datetime.now(ET)
            wait = 60
            try:
                if self.cal_day != now.date():
                    self.released, self.scheduled = calendar()
                    self.cal_day = now.date()
                today = now.date()
                if today in self.scheduled:
                    if not self.view or self.view.get("date") != today.isoformat():
                        self.prev, self.prev_day = self._previous(today)
                        self.view = {"date": today.isoformat(), "status": "waiting", "history": self._history(),
                                     "release_at": "14:00", "prev_date": self.prev_day.isoformat() if self.prev_day else None,
                                     "prev_vote": self.prev["vote"] if self.prev else None,
                                     "prev_dissents": self.prev["dissents"] if self.prev else []}
                    if self.view["status"] == "waiting":
                        if dtime(13, 59, 45) <= now.time() < dtime(14, 5):
                            wait = 1
                        if now.time() >= dtime(13, 59, 45):
                            self._try_release(today)
                elif self.view and self.view.get("date") != today.isoformat():
                    self.view = None
            except Exception:
                log.exception("fed watcher")
            time.sleep(wait)

    def _previous(self, today: date) -> tuple[dict | None, date | None]:
        """The last statement before today, scored against its own predecessor (for its dissent balance)."""
        days = [d for d in self.released if d < today]
        if not days:
            return None, None
        prev = parse(_get(STATEMENT.format(days[-1].strftime("%Y%m%d"))))
        before = parse(_get(STATEMENT.format(days[-2].strftime("%Y%m%d")))) if len(days) > 1 else None
        s = score(prev, before)
        prev.update(hawk=s["hawk"], dove=s["dove"])
        return prev, days[-1]

    def _try_release(self, today: date) -> None:
        try:
            page = _get(STATEMENT.format(today.strftime("%Y%m%d")))
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return  # not out yet
            raise
        seen_at = datetime.now(ET)
        cur = parse(page)
        prev, prev_day = self.prev, self.prev_day
        s = score(cur, prev)
        self.view = {"date": today.isoformat(), "status": "released", "seen_at": seen_at.strftime("%H:%M:%S"),
                     "url": STATEMENT.format(today.strftime("%Y%m%d")), "decision": cur["decision"], "vote": cur["vote"],
                     "dissents": cur["dissents"], "prev_vote": prev["vote"] if prev else None,
                     "prev_date": prev_day.isoformat() if prev_day else None, "spy_at_release": self._spy(),
                     "history": self._history(), **s}
        log.info("FOMC statement %s: %s, vote %s, lean %s", today, cur["decision"], cur["vote"], s["lean_label"])
        from .notify import ping
        diss = "; ".join(f"{d['names']} ({d['preferred'][:40]})" for d in cur["dissents"]) or "no dissents"
        ping(f"fed-{today}", f"Fed {s['lean_label']}: {cur['decision']} {s['change_bp']:+d}bp, vote {cur['vote'] or '?'}",
             f"{diss}. {len(s['changed'])} sentences changed vs {prev_day}. Read: bull.dimsylaisolutions.com",
             priority="high", every_s=86400)
