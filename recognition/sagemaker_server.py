"""Single-model SageMaker HTTP transport. SPDX-License-Identifier: AGPL-3.0-only"""

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from composition import create_service
from handler import process_body
from timing import request


def serve(engine, port=8080):
    class Requests(BaseHTTPRequestHandler):
        # SageMaker authenticates InvokeEndpoint with SigV4 before this private
        # container receives a request. This listener is never internet-exposed.
        def log_message(self, *args):
            pass

        def reply(self, code, body):
            raw = body.encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self):
            self.reply(200 if self.path == "/ping" else 404, "{}")

        def do_POST(self):
            if self.path != "/invocations":
                return self.reply(404, "{}")
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= 710000:
                    return self.reply(413, '{"error":"Image request too large"}')
                self.connection.settimeout(10)
                body = self.rfile.read(size).decode("utf-8")
                with request(
                    self.headers.get("X-Amzn-SageMaker-Custom-Attributes"), True
                ):
                    result = process_body(body, engine)
                self.reply(result["statusCode"], result["body"])
            except (ValueError, OSError):
                self.reply(400, '{"error":"Invalid image request"}')

    ThreadingHTTPServer(("0.0.0.0", port), Requests).serve_forever()


if __name__ == "__main__":
    # Loaded once on demand before /ping becomes ready; no provisioned capacity.
    serve(create_service())
