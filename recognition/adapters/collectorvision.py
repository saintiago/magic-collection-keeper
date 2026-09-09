"""CollectorVision model/catalog adapter. SPDX-License-Identifier: AGPL-3.0-only"""

import hashlib, json
import cv2, numpy as np
import collector_vision as cv
import onnxruntime as ort
from timing import measured, stage, TimedCallable
from adapters.visual_search import rank_identity, supported

ort.disable_telemetry_events()


class CollectorVision:
    def __init__(self, root):
        manifest = json.loads((root / "artifact-manifest.json").read_text())
        weights = root / "weights"
        with stage("visual.files"):
            for name, sha in manifest["models"].items():
                if hashlib.sha256((weights / name).read_bytes()).hexdigest() != sha:
                    raise ValueError("Visual model digest mismatch")
        self.catalog = measured(
            "visual.catalog",
            cv.Catalog.load,
            "mtg",
            cache_dir=root / "catalog",
            offline=True,
        )
        if (
            self.catalog.version != manifest["catalog"]["version"]
            or self.catalog.embedding_model != manifest["catalog"]["embedding"]
        ):
            raise ValueError("Incompatible model/catalog version")
        self.detector = measured(
            "visual.detector_session",
            cv.NeuralCornerDetector,
            checkpoint=weights / "cornelius.onnx",
            provider="cpu",
            num_threads=2,
        )
        self.embedder = measured(
            "visual.embedder_session",
            cv.NeuralEmbedder,
            checkpoint=weights / "milo.onnx",
            provider="cpu",
            num_threads=2,
        )
        self.detector._sess = TimedCallable(
            self.detector._sess, "visual.detect_inference"
        )
        self.embedder._sess = TimedCallable(
            self.embedder._sess, "visual.embed_inference"
        )
        self.version = {
            "adapter": "collectorvision",
            "code": manifest["code"],
            "models": manifest["models"],
            "catalog": manifest["catalog"],
            "calibration": "research-cosine-v1-not-approved",
            "processing": "keeper-visual-v2-rotation-reference-margin",
        }
        self.identities = np.array(
            [
                record.identifiers.get("scryfall_oracle")
                for record in self.catalog.records
            ],
            dtype=object,
        )

    def search(self, embedding):
        scores = self.catalog.embeddings @ embedding
        indices, other = rank_identity(scores, self.identities)
        return [
            self.catalog.record_for_index(i, score=float(scores[i])) for i in indices
        ], other

    def inspect(self, image):
        with stage("visual.preprocess"):
            bgr = cv2.cvtColor(np.asarray(image), cv2.COLOR_RGB2BGR)
        found = measured("visual.detect", self.detector.detect, bgr)
        result = {
            "identity_supported": False,
            "candidates": [],
            "confirmation_calibrated": False,
            "evidence": {
                "scoreKind": "cosine_similarity",
                "isProbability": False,
                "calibration": self.version["calibration"],
            },
        }
        if not found.card_present:
            return result
        h, w = bgr.shape[:2]
        pts = found.corners * np.array([w, h], dtype=np.float32)
        area = abs(cv2.contourArea(pts)) / (w * h)
        if not 0.12 < area < 0.98 or not cv2.isContourConvex(pts):
            return result
        crop = measured("visual.dewarp", found.dewarp, bgr)
        embedding = measured("visual.embed", self.embedder.embed, crop)
        matches, other = measured("visual.search", self.search, embedding)
        if not matches:
            return result
        orientation = "upright"
        corners = found.corners
        if not supported(matches[0]["score"], other):
            opposite = measured(
                "visual.embed", self.embedder.embed, crop.rotate(180)
            )
            alternative, alternative_other = measured(
                "visual.search", self.search, opposite
            )
            if alternative and alternative[0]["score"] > matches[0]["score"]:
                matches, other = alternative, alternative_other
                corners = np.roll(corners, -2, axis=0)
                orientation = "rotated_180"
        first = matches[0]
        # These conservative research thresholds only admit optional candidates.
        result["identity_supported"] = supported(first["score"], other)
        result["evidence"].update(
            topScore=first["score"],
            differentIdentityMargin=first["score"] - other,
            sharpness=found.sharpness,
            orientation=orientation,
        )
        result["corners"] = corners
        result["candidates"] = [
            {
                "id": x["id"],
                "oracle_id": x["identifiers"].get("scryfall_oracle"),
                "name": x["name"],
                "finishes": x["finishes"],
                **{
                    k: (x.get("metadata") or {}).get(k)
                    for k in ("set", "collector_number", "lang")
                },
            }
            for x in matches
        ]
        return result
