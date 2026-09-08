"""Offline runtime smoke; not an accuracy or physical-device test."""

import json
import resource
import socket
import time
import sys
import os
from pathlib import Path
from PIL import Image
import numpy as np

network_attempts = []


def denied(*args, **kwargs):
    network_attempts.append(True)
    raise RuntimeError("Runtime network access forbidden in smoke test")


socket.socket.connect = denied
started = time.perf_counter()
from composition import create_service

service = create_service()
assert os.environ.get("ORT_DISABLE_TELEMETRY") == "1"
initialized = time.perf_counter()
results = []
for _ in range(3):
    result = service.recognize(Image.new("RGB", (600, 800), "white"))
    assert result["status"] == "unknown" and result["selected"] is None
    assert result["reason"] != "visual_unavailable", result
    results.append(result["timings"])
text_started = time.perf_counter()
text = service.ocr.read(
    Image.new("RGB", (600, 800), "white"),
    np.array([[0, 0], [1, 0], [1, 1], [0, 1]], dtype=np.float32),
)
assert isinstance(text["title"], list) and isinstance(text["footer"], list)
text_elapsed = (time.perf_counter() - text_started) * 1000
with Image.open(Path("artifacts/public-card-frame.jpg")) as frame:
    positive = service.recognize(frame.convert("RGB"))
assert positive["status"] == "possible" and positive["selected"] is None, positive
assert positive["candidates"][0]["name"] == "Adaptive Training Post", positive
assert positive["evidence"]["text"].get("titleRead"), positive
assert "error" not in positive["evidence"]["text"], positive
assert not network_attempts, "Runtime attempted network access"
assert "paddle" not in sys.modules and "paddlex" not in sys.modules
print(
    json.dumps(
        {
            "publicCard": {
                "status": positive["status"],
                "reason": positive["reason"],
                "timings": positive["timings"],
            }
        }
    )
)
print(json.dumps({"ocrBlankRegionsMs": text_elapsed}))
print(
    json.dumps(
        {
            "initializationMs": (initialized - started) * 1000,
            "blankFrameTimings": results,
            "maxRssKiB": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
            "physicalDeviceVerified": False,
        }
    )
)
