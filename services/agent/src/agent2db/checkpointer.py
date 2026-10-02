"""LangGraph checkpointer in the app DB, so runs and pending approvals survive a backend restart.

`PostgresSaver` is synchronous and its async methods raise NotImplementedError. The async saver
needs async psycopg, which needs a selector event loop, while MCP stdio on Windows needs the
Proactor loop. This subclass keeps the sync implementation and runs it in worker threads.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator, Sequence
from typing import Any

from langgraph.checkpoint.base import Checkpoint, CheckpointMetadata, CheckpointTuple
from langgraph.checkpoint.postgres import PostgresSaver
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

log = logging.getLogger(__name__)


class ThreadedPostgresSaver(PostgresSaver):
    @classmethod
    def open(cls, dsn: str, *, max_size: int = 4) -> "ThreadedPostgresSaver":
        pool = ConnectionPool(
            dsn,
            min_size=1,
            max_size=max_size,
            open=False,
            kwargs={"autocommit": True, "prepare_threshold": 0, "row_factory": dict_row, "connect_timeout": 10},
        )
        pool.open(wait=True, timeout=30)
        saver = cls(pool)
        saver.setup()
        return saver

    def close(self) -> None:
        conn = self.conn
        if isinstance(conn, ConnectionPool) and not conn.closed:
            conn.close()

    async def aget_tuple(self, config: dict[str, Any]) -> CheckpointTuple | None:
        return await asyncio.to_thread(self.get_tuple, config)

    async def alist(
        self,
        config: dict[str, Any] | None,
        *,
        filter: dict[str, Any] | None = None,
        before: dict[str, Any] | None = None,
        limit: int | None = None,
    ) -> AsyncIterator[CheckpointTuple]:
        items = await asyncio.to_thread(lambda: list(self.list(config, filter=filter, before=before, limit=limit)))
        for item in items:
            yield item

    async def aput(
        self,
        config: dict[str, Any],
        checkpoint: Checkpoint,
        metadata: CheckpointMetadata,
        new_versions: dict[str, Any],
    ) -> dict[str, Any]:
        return await asyncio.to_thread(self.put, config, checkpoint, metadata, new_versions)

    async def aput_writes(
        self,
        config: dict[str, Any],
        writes: Sequence[tuple[str, Any]],
        task_id: str,
        task_path: str = "",
    ) -> None:
        await asyncio.to_thread(self.put_writes, config, writes, task_id, task_path)

    async def adelete_thread(self, thread_id: str) -> None:
        await asyncio.to_thread(self.delete_thread, thread_id)
