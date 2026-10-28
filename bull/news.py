"""Catalyst tracker for the site: market-wide news, sorted by how much that kind of headline tends to
move a stock, next to how the stock is actually reacting. Display only: the bot never trades news.

Layer 1, the headline (keyword rules, first match wins):
  binary     FDA decisions, trial results, buyouts, trading halts, bankruptcy/fraud (often +-20-60%)
  big        earnings, guidance, offerings, up/downgrades, activists, exec exits, contracts (+-5-20%)
  milestone  something scheduled, not a result yet: trial event counts, readout or earnings dates.
             Volatility comes later (SLS 2026-10-28 fell 18% on its 80th-event "milestone").
  other      everything else; info = "why is X moving" explainers; noise = roundups, transcripts.
Layer 2, the reaction: live change and gap (IEX), full-market volume vs the 20-day average, and
market cap, which also screen the list down to stocks worth watching ([catalysts] in config.toml).

Sources: Alpaca's news API (Benzinga, free with the data plan) polled every few seconds, and the
public Nasdaq screener (market cap, sector, consolidated volume for every listed stock) every 5 min.
"""
from __future__ import annotations

import json
import logging
import re
import threading
import time
import urllib.request
from datetime import date, datetime, timedelta
from datetime import time as dtime
from urllib.parse import urlencode

from . import data
from .config import ET, alpaca_keys

log = logging.getLogger("bull.news")

NEWS_URL = "https://data.alpaca.markets/v1beta1/news"
NASDAQ_URL = "https://api.nasdaq.com/api/screener/stocks?tableonly=true&download=true"
BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
WEIGHT = {"binary": 3.0, "big": 2.0, "milestone": 1.5, "other": 1.0, "info": 0.6}
MAX_SYMBOLS_PER_ARTICLE = 3  # more than this is a roundup ("12 stocks moving premarket")
SYMBOL_RE = re.compile(r"^[A-Z]{1,5}(\.[A-Z])?$")

_R = [
    ("noise", "roundup", r"\bstocks? moving\b|\bmovers\b|\bhere are\b|\btop \d+\b|analyst forecasts|stocks to watch"
                         r"|call transcript|\bparticipat\w* in\b.*\bconference|investor conferences?|unusual options"
                         r"|options activity|\bwhale\b|short interest|p/e ratio|\ba look at\b|price over earnings"),
    ("binary", "halt", r"trading halt|\bhalted\b|halt news pending"),
    ("milestone", "trial milestone", r"\b\d+(st|nd|rd|th) event\b|events? (milestone|threshold)"
                                     r"|(completes?|completed) (patient )?enrollment|enrollment complet"
                                     r"|first patient (dosed|enrolled)|readout (expected|anticipated|in )"
                                     r"|data (expected|anticipated)|pdufa (target )?(action )?date"),
    ("milestone", "earnings date", r"to (report|announce|release) .*(results|earnings)|(results|earnings) (release )?date"
                                   r"|to host .*(conference call|webcast)"),
    ("binary", "FDA", r"\bFDA\b|\bPDUFA\b|complete response letter|\bCRL\b|\bCHMP\b|marketing authori[sz]ation"
                      r"|breakthrough therapy|fast track designation|clinical hold"),
    ("binary", "trial result", r"\b(phase|ph\.?) ?(1|2|3|i{1,3}|1/2|2/3|2b|3b)\b.*\b(results?|data|met|meets|miss\w*|fail\w*"
                               r"|endpoint|topline|top-line|discontinu\w*|halt\w*|stop\w*|terminat\w*|positive|negative)"
                               r"|\b(discontinu\w*|terminat\w*|stops?|halts?)\b.*\b(phase|trial|study)\b"
                               r"|\b(topline|top-line)\b|primary endpoint"),
    ("binary", "M&A", r"\bto acquire\b|\bacquires\b|\bacquisition of\b|\bmerger\b|\bto merge\b|\bbuyout\b|\btakeover\b"
                      r"|tender offer|offers? to buy|\bbid for\b|cash bid|tak(e|es|en|ing) private|go(es|ing)? private"
                      r"|definitive agreement|strategic alternatives|explor\w* (a )?sale"),
    ("binary", "distress", r"bankrupt|chapter 11|\bdelist|going concern|short (seller|report)|hindenburg|muddy waters"
                           r"|\bsec (probe|investigation|charges)|\bsubpoena|accounting irregularit|\brestate|\bfraud\b"
                           r"|default(s|ed)? on"),
    ("big", "offering", r"public offering|registered direct|private placement|\bATM\b|at-the-market|\bprices?\b.*\boffering"
                        r"|\bpriced\b.*\boffering|\bdilut|convertible (senior )?notes|\bshelf\b|warrant (exercise|inducement)"),
    ("big", "up/downgrade", r"\bupgrade[sd]?\b|\bdowngrade[sd]?\b"),
    ("other", "analyst", r"price target|\bmaintains\b|\breiterates\b|initiates? coverage|\bassumes\b|analyst rating"),
    ("big", "guidance", r"guidance|\boutlook\b|\bsees (q[1-4]|fy|full[- ]year|20\d\d)|\bexpects (q[1-4]|fy|full[- ]year)"
                        r"|\b(raises|lowers|cuts|withdraws|reaffirms|boosts) .*(forecast|view|estimates?)|profit warning"),
    ("big", "earnings", r"\b(q[1-4]|first|second|third|fourth)[- ]quarter\b.*\b(results|eps|earnings|sales|revenue)"
                        r"|\bq[1-4]\b.*\b(eps|earnings|sales|revenue)\b|\b(beats?|misses|miss|tops)\b.*\b(estimates?|views"
                        r"|expectations)|double (beat|miss)|reports .*results|earnings (beat|miss)"),
    ("big", "split", r"reverse (stock )?split|\bstock split"),
    ("big", "activist", r"\b13d\b|\bactivist\b|\bstake in\b|% stake"),
    ("big", "exec change", r"\b(ceo|cfo|chief executive|chairman)\b.*\b(resign\w*|steps? down|depart\w*|exit\w*|fired"
                           r"|ousted|retire\w*)|\b(resign\w*|steps? down)\b.*\b(ceo|cfo|chief executive)"),
    ("big", "deal", r"\bcontract\b|\bpartnership\b|\bpartners with\b|\bcollaborat\w*|\blicens\w* (agreement|deal)"
                    r"|\bawarded\b|\bwins\b.*\b(order|deal|contract)|supply agreement"),
    ("big", "buyback/dividend", r"buyback|repurchase|special dividend|dividend (cut|suspen\w*|hike|increase)"),
    ("info", "why it moved", r"what'?s going on|what'?s behind|\bwhy (is|are|did|does)\b|shares are trading (higher|lower)"
                             r"|stock (jumps|falls|sinks|soars|stumbles|surges|tumbles|slides|rallies|drops|plunges|spikes)"
                             r"|(jumps|falls|sinks|soars|surges|tumbles|plunges) \d+%"),
]
RULES = [(tier, tag, re.compile(rx, re.I)) for tier, tag, rx in _R]


