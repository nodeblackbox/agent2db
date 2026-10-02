"""Runs: one per user message. Each run keeps an ordered event log that SSE clients replay from."""

from __future__ import annotations

import asyncio
import logging
import uuid
from dataclasses import dataclass, field
from typing import Any

from langgraph.types import Command

from agent2db.graph import current_emit, current_model

log = logging.getLogger(__name__)

TERMINAL = {"completed", "awaiting_approval", "failed", "cancelled"}


@dataclass
class Run:
    id: str
    session_id: str
    model: str | None
    status: str = "running"
    events: list[tuple[int, str, dict[str, Any]]] = field(default_factory=list)
    changed: asyncio.Condition = field(default_factory=asyncio.Condition)
    task: asyncio.Task | None = None

    async def emit(self, event_type: str, data: dict[str, Any]) -> None:
        async with self.changed:
            self.events.append((len(self.events) + 1, event_type, data))
            self.changed.notify_all()

    async def wait_for_events(self, after: int) -> list[tuple[int, str, dict[str, Any]]]:
        async with self.changed:
            await self.changed.wait_for(lambda: len(self.events) > after)
            return self.events[after:]


class RunManager:
    def __init__(self, graph: Any) -> None:
        self.graph = graph
        self.runs: dict[str, Run] = {}
        self._session_runs: dict[str, str] = {}

    def get(self, run_id: str) -> Run | None:
        return self.runs.get(run_id)

    def start(self, message: str, session_id: str | None, model: str | None) -> Run:
        session_id = session_id or uuid.uuid4().hex
        active = self.runs.get(self._session_runs.get(session_id, ""))
        if active and active.status == "running":
            raise RuntimeError("This session already has a run in progress.")
        run = Run(id=uuid.uuid4().hex, session_id=session_id, model=model)
        self.runs[run.id] = run
        self._session_runs[session_id] = run.id
        graph_input = {"messages": [{"role": "user", "content": message}]}
        run.task = asyncio.create_task(self._drive(run, graph_input))
        return run

    def resume(self, run: Run, decision: str, feedback: str | None) -> None:
        if run.status != "awaiting_approval":
            raise RuntimeError(f"Run is {run.status}, not awaiting approval.")
        run.status = "running"
        command = Command(resume={"decision": decision, "feedback": feedback or ""})
        run.task = asyncio.create_task(self._drive(run, command))

    async def cancel(self, run: Run) -> None:
        if run.task and not run.task.done():
            run.task.cancel()
        elif run.status == "awaiting_approval":
            run.status = "cancelled"
            await run.emit("done", {"status": "cancelled"})

    async def _drive(self, run: Run, graph_input: Any) -> None:
        current_emit.set(run.emit)
        current_model.set(run.model)
        config = {"configurable": {"thread_id": run.session_id}, "recursion_limit": 200}
        try:
            async for _ in self.graph.astream(graph_input, config, stream_mode="updates"):
                pass
            snapshot = await self.graph.aget_state(config)
            if snapshot.interrupts:
                run.status = "awaiting_approval"
                await run.emit("approval_required", dict(snapshot.interrupts[0].value))
            else:
                run.status = "completed"
        except asyncio.CancelledError:
            run.status = "cancelled"
        except Exception as exc:  # noqa: BLE001 - report to the client, keep the server alive
            log.exception("run %s failed", run.id)
            run.status = "failed"
            await run.emit("error", {"message": _describe(exc)})
        await run.emit("done", {"status": run.status})


def _describe(exc: Exception) -> str:
    text = str(exc).strip() or type(exc).__name__
    return text if len(text) < 600 else text[:600] + "..."
