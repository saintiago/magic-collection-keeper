"""Frozen Paddle text weights on ONNX CPU. SPDX-License-Identifier: AGPL-3.0-only"""

import hashlib
import json
from pathlib import Path

import cv2
import numpy as np
import rapidocr
from rapidocr.ch_ppocr_det import TextDetector
from rapidocr.ch_ppocr_rec import TextRecInput, TextRecognizer
from rapidocr.utils.log import logger
from rapidocr.utils.parse_parameters import ParseParams
from rapidocr.utils.process_img import get_rotate_crop_image


class PaddleOnnxText:
    def __init__(self, root):
        manifest = json.loads((root / "ocr-onnx.json").read_text())
        folder = root / "ocr-onnx"
        for filename, digest in manifest["files"].items():
            if hashlib.sha256((folder / filename).read_bytes()).hexdigest() != digest:
                raise ValueError("Text model digest mismatch")
        logger.setLevel("ERROR")
        cfg = ParseParams.load(Path(rapidocr.__file__).with_name("config.yaml"))
        engine = cfg.EngineConfig.onnxruntime
        engine.intra_op_num_threads = 2
        engine.inter_op_num_threads = 1
        cfg.Det.engine_cfg = engine
        cfg.Det.model_path = str(folder / "det.onnx")
        cfg.Det.limit_type = "max"
        cfg.Det.limit_side_len = 960
        cfg.Det.mean = [0.485, 0.456, 0.406]
        cfg.Det.std = [0.229, 0.224, 0.225]
        cfg.Det.box_thresh = 0.6
        cfg.Det.unclip_ratio = 1.5
        cfg.Det.use_dilation = False
        cfg.Rec.engine_cfg = engine
        cfg.Rec.model_path = str(folder / "rec.onnx")
        cfg.Rec.rec_keys_path = str(folder / "latin.txt")
        cfg.Rec.lang_type = "latin"
        cfg.Rec.font_path = None
        cfg.Rec.rec_batch_num = 2
        self.detector = TextDetector(cfg.Det)
        self.recognizer = TextRecognizer(cfg.Rec)
        self.version = {
            "adapter": "paddle-onnx",
            "runtime": "onnxruntime-1.29.0",
            "processing": "rapidocr-3.9.2",
            "weights": manifest,
            "calibration": "research-onnx-text-v1-not-approved",
        }

    def read(self, image, corners):
        bgr = cv2.cvtColor(np.asarray(image), cv2.COLOR_RGB2BGR)
        h, w = bgr.shape[:2]
        points = np.asarray(corners, dtype=np.float32) * np.array(
            [w, h], dtype=np.float32
        )
        target = np.array([[0, 0], [799, 0], [799, 1119], [0, 1119]], dtype=np.float32)
        flat = cv2.warpPerspective(
            bgr, cv2.getPerspectiveTransform(points, target), (800, 1120)
        )
        regions = []
        for start, end in ((0.02, 0.12), (0.92, 1)):
            region = flat[int(1120 * start) : int(1120 * end), :]
            boxes = self.detector(region).boxes
            if boxes is None or len(boxes) == 0:
                regions.append([])
                continue
            # Only bounded title/footer regions and at most 16 detected lines.
            crops = [get_rotate_crop_image(region, box.copy()) for box in boxes[:16]]
            result = self.recognizer(TextRecInput(img=crops))
            regions.append(
                [
                    text
                    for text, score in zip(result.txts, result.scores)
                    if score >= 0.8
                ]
            )
        return {
            "title": regions[0],
            "footer": regions[1],
            "confirmation_calibrated": False,
            "evidence": {
                "calibration": self.version["calibration"],
                "titleRead": bool(regions[0]),
                "footerRead": bool(regions[1]),
            },
        }
