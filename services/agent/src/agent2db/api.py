"""HTTP API for the desktop app: REST for commands, Server-Sent Events for run progress."""

from __future__ import annotations

import asyncio
import json
import logging
import secrets
import uuid
from contextlib import asynccontextmanager
from typing import Any, Literal

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from agent2db import __version__
from agent2db import dbviewer
from agent2db.config import Settings
from agent2db.documents import DocumentService, json_safe
from agent2db.graph import build_graph
from agent2db.mcp_hub import McpHub, load_config
from agent2db.runs import RunManager
from agent2db.schema_index import SchemaIndex
from agent2db.store import AppStore, json_ready
from agent2db.tools import Toolbox, document_tools, memory_tools, schema_tools

MAX_UPLOAD_BYTES = 50 * 1024 * 1024

log = logging.getLogger(__name__)

# How often this process proves it is alive in the shared app DB; another backend's restart
# recovery only claims runs whose owner missed several of these (RunManager.stale_after_seconds).
HEARTBEAT_SECONDS = 15


class StartRunRequest(BaseModel):
    message: str = Field(min_length=1, max_length=50_000)
    session_id: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{1,64}$")
    model: str | None = Field(default=None, max_length=200)
    # None = use the stored RAG setting; True/False overrides it for this run.
    rag: bool | None = None


class RagSettingRequest(BaseModel):
    enabled: bool


class QueryRequest(BaseModel):
    sql: str = Field(min_length=1, max_length=50_000)
    max_rows: int = Field(default=200, ge=1, le=500)


class ResumeRequest(BaseModel):
    decision: Literal["approve", "reject"]
    feedback: str | None = Field(default=None, max_length=5_000)


class SavedQueryRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    sql: str = Field(min_length=1, max_length=50_000)
    description: str = Field(default="", max_length=2_000)
    tables: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)


class FactRequest(BaseModel):
    content: str = Field(min_length=1, max_length=4_000)
    subject: str | None = Field(default=None, max_length=200)
    tags: list[str] = Field(default_factory=list)


