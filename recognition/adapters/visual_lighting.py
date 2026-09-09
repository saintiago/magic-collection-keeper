"""Bounded exposure and highlight white-balance variants. SPDX-License-Identifier: AGPL-3.0-only"""
import numpy as np
from PIL import Image


def lighting_variants(crop):
    pixels = np.asarray(crop).astype(float)
    mean = max(1, pixels.mean())
    gamma = float(np.clip(np.log(110 / 255) / np.log(min(254, mean) / 255), .65, 1.5))
    high = np.percentile(pixels, 95, axis=(0, 1), method="lower")
    gains = np.clip(high.mean() / np.maximum(high, 1), .65, 1.6)
    variants = []
    if abs(gamma - 1) > .05:
        variants.append(("exposure", Image.fromarray(np.clip(255 * (pixels / 255) ** gamma, 0, 255).astype("uint8"))))
    if float(gains.max() - gains.min()) > .08:
        variants.append(("highlight_balance", Image.fromarray(np.clip(pixels * gains, 0, 255).astype("uint8"))))
    return variants
