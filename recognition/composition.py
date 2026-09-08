"""Concrete composition, selected only by service configuration. SPDX-License-Identifier: AGPL-3.0-only"""

import os
import json
from time import perf_counter

# ONNX 1.29 initializes POSIX telemetry before its runtime API can disable it.
# Opt out before importing either concrete adapter, including outside Docker.
os.environ["ORT_DISABLE_TELEMETRY"] = "1"

from pathlib import Path
from service import RecognitionService


def preload_adapters():
    visual_name = os.environ.get("KEEPER_VISUAL_ADAPTER", "collectorvision")
    ocr_name = os.environ.get("KEEPER_OCR_ADAPTER", "paddle-onnx")
    if visual_name != "collectorvision" or ocr_name not in ("paddle", "paddle-onnx"):
        raise ValueError("Unsupported recognition adapter configuration")
    from adapters.collectorvision import CollectorVision

    if ocr_name == "paddle":
        from adapters.paddle import PaddleText
    else:
        from adapters.paddle_onnx import PaddleOnnxText as PaddleText

    return CollectorVision, PaddleText


def create_service():
    CollectorVision, PaddleText = preload_adapters()

    root = Path(os.environ.get("RECOGNITION_ARTIFACTS", "recognition/artifacts"))
    started = perf_counter()
    print(json.dumps({"recognitionStartup": {"phase": "models-start"}}), flush=True)
    visual = CollectorVision(root)
    print(
        json.dumps(
            {
                "recognitionStartup": {
                    "phase": "visual-ready",
                    "elapsedMs": (perf_counter() - started) * 1000,
                }
            }
        ),
        flush=True,
    )
    ocr = PaddleText(root)
    print(
        json.dumps(
            {
                "recognitionStartup": {
                    "phase": "models-ready",
                    "elapsedMs": (perf_counter() - started) * 1000,
                }
            }
        ),
        flush=True,
    )
    # Confirmations deliberately unavailable in the deployment composition.
    return RecognitionService(visual, ocr, allow_confirmed=False)
