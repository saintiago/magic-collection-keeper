import unittest
import numpy as np
from adapters.visual_search import rank_identity, supported


class Tests(unittest.TestCase):
    def test_competing_identity_outside_reprint_top_five(self):
        indices, other = rank_identity(
            np.array([0.95] * 7 + [0.4]), np.array(["a"] * 7 + ["b"])
        )
        self.assertEqual(len(indices), 5)
        self.assertAlmostEqual(other, 0.4)
        self.assertTrue(supported(0.95, other))

    def test_equal_identity_scores_stay_ambiguous(self):
        _, other = rank_identity(np.array([0.95, 0.95]), np.array(["a", "b"]))
        self.assertFalse(supported(0.95, other))
