"""HTTP API for the desktop app: REST for commands, Server-Sent Events for run progress."""

from __future__ import annotations

import json
import secrets
from contextlib import asynccontextmanager
from typing import Any, Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from agent2db import __version__
from agent2db.config import Settings
from agent2db.graph import build_graph
from agent2db.mcp_hub import McpHub, load_config
from agent2db.runs import RunManager


class StartRunRequest(BaseModel):
    message: str = Field(min_length=1, max_length=50_000)
    session_id: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{1,64}$")
    model: str | None = Field(default=None, max_length=200)


class ResumeRequest(BaseModel):
    decision: Literal["approve", "reject"]
    feedback: str | None = Field(default=None, max_length=5_000)


def create_app(settings: Settings, token: str, on_ready: Any = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        hub = McpHub(load_config(settings.mcp_config))
        await hub.start()
        app.state.hub = hub
        app.state.runs = RunManager(build_graph(settings, hub))
        if on_ready:
            on_ready()
        try:
            yield
        finally:
            await hub.close()

    app = FastAPI(title="Agent2DB backend", version=__version__, lifespan=lifespan)

    def require_token(authorization: str = Header(default="")) -> None:
        scheme, _, value = authorization.partition(" ")
        if scheme.lower() != "bearer" or not secrets.compare_digest(value.encode(), token.encode()):
            raise HTTPException(status_code=401, detail="Missing or invalid bearer token.")

    auth = [Depends(require_token)]

    @app.get("/health", dependencies=auth)
    async def health(request: Request) -> dict[str, Any]:
        hub: McpHub = request.app.state.hub
        return {
            "status": "ok",
            "version": __version__,
            "model": settings.model,
            "mcp": hub.status,
            "tools": sorted(hub.tools),
        }

    @app.post("/runs", dependencies=auth)
    async def start_run(body: StartRunRequest, request: Request) -> dict[str, str]:
        runs: RunManager = request.app.state.runs
        try:
            run = runs.start(body.message, body.session_id, body.model)
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return {"run_id": run.id, "session_id": run.session_id}

    def get_run(request: Request, run_id: str):
        run = request.app.state.runs.get(run_id)
        if run is None:
            raise HTTPException(status_code=404, detail="Unknown run.")
        return run

    @app.get("/runs/{run_id}/events", dependencies=auth)
    async def run_events(run_id: str, request: Request, after: int = 0) -> EventSourceResponse:
        run = get_run(request, run_id)

        async def stream():
            seen = max(after, 0)
            while True:
                for seq, event_type, data in await run.wait_for_events(seen):
                    seen = seq
                    yield {"id": str(seq), "event": event_type, "data": json.dumps(data, default=str)}
                    if event_type == "done":
                        return

        return EventSourceResponse(stream(), ping=15)

    @app.post("/runs/{run_id}/resume", dependencies=auth)
    async def resume_run(run_id: str, body: ResumeRequest, request: Request) -> dict[str, bool]:
        run = get_run(request, run_id)
        try:
            request.app.state.runs.resume(run, body.decision, body.feedback)
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return {"ok": True}

    @app.post("/runs/{run_id}/cancel", dependencies=auth)
    async def cancel_run(run_id: str, request: Request) -> dict[str, bool]:
        await request.app.state.runs.cancel(get_run(request, run_id))
        return {"ok": True}

    return app
