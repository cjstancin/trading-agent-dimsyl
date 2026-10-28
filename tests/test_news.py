"""The catalyst classifier, checked against real headlines from 2026-10-28 (CJ's screener day)."""
import unittest
from datetime import datetime

from bull.config import ET
from bull.news import classify, window_start

CASES = [
    # (headline, symbols, tier, tag)
    ("Geron Corporation To Discontinue Phase 3 IMpactMF Clinical Trial Of Imetelstat In Relapsed/Refractory Myelofibrosis",
     ["GERN"], "binary", "trial result"),
    ("Trading Halt: Halted at 7:55:00 a.m. ET - Trading Halt: Halt News Pending", ["GERN"], "binary", "halt"),
    ("'Nelson Peltz's Trian Offers To Buy Wendy's For $1.4 Billion' - Wall Street Journal", ["WEN"], "binary", "M&A"),
    ("Wendy's 13D Filing Shows Nelson Peltz Reports 16.23% Stake In Co. As Of Oct. 28", ["WEN"], "big", "activist"),
    ("SELLAS Life Sciences Announces Its Pivotal Phase 3 Study Of Galinpepimut-S In Acute Myeloid Leukemia "
     "Participants Surpasses Pre-Specified 80th Event", ["SLS"], "milestone", "trial milestone"),
    ("SELLAS Life Sciences Reaches 80th Event in Phase 3 REGAL Trial", ["SLS"], "milestone", "trial milestone"),
    ("Enphase Energy Q3 Adj. EPS $0.41 Misses $0.51 Estimate, Sales $293.329M Miss $304.042M Estimate",
     ["ENPH"], "big", "earnings"),
    ("Enphase Energy Sees Q4 Sales $225.000M-$255.000M vs $298.389M Est", ["ENPH"], "big", "guidance"),
    ("Oppenheimer Downgrades Enphase Energy to Perform", ["ENPH"], "big", "up/downgrade"),
    ("Susquehanna Maintains Neutral on Enphase Energy, Lowers Price Target to $26", ["ENPH"], "other", "analyst"),
    ("Boston Scientific Lowers FY2026 Adj EPS Guidance from $3.28-$3.32 to $3.16-$3.18 vs $3.23 Est",
     ["BSX"], "big", "guidance"),
    ("Boston Scientific Q3 Adj. EPS $0.73 Beats $0.72 Estimate, Sales $5.138B Beat $5.046B Estimate",
     ["BSX"], "big", "earnings"),
    ("Boston Scientific Q3 2026 Earnings Call Transcript", ["BSX"], "noise", "roundup"),
    ("PacBio Announces Participation in Upcoming Investor Conferences", ["PACB"], "noise", "roundup"),
    ("SELLAS Life Sciences Stock Stumbles: What's Going On?", ["SLS"], "info", "why it moved"),
    ("Braiin (BRAI) Stock Jumps 56% After Hours: What's Behind the Move", ["BRAI"], "info", "why it moved"),
    ("12 Information Technology Stocks Moving In Wednesday's Pre-Market Session",
     ["BKYI", "BRAI", "CETX", "DAIO", "ENPH"], "noise", "roundup"),
    ("Acme Bio Prices $50 Million Public Offering", ["ACME"], "big", "offering"),
    ("FDA Approves Acme's Drug For Rare Disease", ["ACME"], "binary", "FDA"),
    ("Acme To Report Third Quarter Results On November 5", ["ACME"], "milestone", "earnings date"),
]


class ClassifierTests(unittest.TestCase):
    def test_real_headlines(self):
        for headline, syms, tier, tag in CASES:
            with self.subTest(headline=headline[:60]):
                self.assertEqual(classify(headline, syms), (tier, tag))

    def test_window_covers_prior_after_hours(self):
        wed = datetime(2026, 10, 28, 10, 0, tzinfo=ET)
        self.assertEqual(window_start(wed), datetime(2026, 10, 27, 16, 0, tzinfo=ET))
        mon = datetime(2026, 10, 26, 9, 0, tzinfo=ET)  # Monday morning reaches back to Friday 4 PM
        self.assertEqual(window_start(mon), datetime(2026, 10, 23, 16, 0, tzinfo=ET))


if __name__ == "__main__":
    unittest.main()
