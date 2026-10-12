#!/usr/bin/env python3
"""Assert chart probe configuration and demonstrate TCP vs HTTP health semantics."""
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

import yaml


def fail(message):
    raise SystemExit(message)


if len(sys.argv) != 2:
    fail(f"usage: {sys.argv[0]} rendered.yaml")

with open(sys.argv[1], encoding="utf-8") as rendered_file:
    documents = yaml.safe_load_all(rendered_file)
    deployment = next(
        (doc for doc in documents if isinstance(doc, dict)
         and doc.get("kind") == "Deployment" and doc.get("metadata", {}).get("labels", {}).get("app.kubernetes.io/controller") == "main"),
        None,
    )

if deployment is None:
    fail("rendered YAML does not contain the main Deployment")

containers = deployment["spec"]["template"]["spec"]["containers"]
container = next((item for item in containers if item.get("name") == "main"), None)
if container is None:
    fail("main Deployment has no main container")

liveness = container.get("livenessProbe", {})
if liveness.get("tcpSocket", {}).get("port") != 3000 or "httpGet" in liveness:
    fail("main liveness probe must use TCP port 3000, not HTTP")
readiness = container.get("readinessProbe", {})
http_get = readiness.get("httpGet", {})
if http_get.get("path") != "/api/health" or http_get.get("port") != 3000:
    fail("main readiness probe must GET /api/health on port 3000")

# Model a live process with an unhealthy dependency: HTTP readiness fails while
# the listening socket remains alive. A stopped server then fails the TCP check.
class UnhealthyHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(503)
        self.end_headers()

    def log_message(self, *_args):
        pass

server = HTTPServer(("127.0.0.1", 0), UnhealthyHandler)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
port = server.server_address[1]
try:
    with socket.create_connection(("127.0.0.1", port), timeout=1):
        pass
    try:
        from urllib.request import urlopen
        urlopen(f"http://127.0.0.1:{port}/api/health", timeout=1)
        fail("simulated unhealthy dependency unexpectedly passed readiness")
    except Exception as error:
        if getattr(error, "code", None) != 503:
            raise
finally:
    server.shutdown()
    server.server_close()
    thread.join(timeout=2)

for _ in range(20):
    try:
        socket.create_connection(("127.0.0.1", port), timeout=0.1)
    except OSError:
        break
    time.sleep(0.05)
else:
    fail("stopped server unexpectedly passed TCP liveness")

print("Helm probe configuration and simulated dependency-health behavior passed")
