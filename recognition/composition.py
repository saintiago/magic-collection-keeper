"""Concrete composition, selected only by service configuration. SPDX-License-Identifier: AGPL-3.0-only"""

import os
import json
from time import perf_counter
import importlib
import sys
from timing import stage, measured

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
    for module in ("numpy", "cv2", "onnxruntime", "collector_vision", "rapidocr"):
        if module not in sys.modules:
            measured("import." + module, importlib.import_module, module)
    with stage("import.visual_adapter"):
        from adapters.collectorvision import CollectorVision

    if ocr_name == "paddle":
        from adapters.paddle import PaddleText
    else:
        with stage("import.ocr_adapter"):
            from adapters.paddle_onnx import PaddleOnnxText as PaddleText

    return CollectorVision, PaddleText


def _create_service():
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


def create_service():
    return measured("prepare.total", _create_service)
