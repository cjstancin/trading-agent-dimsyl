"""FOMC statement parsing on the two formats the Fed has used (text from real statements)."""
import unittest

from bull.fed import parse, score

WRAP = '<div class="col-xs-12 col-sm-8 col-md-8">{}<div class="col-xs-12 col-sm-4">'

NEW_2026_07 = WRAP.format("".join(f"<p>{p}</p>" for p in [
    "The Federal Open Market Committee approved the following statement for release by a 9 – 3 vote:",
    "The Committee decided to maintain the target range for the federal funds rate at 3-1/2 to 3-3/4 percent, in support "
    "of the Federal Reserve's dual mandate. The Committee is continuing its policy of maintaining ample reserves.",
    "Inflation remains elevated relative to the Committee's 2 percent goal. The Committee will deliver price stability.",
    "Voting against the monetary policy action were Beth M. Hammack, Neel Kashkari, and Lorie K. Logan, who preferred to "
    "raise the target range for the federal funds rate by 1/4 percentage point at this meeting.",
]))
NEW_2026_09 = WRAP.format("".join(f"<p>{p}</p>" for p in [
    "The Federal Open Market Committee approved the following statement for release by a 12 – 0 vote:",
    "The Committee decided to raise the target range for the federal funds rate by 1/4 percentage point to 3-3/4 to 4 "
    "percent, in support of the Federal Reserve's dual mandate. The Committee is continuing its policy of maintaining ample reserves.",
    "Inflation remains elevated. Today's policy action will support a timelier return to the Committee's 2 percent goal.",
]))
OLD_2025_09 = WRAP.format("".join(f"<p>{p}</p>" for p in [
    "In support of its goals, the Committee decided to lower the target range for the federal funds rate by 1/4 "
    "percentage point to 4 to 4‑1/4 percent. The Committee will carefully assess incoming data.",
    "Voting for the monetary policy action were Jerome H. Powell, Chair; John C. Williams, Vice Chair; Michael S. Barr. "
    "Voting against this action was Stephen I. Miran, who preferred to lower the target range for the federal funds "
    "rate by 1/2 percentage point at this meeting.",
]))


class FedParseTests(unittest.TestCase):
    def test_new_format_hawkish_dissents(self):
        p = parse(NEW_2026_07)
        self.assertEqual((p["decision"], p["upper"], p["vote"]), ("maintain", 3.75, "9-3"))
        self.assertEqual(p["dissents"][0]["n"], 3)
        s = score(p, None)
        self.assertEqual((s["change_bp"], s["hawk"], s["dove"], s["lean_label"]), (0, 3, 0, "HAWKISH"))

    def test_hike_after_dissents_and_sentence_diff(self):
        prev = parse(NEW_2026_07)
        prev.update(score(prev, None))
        cur = parse(NEW_2026_09)
        s = score(cur, prev)
        self.assertEqual((s["change_bp"], s["hawk"], s["lean_label"]), (25, 0, "DOVISH"))  # the hawks got their hike
        self.assertTrue(any("raise" in c["new"] for c in s["changed"]))

    def test_old_format_dovish_dissent(self):
        p = parse(OLD_2025_09)
        self.assertEqual((p["decision"], p["upper"]), ("lower", 4.25))
        s = score(p, None)
        self.assertEqual((s["change_bp"], s["hawk"], s["dove"]), (-25, 0, 1))  # Miran wanted -50 vs -25


if __name__ == "__main__":
    unittest.main()
