import io
import json
import unittest
from contextlib import redirect_stdout

from timing import request, stage, measured, TimedCallable


class Tests(unittest.TestCase):
    def test_logs_aggregate_nested_work_and_exclude_values(self):
        out = io.StringIO()
        request_id = "c804eaff-f7c2-40ab-a459-ba461b33c3bd"
        private = "PRIVATE_IMAGE_OCR_ACCOUNT_TOKEN"
        with redirect_stdout(out), request(request_id, True):
            for _ in range(4):
                self.assertEqual(measured("ocr.crops", lambda: private), private)
            with self.assertRaises(RuntimeError):
                measured("visual.search", lambda: (_ for _ in ()).throw(RuntimeError(private)))
        self.assertNotIn(private, out.getvalue())
        logs = [json.loads(line)["recognitionTiming"] for line in out.getvalue().splitlines()]
        self.assertEqual(len(logs), 2)
        self.assertTrue(logs[0]["modelsReady"])
        self.assertEqual(logs[1]["requestId"], request_id)
        self.assertEqual(logs[1]["stages"]["ocr.crops"]["calls"], 4)
        self.assertFalse(logs[1]["stages"]["visual.search"]["ok"])
        self.assertEqual(logs[0]["processId"], logs[1]["processId"])

    def test_hanging_startup_is_visible_before_completion_and_labels_are_closed(self):
        out = io.StringIO()
        with redirect_stdout(out), request("untrusted owner value", False):
            with stage("visual.catalog"):
                self.assertIn('"stage-start"', out.getvalue())
            with self.assertRaises(ValueError):
                with stage("PRIVATE_IMAGE_OCR_ACCOUNT_TOKEN"):
                    pass
        self.assertNotIn("untrusted owner value", out.getvalue())
        self.assertNotIn("PRIVATE_IMAGE_OCR_ACCOUNT_TOKEN", out.getvalue())

    def test_provider_session_wrapper_preserves_methods_and_results(self):
        class Session:
            value = 3
            def run(self, x):
                return x + self.value
        with redirect_stdout(io.StringIO()), request():
            timed = TimedCallable(Session(), "visual.detect_inference")
            self.assertEqual(timed.value, 3)
            self.assertEqual(timed.run(4), 7)
