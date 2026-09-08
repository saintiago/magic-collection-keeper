"""Exercise the actual private HTTP container; no customer pictures or hardware."""

import base64
import json
import time
import urllib.request
from pathlib import Path

root = "http://127.0.0.1:8080"
started = time.monotonic()
while time.monotonic() - started < 120:
    try:
        with urllib.request.urlopen(root + "/ping", timeout=2) as response:
            assert response.status == 200
        break
    except OSError:
        time.sleep(0.5)
else:
    raise RuntimeError("SageMaker container did not become healthy")
ready_ms = (time.monotonic() - started) * 1000
body = json.dumps(
    {
        "image": base64.b64encode(
            Path("artifacts/public-card-frame.jpg").read_bytes()
        ).decode(),
        "attempt": 1,
    }
).encode()
request = urllib.request.Request(
    root + "/invocations", data=body, headers={"Content-Type": "application/json"}
)
started = time.monotonic()
with urllib.request.urlopen(request, timeout=60) as response:
    result = json.load(response)
assert result["status"] == "possible" and result["selected"] is None
assert result["candidates"][0]["id"] == "4796e5e4-515c-4d89-92da-b2d5b5b39557"
assert result["evidence"]["text"]["titleRead"]
print(
    json.dumps(
        {
            "containerHealthWaitMs": ready_ms,
            "httpInferenceMs": (time.monotonic() - started) * 1000,
            "status": result["status"],
            "physicalDeviceVerified": False,
        }
    )
)
