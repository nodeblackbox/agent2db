"""Runs: one per user message. Each run keeps an ordered event log that SSE clients replay from.

With an AppStore, sessions, runs, events and approvals are persisted, and runs that were waiting
for approval when the backend stopped are restored at startup (the LangGraph checkpoint holds
their state; the event log here lets the UI replay what happened).
"""

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
    pending_approval: dict[str, Any] | None = None
    usage: dict[str, Any] = field(default_factory=dict)
    steps: int = 0
    store: Any | None = None

    async def emit(self, event_type: str, data: dict[str, Any]) -> None:
        async with self.changed:
            seq = len(self.events) + 1
            self.events.append((seq, event_type, data))
            self.changed.notify_all()
        if event_type == "usage":
            self.usage = {k: data[k] for k in ("tokens_in", "tokens_out", "cost_usd", "calls") if k in data}
        if event_type == "tool_result":
            self.steps += 1
        if self.store is not None:
            try:
                await self.store.append_event(self.id, seq, event_type, data)
            except Exception as exc:  # noqa: BLE001 - persistence must never break a run
                log.warning("could not persist event %s/%s: %s", self.id, seq, exc)

    async def wait_for_events(self, after: int) -> list[tuple[int, str, dict[str, Any]]]:
        async with self.changed:
            await self.changed.wait_for(lambda: len(self.events) > after)
            return self.events[after:]

    def summary(self) -> dict[str, Any]:
        return {
            "run_id": self.id,
            "session_id": self.session_id,
            "status": self.status,
            "model": self.model,
            "events": len(self.events),
            "usage": self.usage,
            "pending_approval": self.pending_approval,
        }


class RunManager:
    def __init__(self, graph: Any, store: Any | None = None, default_model: str | None = None) -> None:
        self.graph = graph
        self.store = store
        self.default_model = default_model
        self.runs: dict[str, Run] = {}
        self._session_runs: dict[str, str] = {}

    def get(self, run_id: str) -> Run | None:
        return self.runs.get(run_id)

    def active_for_session(self, session_id: str) -> Run | None:
        run = self.runs.get(self._session_runs.get(session_id, ""))
        return run if run and run.status in ("running", "awaiting_approval") else None

    def start(self, message: str, session_id: str | None, model: str | None) -> Run:
        session_id = session_id or uuid.uuid4().hex
        active = self.active_for_session(session_id)
        if active and active.status == "running":
            raise RuntimeError("This session already has a run in progress.")
        if active and active.status == "awaiting_approval":
            raise RuntimeError("This session is waiting for an approval decision; approve or reject it first.")
        run = Run(id=uuid.uuid4().hex, session_id=session_id, model=model, store=self.store)
        self.runs[run.id] = run
        self._session_runs[session_id] = run.id
        graph_input = {"messages": [{"role": "user", "content": message}]}
        run.task = asyncio.create_task(self._drive(run, graph_input, first_message=message))
        return run

    def resume(self, run: Run, decision: str, feedback: str | None) -> None:
        if run.status != "awaiting_approval":
            raise RuntimeError(f"Run is {run.status}, not awaiting approval.")
        run.status = "running"
        pending = run.pending_approval
        run.pending_approval = None
        command = Command(resume={"decision": decision, "feedback": feedback or ""})
        run.task = asyncio.create_task(self._drive(run, command, decision=(pending, decision, feedback)))

    async def cancel(self, run: Run) -> None:
        if run.task and not run.task.done():
            run.task.cancel()
        elif run.status == "awaiting_approval":
            run.status = "cancelled"
            run.pending_approval = None
            await run.emit("done", {"status": "cancelled"})
            await self._persist_finish(run)

    async def restore(self) -> int:
        """Re-attach runs left waiting for approval by a previous backend process."""
        if self.store is None:
            return 0
        restored = 0
        for row in await self.store.pending_runs():
            run = Run(id=row["id"], session_id=row["session_id"], model=row["model"], status=row["status"], store=self.store)
            run.events = await self.store.list_run_events(run.id)
            if row["status"] == "running":
                run.status = "failed"
                await run.emit("error", {"message": "The backend restarted while this run was in progress."})
                await run.emit("done", {"status": "failed"})
                await self.store.finish_run(run.id, "failed", error="backend restarted")
                self.runs[run.id] = run
                continue
            config = {"configurable": {"thread_id": run.session_id}}
            try:
                snapshot = await self.graph.aget_state(config)
            except Exception as exc:  # noqa: BLE001
                log.warning("could not load checkpoint for run %s: %s", run.id, exc)
                snapshot = None
            if snapshot and snapshot.interrupts:
                run.pending_approval = dict(snapshot.interrupts[0].value)
                self.runs[run.id] = run
                self._session_runs[run.session_id] = run.id
                restored += 1
            else:
                run.status = "failed"
                await run.emit("error", {"message": "The pending approval could not be restored after restart."})
                await run.emit("done", {"status": "failed"})
                await self.store.finish_run(run.id, "failed", error="approval lost on restart")
                self.runs[run.id] = run
        if restored:
            log.info("restored %d run(s) awaiting approval", restored)
        return restored

    async def _drive(self, run: Run, graph_input: Any, *, first_message: str | None = None, decision: Any = None) -> None:
        current_emit.set(run.emit)
        current_model.set(run.model)
        config = {"configurable": {"thread_id": run.session_id}, "recursion_limit": 200}
        try:
            if self.store is not None:
                if first_message is not None:
                    await self.store.ensure_session(run.session_id, first_message, run.model or self.default_model)
                    await self.store.create_run(run.id, run.session_id, first_message, run.model or self.default_model)
                if decision is not None:
                    pending, verdict, feedback = decision
                    await self.store.set_run_status(run.id, "running")
                    if pending:
                        await self.store.record_approval_decision(run.id, pending["tool_call_id"], verdict, feedback)
            async for _ in self.graph.astream(graph_input, config, stream_mode="updates"):
                pass
            snapshot = await self.graph.aget_state(config)
            if snapshot.interrupts:
                run.status = "awaiting_approval"
                run.pending_approval = dict(snapshot.interrupts[0].value)
                await run.emit("approval_required", run.pending_approval)
                if self.store is not None:
                    await self.store.record_approval_request(run.id, run.pending_approval)
            else:
                run.status = "completed"
            answer = _last_answer(snapshot.values.get("messages") or [])
            run.usage = snapshot.values.get("usage") or run.usage
        except asyncio.CancelledError:
            run.status = "cancelled"
            answer = None
        except Exception as exc:  # noqa: BLE001 - report to the client, keep the server alive
            log.exception("run %s failed", run.id)
            run.status = "failed"
            answer = None
            await run.emit("error", {"message": _describe(exc)})
        await run.emit("done", {"status": run.status, "usage": run.usage, "steps": run.steps})
        await self._persist_finish(run, answer=answer)

    async def _persist_finish(self, run: Run, answer: str | None = None) -> None:
        if self.store is None:
            return
        try:
            await self.store.finish_run(run.id, run.status, answer=answer, usage=run.usage, steps=run.steps)
        except Exception as exc:  # noqa: BLE001
            log.warning("could not persist run %s: %s", run.id, exc)


def _last_answer(messages: list[dict[str, Any]]) -> str | None:
    for message in reversed(messages):
        if message.get("role") == "assistant" and message.get("content"):
            return str(message["content"])
        if message.get("role") == "user":
            break
    return None


def _describe(exc: Exception) -> str:
    text = str(exc).strip() or type(exc).__name__
    return text if len(text) < 600 else text[:600] + "..."
