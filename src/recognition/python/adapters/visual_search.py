"""Full-reference identity margin, independent of how many reprints rank first."""

import numpy as np


def rank_identity(scores, identities, limit=5):
    if len(scores) == 0:
        return [], 1.0
    count = min(limit, len(scores))
    indices = np.argpartition(scores, -count)[-count:]
    indices = indices[np.argsort(scores[indices])[::-1]]
    identity = identities[indices[0]]
    competing = scores[identities != identity]
    other = float(np.max(competing)) if len(competing) else -1.0
    return [int(index) for index in indices], other


def supported(score, other):
    # Uncalibrated research thresholds admit optional review only.
    return score >= 0.8 and score - other >= 0.08
