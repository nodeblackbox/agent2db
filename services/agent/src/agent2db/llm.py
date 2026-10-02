"""LLM access through the LiteLLM SDK (in-process) plus per-model request rules."""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable
from typing import Any

import litellm

litellm.drop_params = True  # drop options a provider does not support instead of failing
litellm.suppress_debug_info = True

# GPT-5 and o-series reject max_tokens and any non-default temperature (gpt-5-chat is not a reasoning model).
_OPENAI_REASONING = re.compile(r"^(?:openai/|azure/)?(?:gpt-5(?!.*chat)|o[134](?![a-z]))", re.IGNORECASE)


def request_options(model: str, max_tokens: int, temperature: float = 0.2) -> dict[str, Any]:
    if _OPENAI_REASONING.search(model.strip()):
        return {"max_completion_tokens": max_tokens}
    return {"max_tokens": max_tokens, "temperature": temperature}


async def stream_completion(
    model: str,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None,
    max_tokens: int,
    on_text: Callable[[str], Awaitable[None]],
) -> dict[str, Any]:
    """Stream one assistant turn, calling on_text for each text delta; return the full message dict."""
    kwargs: dict[str, Any] = {"model": model, "messages": messages, "stream": True}
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
        return {"role": "assistant", "content": ""}
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
    return out
