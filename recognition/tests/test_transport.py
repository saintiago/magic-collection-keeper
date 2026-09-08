import unittest, json, base64, io, sys
from pathlib import Path
from PIL import Image
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import handler


class Tests(unittest.TestCase):
    def test_invalid_request_never_initializes_models(self):
        event = self.event()
        event["body"] = "{}"
        with patch.object(handler, "get_engine") as create:
            self.assertEqual(handler.handler(event, None)["statusCode"], 400)
            event["body"] = "x" * 710001
            self.assertEqual(handler.handler(event, None)["statusCode"], 413)
            create.assert_not_called()

    def test_initialization_failure_is_sanitized_and_retryable(self):
        with patch.object(
            handler, "get_engine", side_effect=RuntimeError("private detail")
        ):
            result = handler.handler(self.event(), None)
        self.assertEqual(result["statusCode"], 503)
        self.assertNotIn("private detail", result["body"])
        self.assertFalse(handler._lock.locked())

    def test_source_offer_requires_auth_and_does_not_initialize_models(self):
        event = self.event()
        event["routeKey"] = "GET /api/recognition/source"
        with patch.object(handler.Path, "read_bytes", return_value=b"PK-test-source"):
            result = handler.handler(event, None)
        self.assertEqual(result["statusCode"], 200)
        self.assertEqual(base64.b64decode(result["body"]), b"PK-test-source")
        self.assertEqual(result["headers"]["content-type"], "application/zip")
        event["requestContext"] = {}
        self.assertEqual(handler.handler(event, None)["statusCode"], 401)

    def test_dimensions_and_boolean_attempt_rejected(self):
        event = self.event()
        payload = json.loads(event["body"])
        payload["attempt"] = True
        event["body"] = json.dumps(payload)
        self.assertEqual(handler.handle(event, None)["statusCode"], 400)
        buf = io.BytesIO()
        Image.new("RGB", (3000, 2000)).save(buf, format="PNG")
        payload["attempt"] = 1
        payload["image"] = base64.b64encode(buf.getvalue()).decode()
        event["body"] = json.dumps(payload)
        self.assertEqual(handler.handle(event, None)["statusCode"], 400)

    def event(self):
        buf = io.BytesIO()
        Image.new("RGB", (200, 300)).save(buf, format="JPEG")
        return {
            "requestContext": {
                "authorizer": {"jwt": {"claims": {"sub": "isolated-test-owner"}}}
            },
            "body": json.dumps(
                {"image": base64.b64encode(buf.getvalue()).decode(), "attempt": 1}
            ),
        }

    def test_auth_and_body_owner(self):
        engine = type(
            "Engine", (), {"recognize": lambda _, img: {"status": "unknown"}}
        )()
        self.assertEqual(handler.handle({"body": "{}"}, engine)["statusCode"], 401)
        e = self.event()
        e["body"] = '{"owner":"spoof","image":"x","attempt":1}'
        self.assertEqual(handler.handle(e, engine)["statusCode"], 400)

    def test_limits_bad_image(self):
        e = self.event()
        e["body"] = "x" * 710001
        self.assertEqual(handler.handle(e, None)["statusCode"], 413)
        e = self.event()
        e["body"] = '{"image":"not_base64","attempt":1}'
        self.assertEqual(handler.handle(e, None)["statusCode"], 400)

    def test_busy_failure_and_release(self):
        e = self.event()
        handler._lock.acquire()
        try:
            self.assertEqual(handler.handle(e, None)["statusCode"], 429)
        finally:
            handler._lock.release()
        self.assertEqual(handler.handle(e, None)["statusCode"], 503)
        self.assertFalse(handler._lock.locked())

    def test_no_retention_or_owner_passed(self):
        received = []
        engine = type(
            "Engine",
            (),
            {
                "recognize": lambda _, img: received.append(img.size)
                or {"status": "unknown"}
            },
        )()
        r = handler.handle(self.event(), engine)
        self.assertEqual(r["statusCode"], 200)
        self.assertEqual(received, [(200, 300)])
        self.assertNotIn("isolated-test-owner", r["body"])


if __name__ == "__main__":
    unittest.main()
