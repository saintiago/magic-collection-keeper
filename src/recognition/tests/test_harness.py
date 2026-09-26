"""Bootstrap checks for the recognition test harness.

KAN-16 restores the preserved engine regressions into this directory. Until then this module keeps
the Python validation path real instead of passing an empty suite: it proves that
``npm run test:python`` discovers tests, runs them on the documented Python baseline and starts them
from the recognition component root.
"""

import sys
import unittest
from pathlib import Path


class RecognitionHarnessTests(unittest.TestCase):
    def test_runs_on_the_documented_python_baseline(self) -> None:
        self.assertGreaterEqual(sys.version_info[:2], (3, 12), sys.version)

    def test_runs_from_the_recognition_component_root(self) -> None:
        self.assertEqual(Path.cwd().name, "recognition")
        self.assertTrue(Path("tests").is_dir())


if __name__ == "__main__":
    unittest.main()
