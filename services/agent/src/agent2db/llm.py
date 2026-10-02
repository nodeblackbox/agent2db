"""LLM access through the LiteLLM SDK (in-process): streaming, usage/cost capture, model fallbacks,
and per-model request rules."""

from __future__ import annotations

import logging
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

import litellm

log = logging.getLogger(__name__)

litellm.drop_params = True  # drop options a provider does not support instead of failing
litellm.suppress_debug_info = True

# GPT-5 and o-series reject max_tokens and any non-default temperature (gpt-5-chat is not a reasoning model).
_OPENAI_REASONING = re.compile(r"^(?:openai/|azure/)?(?:gpt-5(?!.*chat)|o[134](?![a-z]))", re.IGNORECASE)

# Errors worth retrying on another model (quota, overload, auth misconfig); bad requests are not.
_FALLBACK_ERRORS = (
    litellm.RateLimitError,
    litellm.ServiceUnavailableError,
    litellm.InternalServerError,
    litellm.AuthenticationError,
    litellm.Timeout,
    litellm.APIConnectionError,
)


@dataclass
class Usage:
    tokens_in: int = 0
    tokens_out: int = 0
    cost_usd: float = 0.0
    calls: int = 0

    def add(self, other: "Usage") -> "Usage":
        return Usage(
            self.tokens_in + other.tokens_in,
            self.tokens_out + other.tokens_out,
            round(self.cost_usd + other.cost_usd, 6),
            self.calls + other.calls,
        )

    def as_dict(self) -> dict[str, Any]:
        return {"tokens_in": self.tokens_in, "tokens_out": self.tokens_out, "cost_usd": self.cost_usd, "calls": self.calls}

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "Usage":
        data = data or {}
        return cls(int(data.get("tokens_in") or 0), int(data.get("tokens_out") or 0), float(data.get("cost_usd") or 0.0), int(data.get("calls") or 0))


@dataclass
class Completion:
    message: dict[str, Any]
    usage: Usage = field(default_factory=Usage)
    model: str = ""


def request_options(model: str, max_tokens: int, temperature: float = 0.2) -> dict[str, Any]:
    if _OPENAI_REASONING.search(model.strip()):
        return {"max_completion_tokens": max_tokens}
    return {"max_tokens": max_tokens, "temperature": temperature}


def _usage_of(built: Any, model: str) -> Usage:
    usage = getattr(built, "usage", None)
    tokens_in = int(getattr(usage, "prompt_tokens", 0) or 0)
    tokens_out = int(getattr(usage, "completion_tokens", 0) or 0)
    cost = 0.0
    try:
        cost = float(litellm.completion_cost(completion_response=built, model=model) or 0.0)
    except Exception:  # noqa: BLE001 - unknown models have no price table
        cost = 0.0
    return Usage(tokens_in, tokens_out, round(cost, 6), 1)


async def _stream_once(
    model: str,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None,
    max_tokens: int,
    on_text: Callable[[str], Awaitable[None]],
) -> Completion:
    kwargs: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "stream": True,
        "stream_options": {"include_usage": True},
    }
    kwargs.update(request_options(model, max_tokens))
    if tools:
        kwargs["tools"] = tools
    chunks = []
    response = await litellm.acompletion(**kwargs)
    async for chunk in response:
        chunks.append(chunk)
        delta = chunk.choices[0].delta if chunk.choices else None
        text = getattr(delta, "content", None) if delta else None
        if text:
            await on_text(text)
    if not chunks:
        return Completion({"role": "assistant", "content": ""}, Usage(), model)
    built = litellm.stream_chunk_builder(chunks, messages=messages)
    message = built.choices[0].message
    out: dict[str, Any] = {"role": "assistant", "content": message.content or ""}
    if message.tool_calls:
        out["tool_calls"] = [
            {
                "id": call.id,
                "type": "function",
                "function": {"name": call.function.name, "arguments": call.function.arguments or "{}"},
            }
            for call in message.tool_calls
        ]
    return Completion(out, _usage_of(built, model), model)


async def stream_completion(
    model: str,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None,
    max_tokens: int,
    on_text: Callable[[str], Awaitable[None]],
    fallbacks: list[str] | None = None,
) -> Completion:
    """Stream one assistant turn, calling on_text for each text delta.

    If the primary model fails with a provider-side error (rate limit, outage, bad key) the
    request is retried on each fallback model in order. Streamed text from a failed attempt is
    not undone, so fallbacks only trigger on errors raised before any text was produced.
    """
    produced = False

    async def guarded(text: str) -> None:
        nonlocal produced
        produced = True
        await on_text(text)

    candidates = [model, *[m for m in (fallbacks or []) if m and m != model]]
    last_error: Exception | None = None
    for index, candidate in enumerate(candidates):
        try:
            return await _stream_once(candidate, messages, tools, max_tokens, guarded)
        except _FALLBACK_ERRORS as exc:
            last_error = exc
            if produced or index == len(candidates) - 1:
                raise
            log.warning("model %s failed (%s); trying %s", candidate, type(exc).__name__, candidates[index + 1])
    assert last_error is not None
    raise last_error