def create_app(settings: Settings, token: str, on_ready: Any = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        store: AppStore | None = None
        checkpointer = None
        if settings.app_dsn:
            try:
                store = AppStore(settings.app_dsn)
                await store.open()
            except Exception as exc:  # noqa: BLE001 - run without persistence rather than not at all
                log.error("app database unavailable, running without persistence: %s", exc)
                store = None
        if store is not None:
            try:
                from agent2db.checkpointer import ThreadedPostgresSaver

                checkpointer = ThreadedPostgresSaver.open(store.checkpoint_dsn)
            except Exception as exc:  # noqa: BLE001
                log.error("Postgres checkpointer unavailable, sessions will not survive restarts: %s", exc)
                checkpointer = None

        hub = McpHub(
            load_config(settings.mcp_config) if settings.mcp_config else [],
            tool_timeout=settings.tool_timeout,
            log_dir=settings.log_dir,
        )
        await hub.start()

        index = SchemaIndex(store, settings.read_dsn, embedding_model=settings.embedding_model)
        await index.load()
        internal = schema_tools(index)
        documents: DocumentService | None = None
        if store is not None:
            internal += memory_tools(store)
            documents = DocumentService(store, settings.embedding_model, qdrant_url=settings.qdrant_url, qdrant_api_key=settings.qdrant_api_key)
            internal += document_tools(documents)
        toolbox = Toolbox(hub, internal)

        app.state.store = store
        app.state.hub = hub
        app.state.index = index
        app.state.toolbox = toolbox
        app.state.checkpointer = checkpointer
        app.state.documents = documents
        graph = build_graph(settings, toolbox, checkpointer, schema_index=index, store=store, documents=documents)
        backend_id = uuid.uuid4().hex
        app.state.backend_id = backend_id
        app.state.runs = RunManager(graph, store, settings.model, backend_id=backend_id)
        heartbeat_task: asyncio.Task | None = None
        if store is not None:
            try:
                await store.register_backend(backend_id, __version__)
                await app.state.runs.restore()
            except Exception as exc:  # noqa: BLE001
                log.warning("could not register backend / restore pending runs: %s", exc)

            async def heartbeat() -> None:
                while True:
                    await asyncio.sleep(HEARTBEAT_SECONDS)
                    try:
                        await store.heartbeat(backend_id)
                    except Exception as exc:  # noqa: BLE001
                        log.warning("heartbeat failed: %s", exc)

            heartbeat_task = asyncio.create_task(heartbeat())
        if on_ready:
            on_ready()
        try:
            yield
        finally:
            if heartbeat_task is not None:
                heartbeat_task.cancel()
            await hub.close()
            if checkpointer is not None:
                checkpointer.close()
            if store is not None:
                await store.close()

    app = FastAPI(title="Agent2DB backend", version=__version__, lifespan=lifespan)

    def require_token(authorization: str = Header(default="")) -> None:
        scheme, _, value = authorization.partition(" ")
        if scheme.lower() != "bearer" or not secrets.compare_digest(value.encode(), token.encode()):
            raise HTTPException(status_code=401, detail="Missing or invalid bearer token.")

    auth = [Depends(require_token)]

    def require_store(request: Request) -> AppStore:
        store = request.app.state.store
        if store is None:
            raise HTTPException(status_code=503, detail="The app database is not available.")
        return store

    # ---------- health ----------

    @app.get("/health", dependencies=auth)
    async def health(request: Request) -> dict[str, Any]:
        hub: McpHub = request.app.state.hub
        store: AppStore | None = request.app.state.store
        index: SchemaIndex = request.app.state.index
        return {
            "status": "ok",
            "version": __version__,
            "backend_id": request.app.state.backend_id,
            "model": settings.model,
            "fallback_models": settings.fallback_models,
            "mcp": hub.status,
            "tools": sorted(request.app.state.toolbox.tools),
            "store": "connected" if store is not None else "unavailable",
            "checkpointer": "postgres" if request.app.state.checkpointer is not None else "memory",
            "schema_index": index.status,
            "documents": json_safe(await request.app.state.documents.stats()) if request.app.state.documents is not None else None,
        }

    # ---------- runs ----------

    @app.post("/runs", dependencies=auth)
    async def start_run(body: StartRunRequest, request: Request) -> dict[str, str]:
        runs: RunManager = request.app.state.runs
        try:
            run = runs.start(body.message, body.session_id, body.model, rag=body.rag)
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return {"run_id": run.id, "session_id": run.session_id}

    def get_run(request: Request, run_id: str):
        run = request.app.state.runs.get(run_id)
        if run is None:
            raise HTTPException(status_code=404, detail="Unknown run.")
        return run

    @app.get("/runs/{run_id}", dependencies=auth)
    async def run_info(run_id: str, request: Request) -> dict[str, Any]:
        run = request.app.state.runs.get(run_id)
        if run is not None:
            return run.summary()
        store = require_store(request)
        row = await store.get_run(run_id)
        if row is None:
            raise HTTPException(status_code=404, detail="Unknown run.")
        return json_ready(dict(row))

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

    # ---------- sessions (history) ----------

    @app.get("/sessions", dependencies=auth)
    async def list_sessions(request: Request, limit: int = 50) -> list[dict[str, Any]]:
        store = require_store(request)
        return json_ready([dict(r) for r in await store.list_sessions(limit=min(max(limit, 1), 200))])

    @app.get("/sessions/{session_id}", dependencies=auth)
    async def session_detail(session_id: str, request: Request) -> dict[str, Any]:
        store = require_store(request)
        runs = await store.list_session_runs(session_id)
        if not runs:
            raise HTTPException(status_code=404, detail="Unknown session.")
        active = request.app.state.runs.active_for_session(session_id)
        return {
            "session_id": session_id,
            "active_run": active.summary() if active else None,
            "runs": json_ready([dict(r) for r in runs]),
        }

    @app.get("/sessions/{session_id}/events", dependencies=auth)
    async def session_events(session_id: str, request: Request) -> list[dict[str, Any]]:
        """Every persisted event of the session in order, for rebuilding the chat after a restart."""
        store = require_store(request)
        out = []
        for run in await store.list_session_runs(session_id):
            out.append({"run_id": run["id"], "seq": 0, "type": "user", "data": {"text": run["message"]}})
            for seq, event_type, data in await store.list_run_events(run["id"]):
                out.append({"run_id": run["id"], "seq": seq, "type": event_type, "data": data})
        return json_ready(out)

    @app.delete("/sessions/{session_id}", dependencies=auth)
    async def delete_session(session_id: str, request: Request) -> dict[str, bool]:
        store = require_store(request)
        if request.app.state.runs.active_for_session(session_id):
            raise HTTPException(status_code=409, detail="Session has an active run.")
        deleted = await store.delete_session(session_id)
        checkpointer = request.app.state.checkpointer
        if checkpointer is not None:
            try:
                await checkpointer.adelete_thread(session_id)
            except Exception as exc:  # noqa: BLE001
                log.warning("could not delete checkpoint thread %s: %s", session_id, exc)
        return {"ok": deleted}

    # ---------- approvals audit ----------

    @app.get("/approvals", dependencies=auth)
    async def list_approvals(request: Request, limit: int = 100) -> list[dict[str, Any]]:
        store = require_store(request)
        return json_ready([dict(r) for r in await store.list_approvals(limit=min(max(limit, 1), 500))])

    # ---------- saved queries ----------

    @app.get("/saved-queries", dependencies=auth)
    async def list_saved_queries(request: Request, q: str | None = None) -> list[dict[str, Any]]:
        store = require_store(request)
        rows = await (store.search_saved_queries(q, limit=50) if q else store.list_saved_queries())
        return json_ready([dict(r) for r in rows])

    @app.post("/saved-queries", dependencies=auth)
    async def create_saved_query(body: SavedQueryRequest, request: Request) -> dict[str, Any]:
        store = require_store(request)
        return json_ready(dict(await store.save_query(body.name, body.sql, body.description, body.tables, body.tags)))

    @app.delete("/saved-queries/{query_id}", dependencies=auth)
    async def delete_saved_query(query_id: int, request: Request) -> dict[str, bool]:
        store = require_store(request)
        return {"ok": await store.delete_saved_query(query_id)}

    # ---------- facts (memory) ----------

    @app.get("/facts", dependencies=auth)
    async def list_facts(request: Request, q: str | None = None) -> list[dict[str, Any]]:
        store = require_store(request)
        rows = await (store.search_facts(q, limit=50) if q else store.list_facts())
        return json_ready([dict(r) for r in rows])

    @app.post("/facts", dependencies=auth)
    async def create_fact(body: FactRequest, request: Request) -> dict[str, Any]:
        store = require_store(request)
        return json_ready(dict(await store.add_fact(body.content, body.subject, body.tags, source="user")))

    @app.delete("/facts/{fact_id}", dependencies=auth)
    async def delete_fact(fact_id: int, request: Request) -> dict[str, bool]:
        store = require_store(request)
        return {"ok": await store.delete_fact(fact_id)}

    # ---------- schema index ----------

    @app.get("/schema", dependencies=auth)
    async def schema_status(request: Request) -> dict[str, Any]:
        index: SchemaIndex = request.app.state.index
        return {
            **index.status,
            "tables_list": [
                {"table": c["table_name"], "kind": c["kind"], "rows": c.get("row_estimate"), "columns": len(c["columns"])}
                for c in index.cards
            ],
        }

    @app.post("/schema/reindex", dependencies=auth)
    async def schema_reindex(request: Request) -> dict[str, Any]:
        index: SchemaIndex = request.app.state.index
        rebuilt = await index.ensure_fresh(force=True)
        return {"rebuilt": rebuilt, **index.status}

    @app.get("/schema/search", dependencies=auth)
    async def schema_search(request: Request, q: str, limit: int = 10) -> list[dict[str, Any]]:
        index: SchemaIndex = request.app.state.index
        return await index.search(q, limit=min(max(limit, 1), 50))

    @app.get("/schema/tables/{table}", dependencies=auth)
    async def schema_table(table: str, request: Request) -> dict[str, Any]:
        index: SchemaIndex = request.app.state.index
        ddl = await index.describe(table)
        if ddl is None:
            raise HTTPException(status_code=404, detail="Unknown table.")
        card = index.by_name.get(table) or next(c for c in index.cards if c["ddl"] == ddl)
        return json_ready(
            {
                "table": card["table_name"],
                "kind": card["kind"],
                "rows": card.get("row_estimate"),
                "comment": card.get("comment"),
                "columns": card["columns"],
                "foreign_keys": card.get("foreign_keys") or [],
                "ddl": ddl,
            }
        )

    # ---------- documents (RAG) ----------

    def require_documents(request: Request) -> DocumentService:
        service = request.app.state.documents
        if service is None:
            raise HTTPException(status_code=503, detail="Documents need the app database.")
        return service

    @app.get("/documents", dependencies=auth)
    async def list_documents(request: Request) -> dict[str, Any]:
        service = require_documents(request)
        return json_safe({"documents": await service.list_documents(), **await service.stats()})

    @app.post("/documents", dependencies=auth)
    async def upload_document(request: Request, file: UploadFile = File(...), tags: str = Form(default="")) -> dict[str, Any]:
        service = require_documents(request)
        data = await file.read()
        if len(data) > MAX_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail="File is larger than 50 MB.")
        if not data:
            raise HTTPException(status_code=400, detail="Empty file.")
        try:
            row = await service.add_document(file.filename or "upload", data, file.content_type, [t.strip() for t in tags.split(",") if t.strip()])
        except ValueError as exc:
            raise HTTPException(status_code=415, detail=str(exc)) from exc
        return json_safe(row)

    @app.get("/documents/search", dependencies=auth)
    async def search_documents(request: Request, q: str, limit: int = 6) -> list[dict[str, Any]]:
        service = require_documents(request)
        return json_safe(await service.search(q, limit=min(max(limit, 1), 20)))

    @app.get("/documents/{document_id}", dependencies=auth)
    async def document_detail(document_id: int, request: Request) -> dict[str, Any]:
        service = require_documents(request)
        row = await service.get_document(document_id)
        if row is None:
            raise HTTPException(status_code=404, detail="Unknown document.")
        return json_safe({**row, "chunks": await service.list_chunks(document_id)})

    @app.delete("/documents/{document_id}", dependencies=auth)
    async def delete_document(document_id: int, request: Request) -> dict[str, bool]:
        service = require_documents(request)
        return {"ok": await service.delete_document(document_id)}

    @app.get("/settings/rag", dependencies=auth)
    async def get_rag(request: Request) -> dict[str, Any]:
        service = require_documents(request)
        return {"enabled": await service.rag_enabled()}

    @app.put("/settings/rag", dependencies=auth)
    async def set_rag(body: RagSettingRequest, request: Request) -> dict[str, Any]:
        service = require_documents(request)
        await service.set_rag_enabled(body.enabled)
        return {"enabled": body.enabled}

    # ---------- database viewer (read-only) ----------

    def require_read_dsn() -> str:
        if not settings.read_dsn:
            raise HTTPException(status_code=503, detail="No database connection configured.")
        return settings.read_dsn

    @app.get("/db/tables/{table}/rows", dependencies=auth)
    async def db_rows(
        table: str,
        limit: int = 50,
        offset: int = 0,
        order_by: str | None = None,
        desc: bool = False,
        where: str | None = None,
    ) -> dict[str, Any]:
        try:
            return await dbviewer.table_rows(require_read_dsn(), table, limit=limit, offset=offset, order_by=order_by, descending=desc, where=where)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001 - database errors become 400s with the message
            raise HTTPException(status_code=400, detail=str(exc).strip().splitlines()[0]) from exc

    @app.post("/db/query", dependencies=auth)
    async def db_query(body: QueryRequest) -> dict[str, Any]:
        return await dbviewer.run_query(require_read_dsn(), body.sql, max_rows=body.max_rows)

    @app.get("/db/erd", dependencies=auth)
    async def db_erd(request: Request, tables: str | None = None) -> dict[str, Any]:
        index: SchemaIndex = request.app.state.index
        if not index.cards:
            await index.ensure_fresh()
        selected = [t for t in (tables or "").split(",") if t] or None
        return {"mermaid": dbviewer.mermaid_erd(index.cards, tables=selected), "tables": len(selected or index.cards)}

    return app
