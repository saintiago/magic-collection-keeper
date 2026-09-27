import unittest
from service import RecognitionService
from policy import decide

CARD = {
    "id": "00000000-0000-4000-8000-000000000001",
    "oracle_id": "00000000-0000-4000-8000-000000000002",
    "name": "Sol Ring",
    "set": "cmm",
    "collector_number": "396",
    "lang": "en",
    "finishes": ["nonfoil"],
}


class Visual:
    version = {"adapter": "fake-cosine", "model": "v1"}

    def inspect(self, image):
        return {
            "identity_supported": True,
            "candidates": [CARD],
            "confirmation_calibrated": True,
            "evidence": {"scoreKind": "cosine", "score": 0.9},
        }


class AlternateVisual:
    version = {"adapter": "fake-distance", "model": "v9"}

    def inspect(self, image):
        return {
            "identity_supported": True,
            "candidates": [CARD],
            "confirmation_calibrated": True,
            "evidence": {"scoreKind": "distance", "score": 3},
        }


class Text:
    version = {"adapter": "fake-text", "model": "v2"}

    def read(self, image, corners):
        return {
            "title": ["Sol Ring"],
            "footer": ["CMM 0396 EN"],
            "confirmation_calibrated": True,
        }


class BrokenText(Text):
    def read(self, *args):
        raise RuntimeError("sensitive provider detail")


class BrokenVisual(Visual):
    def inspect(self, *args):
        raise RuntimeError("sensitive provider detail")


class ContractTests(unittest.TestCase):
    def test_translated_whole_title_and_separated_numeric_mana(self):
        card = {**CARD, "name": "Translated Example"}
        visual = {"identity_supported": False, "candidates": [card], "corners": [[0, 0], [1, 0], [1, 1], [0, 1]], "evidence": {"topScore": .68, "differentIdentityMargin": .2}}
        aliases = [["Ejemplo traducido", "es"]]
        result = decide(visual, {"title": ["Ejemplo traducido", "3"]}, aliases=aliases)
        self.assertEqual(result["status"], "possible")
        self.assertEqual(result["evidence"]["titleLanguage"], "es")
        for title in ["Ejemplo", "Ejemplo traducida", "Ejemplo traducido other", "Ejemplo traducido3"]:
            self.assertEqual(decide(visual, {"title": [title]}, aliases=aliases)["status"], "unknown")
        self.assertEqual(decide(visual, {"title": ["Ejemplo traducido"]})["status"], "unknown")

    def test_title_corroboration_requires_exact_independent_title_and_visual_margin(self):
        card = {**CARD, "name": "Shaun, Father of Synths", "set": "pip", "collector_number": "119"}
        visual = {"identity_supported": False, "candidates": [card], "corners": [[0, 0], [1, 0], [1, 1], [0, 1]], "evidence": {"topScore": .67, "differentIdentityMargin": .22}}
        text = {"title": ["Shaun. Father of Synths"], "footer": ["R0119", "PIP-EN"]}
        result = decide(visual, text)
        self.assertEqual(result["status"], "possible")
        self.assertTrue(result["evidence"]["identityTitleCorroborated"])
        self.assertEqual(result["evidence"]["exactPrintingId"], card["id"])
        self.assertIsNone(result["selected"])
        for wrong in [[], ["Shaun Father of Synth"], ["Sol Ring"], ["Shaun", "Unrelated text"]]:
            self.assertEqual(decide(visual, {"title": wrong})["status"], "unknown")
        for field, value in [("topScore", .59), ("differentIdentityMargin", .11)]:
            weak = {**visual, "evidence": {**visual["evidence"], field: value}}
            self.assertEqual(decide(weak, text)["status"], "unknown")
        self.assertEqual(decide({**visual, "corners": None}, text)["status"], "unknown")

    def test_interchangeable_visual_score_scales(self):
        for visual in (Visual(), AlternateVisual()):
            r = RecognitionService(visual, Text()).recognize(None)
            self.assertEqual(r["status"], "possible")
            self.assertIsNone(r["selected"])
            self.assertEqual(r["candidates"], [CARD])
            self.assertEqual(r["versions"]["visual"], visual.version)

    def test_no_acceptance_without_every_calibration_gate(self):
        visual = Visual().inspect(None)
        text = Text().read(None, None)
        self.assertEqual(
            decide(visual, text, allow_confirmed=True)["status"], "confirmed"
        )
        for key in ("visual", "text"):
            v, t = dict(visual), dict(text)
            (v if key == "visual" else t)["confirmation_calibrated"] = False
            self.assertEqual(decide(v, t, allow_confirmed=True)["status"], "possible")
        text["footer"] = ["CMM 039S EN"]
        self.assertEqual(
            decide(visual, text, allow_confirmed=True)["status"], "possible"
        )

    def test_adapter_failures_and_missing_identity(self):
        r = RecognitionService(BrokenVisual(), Text()).recognize(None)
        self.assertEqual(r["status"], "unknown")
        self.assertEqual(r["candidates"], [])
        r = RecognitionService(Visual(), BrokenText()).recognize(None)
        self.assertEqual(r["status"], "possible")
        self.assertIsNone(r["selected"])
        self.assertNotIn("sensitive", str(r))
        self.assertEqual(
            decide({"identity_supported": False, "candidates": [CARD]}, {})["status"],
            "unknown",
        )


if __name__ == "__main__":
    unittest.main()
