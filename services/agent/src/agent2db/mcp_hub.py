"""MCP servers from an `mcpServers` JSON config, exposed to the model as namespaced tools."""

from __future__ import annotations

import ast as pyast
import json
import logging
import os
import re
from contextlib import AsyncExitStack
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

log = logging.getLogger(__name__)

# Tool names sent to the model are "<server>__<tool>"; providers only allow [A-Za-z0-9_-].
SEPARATOR = "__"
_VAR = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-((?:[^{}]|\{[^{}]*\})*))?\}")


def resolve_vars(value: str, env: dict[str, str] | None = None) -> str:
    """Expand ${VAR} and ${VAR:-fallback} (fallback may itself contain ${OTHER})."""
    env = os.environ if env is None else env

    def replace(match: re.Match[str]) -> str:
        name, fallback = match.group(1), match.group(2)
        found = env.get(name)
        if found:
            return found
        if fallback is not None:
            return resolve_vars(fallback, env)
        raise KeyError(name)

    return _VAR.sub(replace, value)


@dataclass
class ServerConfig:
    name: str
    command: str
    args: list[str]
    env: dict[str, str]
    enabled: bool = True
    requires_approval: bool | list[str] = False
    tools: list[str] | None = None  # optional allow-list

    def needs_approval(self, tool: str) -> bool:
        if isinstance(self.requires_approval, list):
            return tool in self.requires_approval
        return bool(self.requires_approval)


def load_config(path: Path) -> list[ServerConfig]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    servers = []
    for name, spec in raw.get("mcpServers", {}).items():
        if SEPARATOR in name or not re.fullmatch(r"[A-Za-z0-9_-]+", name):
            raise ValueError(f"MCP server name {name!r} must match [A-Za-z0-9_-] and not contain '__'")
        servers.append(
            ServerConfig(
                name=name,
                command=spec["command"],
                args=list(spec.get("args", [])),
                env=dict(spec.get("env", {})),
                enabled=spec.get("enabled", True),
                requires_approval=spec.get("requiresApproval", False),
                tools=spec.get("tools"),
            )
        )
    return servers


@dataclass
class Tool:
    server: ServerConfig
    name: str
    description: str
    input_schema: dict[str, Any]

    @property
    def qualified_name(self) -> str:
        return f"{self.server.name}{SEPARATOR}{self.name}"

    @property
    def needs_approval(self) -> bool:
        return self.server.needs_approval(self.name)

    def to_openai(self) -> dict[str, Any]:
        description = self.description
        if self.needs_approval:
            description += " (Runs only after the user approves it in the UI.)"
        return {
            "type": "function",
            "function": {
                "name": self.qualified_name,
                "description": f"[{self.server.name}] {description}",
                "parameters": self.input_schema or {"type": "object", "properties": {}},
            },
        }


@dataclass
class ToolResult:
    content: str
    is_error: bool


def normalize_result_text(text: str) -> str:
    """Postgres MCP Pro returns Python reprs like "[{'x': 1}]"; turn them into JSON when possible."""
    stripped = text.strip()
    if stripped[:1] in "[{":
        try:
            return json.dumps(pyast.literal_eval(stripped), default=str)
        except (ValueError, SyntaxError, MemoryError, RecursionError):
            pass
    return text


@dataclass
class McpHub:
    servers: list[ServerConfig]
    status: dict[str, str] = field(default_factory=dict)
    tools: dict[str, Tool] = field(default_factory=dict)
    _sessions: dict[str, ClientSession] = field(default_factory=dict)
    _stack: AsyncExitStack = field(default_factory=AsyncExitStack)

    async def start(self) -> None:
        """Start every enabled server. One failing server never blocks the others."""
        for server in self.servers:
            if not server.enabled:
                self.status[server.name] = "disabled"
                continue
            try:
                await self._start_server(server)
                self.status[server.name] = "connected"
            except Exception as exc:  # noqa: BLE001 - report any startup failure per server
                log.exception("MCP server %s failed to start", server.name)
                self.status[server.name] = f"error: {_root_cause(exc)}"

    async def _start_server(self, server: ServerConfig) -> None:
        env = {**os.environ, **{k: resolve_vars(v) for k, v in server.env.items()}}
        params = StdioServerParameters(command=server.command, args=server.args, env=env)
        stack = AsyncExitStack()
        try:
            read, write = await stack.enter_async_context(stdio_client(params))
            session = await stack.enter_async_context(ClientSession(read, write))
            await session.initialize()
            listed = await session.list_tools()
        except BaseException:
            await stack.aclose()
            raise
        await self._stack.enter_async_context(stack)
        self._sessions[server.name] = session
        for item in listed.tools:
            if server.tools is not None and item.name not in server.tools:
                continue
            tool = Tool(server, item.name, item.description or "", dict(item.input_schema or {}))
            self.tools[tool.qualified_name] = tool

    async def call(self, qualified_name: str, args: dict[str, Any]) -> ToolResult:
        tool = self.tools.get(qualified_name)
        if tool is None:
            return ToolResult(f"Unknown tool {qualified_name!r}.", True)
        result = await self._sessions[tool.server.name].call_tool(tool.name, args)
        texts = [getattr(part, "text", None) or json.dumps(part.model_dump(), default=str) for part in result.content]
        text = normalize_result_text("\n".join(texts))
        # Postgres MCP Pro reports SQL errors as normal text starting with "Error:".
        is_error = bool(result.is_error) or text.lstrip().startswith("Error:")
        return ToolResult(text, is_error)

    def openai_tools(self) -> list[dict[str, Any]]:
        return [tool.to_openai() for tool in self.tools.values()]

    async def close(self) -> None:
        await self._stack.aclose()


def _root_cause(exc: BaseException) -> str:
    while isinstance(exc, BaseExceptionGroup) and exc.exceptions:
        exc = exc.exceptions[0]
    if isinstance(exc, KeyError):
        return f"environment variable {exc.args[0]} is not set"
    return str(exc) or type(exc).__name__
