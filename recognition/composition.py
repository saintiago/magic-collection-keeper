"""Concrete composition, selected only by service configuration. SPDX-License-Identifier: AGPL-3.0-only"""

import os

# ONNX 1.29 initializes POSIX telemetry before its runtime API can disable it.
# Opt out before importing either concrete adapter, including outside Docker.
os.environ["ORT_DISABLE_TELEMETRY"] = "1"

from pathlib import Path
from service import RecognitionService


def create_service():
    visual_name = os.environ.get("KEEPER_VISUAL_ADAPTER", "collectorvision")
    ocr_name = os.environ.get("KEEPER_OCR_ADAPTER", "paddle-onnx")
    if visual_name != "collectorvision" or ocr_name not in ("paddle", "paddle-onnx"):
        raise ValueError("Unsupported recognition adapter configuration")
    from adapters.collectorvision import CollectorVision

    if ocr_name == "paddle":
        from adapters.paddle import PaddleText
    else:
        from adapters.paddle_onnx import PaddleOnnxText as PaddleText

    root = Path(os.environ.get("RECOGNITION_ARTIFACTS", "recognition/artifacts"))
    # Confirmations deliberately unavailable in the deployment composition.
    return RecognitionService(
        CollectorVision(root), PaddleText(root), allow_confirmed=False
    )
