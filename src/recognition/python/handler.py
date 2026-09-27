"""API Gateway HTTP API adapter, isolated evaluation deployment only."""

import base64, binascii, hashlib, io, json, os, threading
from pathlib import Path
from PIL import Image, UnidentifiedImageError
from timing import measured

MAX_BYTES = 524288
MAX_PIXELS = 4000000
_lock = threading.Lock()
_engine = None
_independent = None


def response(code, data):
    return {
        "statusCode": code,
        "headers": {"content-type": "application/json", "cache-control": "no-store"},
        "body": json.dumps(data),
    }


def handle(event, engine, create_engine=None):
    # Only trusted API Gateway authorizer context is accepted, never a body owner.
    owner = (
        event.get("requestContext", {})
        .get("authorizer", {})
        .get("jwt", {})
        .get("claims", {})
        .get("sub")
    )
    if not isinstance(owner, str) or not owner:
        return response(401, {"error": "Sign in to scan"})
    if (
        event.get("isBase64Encoded")
        or not isinstance(event.get("body"), str)
        or len(event["body"]) > 710000
    ):
        return response(413, {"error": "Image request too large"})
    return process_body(event["body"], engine, create_engine)


def process_body(body, engine, create_engine=None):
    """Image contract shared by authenticated HTTP API and private SageMaker."""
    if not isinstance(body, str) or len(body) > 710000:
        return response(413, {"error": "Image request too large"})
    try:
        payload = json.loads(body)
        if (
            not isinstance(payload, dict)
            or set(payload) - {"image", "attempt"}
            or not isinstance(payload.get("image"), str)
        ):
            return response(400, {"error": "Invalid image request"})
        if (
            not isinstance(payload.get("attempt"), int)
            or isinstance(payload["attempt"], bool)
            or not 1 <= payload["attempt"] <= 100000
        ):
            return response(400, {"error": "Invalid attempt"})
        raw = base64.b64decode(payload["image"], validate=True)
        if not raw or len(raw) > MAX_BYTES:
            return response(413, {"error": "Image request too large"})
        with Image.open(io.BytesIO(raw)) as image:
            if (
                image.format not in ("JPEG", "PNG")
                or image.width * image.height > MAX_PIXELS
                or min(image.size) < 100
            ):
                return response(
                    400, {"error": "Unsupported image dimensions or format"}
                )
            measured("image.decode", image.load)
            rgb = measured("image.decode", image.convert, "RGB")
    except (
        ValueError,
        TypeError,
        KeyError,
        binascii.Error,
        UnidentifiedImageError,
        OSError,
        Image.DecompressionBombError,
    ):
        return response(400, {"error": "Invalid image"})
    if not _lock.acquire(blocking=False):
        rgb.close()
        return response(429, {"error": "Scanner busy. Retry this card"})
    try:
        if engine is None and create_engine is not None:
            engine = create_engine()
        result = measured("recognize.total", engine.recognize, rgb)
        return response(200, {"attempt": payload["attempt"], **result})
    except Exception:
        # No pixels, raw OCR, tokens or provider exceptions in logs/responses.
        return response(503, {"error": "Recognition unavailable. Retry this card"})
    finally:
        rgb.close()
        _lock.release()


def get_engine():
    global _engine
    if _engine is None:
        from composition import create_service

        _engine = create_service()
    return _engine


def get_independent():
    global _independent
    if _independent is None:
        from composition import create_independent_service
        _independent = create_independent_service()
    return _independent


def handler(event, context):
    if (
        not event.get("requestContext", {})
        .get("authorizer", {})
        .get("jwt", {})
        .get("claims", {})
        .get("sub")
    ):
        return response(401, {"error": "Sign in to scan"})
    if event.get("routeKey") == "GET /api/recognition/source":
        try:
            source = Path(__file__).with_name("source.zip").read_bytes()
            return {
                "statusCode": 200,
                "headers": {
                    "content-type": "application/zip",
                    "content-disposition": 'attachment; filename="keeper-recognition-source.zip"',
                    "cache-control": "no-store",
                    "x-keeper-source-sha256": hashlib.sha256(source).hexdigest(),
                    "x-keeper-recognition-version": os.environ.get("AWS_LAMBDA_FUNCTION_VERSION", "$LATEST"),
                },
                "isBase64Encoded": True,
                "body": base64.b64encode(source).decode(),
            }
        except OSError:
            return response(503, {"error": "Recognition source download unavailable"})
    return handle(event, None, get_independent if event.get("routeKey") == "POST /api/recognize-independent" else get_engine)
