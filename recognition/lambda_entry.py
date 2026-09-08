"""On-demand library INIT only. SPDX-License-Identifier: AGPL-3.0-only"""

import json
from time import perf_counter

from composition import preload_adapters

started = perf_counter()
preload_adapters()
print(
    json.dumps(
        {
            "recognitionStartup": {
                "phase": "imports-ready",
                "elapsedMs": (perf_counter() - started) * 1000,
            }
        }
    ),
    flush=True,
)

from handler import handler
