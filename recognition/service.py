"""Application pipeline over independent visual/OCR ports. SPDX-License-Identifier: AGPL-3.0-only"""

from time import perf_counter
from policy import decide


class RecognitionService:
    def __init__(self, visual, ocr, *, allow_confirmed=False):
        self.visual = visual
        self.ocr = ocr
        self.allow_confirmed = allow_confirmed

    def recognize(self, image):
        started = perf_counter()
        timings = {}
        versions = {"visual": self.visual.version, "ocr": self.ocr.version}
        try:
            step = perf_counter()
            visual = self.visual.inspect(image)
            timings["visualMs"] = (perf_counter() - step) * 1000
        except Exception:
            return self._failure("visual_unavailable", started, timings, versions)
        if not visual.get("identity_supported"):
            result = decide(visual, {}, allow_confirmed=False)
        else:
            try:
                step = perf_counter()
                text = self.ocr.read(image, visual.get("corners"))
                timings["ocrMs"] = (perf_counter() - step) * 1000
            except Exception:
                text = {
                    "title": [],
                    "footer": [],
                    "evidence": {"error": "ocr_unavailable"},
                }
            result = decide(visual, text, allow_confirmed=self.allow_confirmed)
        timings["totalMs"] = (perf_counter() - started) * 1000
        return {**result, "versions": versions, "timings": timings}

    @staticmethod
    def _failure(reason, started, timings, versions):
        return {
            "contractVersion": 1,
            "status": "unknown",
            "candidates": [],
            "selected": None,
            "reason": reason,
            "evidence": {},
            "versions": versions,
            "timings": {**timings, "totalMs": (perf_counter() - started) * 1000},
        }