def classify(headline: str, symbols: list[str]) -> tuple[str, str]:
    """(tier, tag) for one headline. Roundups that tag many tickers are noise for every one of them."""
    if len(symbols) > MAX_SYMBOLS_PER_ARTICLE:
        return "noise", "roundup"
    for tier, tag, rx in RULES:
        if rx.search(headline):
            return tier, tag
    return "other", "news"


def window_start(now: datetime) -> datetime:
    """Since 4 PM ET on the weekday before today: last night's after-hours news plus today's."""
    d = now.date() - timedelta(days=1)
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return datetime.combine(d, dtime(16), ET)


def _num(x) -> float | None:
    try:
        return float(str(x).replace("$", "").replace(",", ""))
    except (TypeError, ValueError):
        return None


class NewsWatcher:
    def __init__(self, cfg: dict, dc, feed=None):
        self.rules = {"min_market_cap": 500_000_000, "min_volume": 10_000_000, "min_move_pct": 3.0,
                      "poll_seconds": 15, **cfg.get("catalysts", {})}
        self.dc = dc
        self.feed = feed
        self.items: dict[int, dict] = {}
        self.listed: dict[str, dict] = {}
        self.listed_at = 0.0
        self.avg_vol: dict[str, tuple[date, float | None]] = {}
        self.view: dict | None = None

    def start(self) -> None:
        threading.Thread(target=self._loop, daemon=True, name="news").start()

    def _loop(self) -> None:
        while True:
            try:
                self.refresh()
            except Exception:
                log.exception("news refresh failed")
            time.sleep(self.rules["poll_seconds"])

    # --- sources --------------------------------------------------------------------------------
    def _fetch_news(self, start: datetime) -> list[dict]:
        key, secret = alpaca_keys()
        headers = {"APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret}
        out, token = [], None
        for _ in range(200):  # ~50 per page; a busy day is ~3,000 articles
            q = {"start": start.astimezone().isoformat(), "limit": 50, "sort": "desc"}
            if token:
                q["page_token"] = token
            req = urllib.request.Request(f"{NEWS_URL}?{urlencode(q)}", headers=headers)
            page = json.load(urllib.request.urlopen(req, timeout=20))
            out += page.get("news") or []
            token = page.get("next_page_token")
            if not token:
                break
        return out

    def _refresh_listed(self) -> None:
        if time.time() - self.listed_at < 300:
            return
        self.listed_at = time.time()  # also on failure: retry in 5 min, not every poll
        req = urllib.request.Request(NASDAQ_URL, headers={"User-Agent": BROWSER_UA, "Accept": "application/json"})
        rows = json.load(urllib.request.urlopen(req, timeout=30))["data"]["rows"]
        listed = {}
        for r in rows:
            cap, price = _num(r.get("marketCap")), _num(r.get("lastsale"))
            listed[r["symbol"].replace("/", ".")] = {
                "name": r.get("name"), "sector": r.get("sector") or None, "volume": _num(r.get("volume")),
                "shares": cap / price if cap and price else None,
            }
        self.listed = listed

    def _avg_volumes(self, symbols: list[str]) -> None:
        today = datetime.now(ET).date()
        need = [s for s in symbols if self.avg_vol.get(s, (None,))[0] != today]
        if not need:
            return
        bars = data.daily_bars(self.dc, need, today - timedelta(days=45), today)
        for s in need:
            vols = [b.v for b in bars.get(s, []) if b.t.date() < today][-20:]
            self.avg_vol[s] = (today, sum(vols) / len(vols) if vols else None)

    # --- the view -------------------------------------------------------------------------------
    def refresh(self) -> None:
        now = datetime.now(ET)
        since = window_start(now)
        for k in [k for k, v in self.items.items() if v["dt"] < since]:
            del self.items[k]
        newest = max((v["dt"] for v in self.items.values()), default=None)
        for n in self._fetch_news(max(since, newest - timedelta(minutes=2)) if newest else since):
            if n["id"] in self.items:
                continue
            tier, tag = classify(n.get("headline") or "", n.get("symbols") or [])
            if tier == "noise":
                continue
            self.items[n["id"]] = {
                "id": n["id"], "dt": datetime.fromisoformat(n["created_at"].replace("Z", "+00:00")).astimezone(ET),
                "headline": n.get("headline") or "", "url": n.get("url"), "source": n.get("source"),
                "symbols": n.get("symbols") or [], "tier": tier, "tag": tag,
            }
        try:
            self._refresh_listed()
        except Exception as exc:
            log.warning("nasdaq screener failed: %s", exc)

        by_sym: dict[str, list[dict]] = {}
        for it in self.items.values():
            for s in it["symbols"]:
                if SYMBOL_RE.match(s) and (not self.listed or s in self.listed):
                    by_sym.setdefault(s, []).append(it)
        syms = sorted(by_sym)
        quotes = {}
        for i in range(0, len(syms), 200):
            try:
                quotes.update(data.snapshots(self.dc, syms[i:i + 200]))
            except Exception as exc:
                log.warning("news snapshots failed: %s", exc)
        r = self.rules
        big_enough = [s for s in syms if (self.listed.get(s, {}).get("shares") or 0) * (quotes.get(s, {}).get("last") or 0)
                      >= r["min_market_cap"]]
        try:
            self._avg_volumes(big_enough)
        except Exception as exc:
            log.warning("average volumes failed: %s", exc)

        rows = []
        for s, its in by_sym.items():
            its = sorted(its, key=lambda x: (WEIGHT[x["tier"]], x["dt"]), reverse=True)
            q, li = quotes.get(s, {}), self.listed.get(s, {})
            cap = li["shares"] * q["last"] if li.get("shares") and q.get("last") else None
            vol, avg = li.get("volume"), self.avg_vol.get(s, (None, None))[1]
            rvol = round(vol / avg, 1) if vol and avg else None
            chg = q.get("chg_pct")
            moving = (chg is not None and abs(chg) >= r["min_move_pct"]) or (rvol or 0) >= 2
            best = its[0]
            liquid = max(vol or 0, avg or 0) >= r["min_volume"]
            rows.append({
                "symbol": s, "name": li.get("name"), "sector": li.get("sector"),
                "last": q.get("last"), "prev": q.get("prev"), "chg_pct": chg, "gap_pct": q.get("gap_pct"),
                "premarket": q.get("premarket"), "volume": vol, "avg_volume": avg, "rvol": rvol, "cap": cap,
                "tier": best["tier"], "tag": best["tag"], "headline": best["headline"], "url": best["url"],
                "t": best["dt"].isoformat(timespec="minutes"),
                "more": [{"t": x["dt"].isoformat(timespec="minutes"), "tier": x["tier"], "tag": x["tag"],
                          "headline": x["headline"], "url": x["url"]} for x in its[1:6]],
                "count": len(its), "moving": moving,
                "screen": (cap is None or cap >= r["min_market_cap"]) and liquid
                          and (best["tier"] in ("binary", "big", "milestone") or moving),
                "score": round(WEIGHT[best["tier"]] * (1 + abs(chg or 0) / 5) * (1 + min(rvol or 0, 5) / 5), 3),
            })
        rows.sort(key=lambda x: x["score"], reverse=True)
        self.view = {"since": since.isoformat(timespec="minutes"), "updated": now.isoformat(timespec="seconds"),
                     "articles": len(self.items), "rules": {k: r[k] for k in ("min_market_cap", "min_volume", "min_move_pct")},
                     "rows": rows[:300]}
        if self.feed:
            self.feed.set_extra([x["symbol"] for x in rows if x["screen"] and x["moving"]][:8])
