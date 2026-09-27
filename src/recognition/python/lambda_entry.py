"""On-demand library INIT only. SPDX-License-Identifier: AGPL-3.0-only"""

import json
from time import perf_counter

from composition import preload_adapters
from timing import stage, request

started = perf_counter()
with stage("imports.total"):
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

import handler as transport


def handler(event, context):
    with request(
        getattr(context, "aws_request_id", None), transport._engine is not None
    ):
        return transport.handler(event, context)
