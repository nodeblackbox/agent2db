"""Process entry point used by the Electron main process (`uv run agent2db-backend`).

Contract: binds 127.0.0.1 on AGENT2DB_PORT (0 = any free port), requires the bearer token from
AGENT2DB_TOKEN, and prints one JSON line {"ready": true, "port": N} to stdout once it can serve.
"""

from __future__ import annotations

import json
import logging
import os
import secrets
import socket
import sys

import uvicorn

from agent2db.config import Settings, load_env


def main() -> None:
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="%(levelname)s %(name)s: %(message)s")
    load_env()
    settings = Settings.from_env()

    token = os.environ.get("AGENT2DB_TOKEN", "").strip()
    if not token:
        token = secrets.token_hex(32)
        # Only for running the backend by hand; Electron always passes its own per-launch token.
        print(f"AGENT2DB_TOKEN not set; generated one for this process: {token}", file=sys.stderr)

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", int(os.environ.get("AGENT2DB_PORT", "0") or 0)))
    sock.listen(128)  # connections queue until uvicorn starts accepting
    port = sock.getsockname()[1]

    def on_ready() -> None:
        print(json.dumps({"ready": True, "port": port}), flush=True)

    from agent2db.api import create_app

    app = create_app(settings, token, on_ready)
    # uvicorn logs to stderr, keeping stdout for the ready line.
    config = uvicorn.Config(app, log_level="info", access_log=False)
    uvicorn.Server(config).run(sockets=[sock])


if __name__ == "__main__":
    main()
