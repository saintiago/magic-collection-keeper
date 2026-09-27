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
    from adapters.title_names import load_title_names
    fallback = None
    model = os.environ.get("KEEPER_TITLE_MODEL", "")
    if model:
        if model != "amazon.nova-lite-v1:0":
            raise ValueError("Unreviewed title model")
        import boto3
        from botocore.config import Config
        from adapters.bedrock_title import BedrockTitle
        client = boto3.client("bedrock-runtime", region_name="us-east-1", config=Config(connect_timeout=1, read_timeout=5, retries={"total_max_attempts": 1}))
        fallback = BedrockTitle(client, model)
    return RecognitionService(visual, ocr, names=load_title_names(root), fallback=fallback, allow_confirmed=False)


def create_service():
    return measured("prepare.total", _create_service)


def create_independent_service():
    import boto3
    import cv2
    import numpy as np
    import collector_vision as cv
    from botocore.config import Config
    from adapters.bedrock_identity import BedrockIdentity
    from adapters.card_regions import inspect_regions
    from adapters.title_names import load_identity_catalog
    from independent_service import IndependentRecognitionService
    model = os.environ.get("KEEPER_IDENTITY_MODEL", "")
    if model != "amazon.nova-pro-v1:0":
        raise ValueError("Independent recognizer is not configured")
    root = Path(os.environ.get("RECOGNITION_ARTIFACTS", "recognition/artifacts"))
    # Same verified geometry checkpoint; no artwork model or candidate search.
    import hashlib
    manifest = json.loads((root / "artifact-manifest.json").read_text())
    checkpoint = root / "weights/cornelius.onnx"
    if hashlib.sha256(checkpoint.read_bytes()).hexdigest() != manifest["models"]["cornelius.onnx"]:
        raise ValueError("Card geometry digest mismatch")
    detector = cv.NeuralCornerDetector(checkpoint=checkpoint,provider="cpu",num_threads=2)
    canonical, aliases = load_identity_catalog(root)
    client = boto3.client("bedrock-runtime",region_name="us-east-1",config=Config(connect_timeout=1,read_timeout=5,retries={"total_max_attempts":1}))
    return IndependentRecognitionService(BedrockIdentity(client,model),lambda image:inspect_regions(cv2.cvtColor(np.asarray(image),cv2.COLOR_RGB2BGR),detector),canonical,aliases)
