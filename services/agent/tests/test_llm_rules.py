import pytest

from agent2db.llm import request_options


@pytest.mark.parametrize("model", ["openai/gpt-5", "gpt-5-mini", "openai/gpt-5.1", "o1", "o3-mini", "openai/o4-mini"])
def test_reasoning_models_use_max_completion_tokens_and_default_temperature(model):
    assert request_options(model, 2048) == {"max_completion_tokens": 2048}


@pytest.mark.parametrize(
    "model",
    ["openai/gpt-4o", "gpt-4.1", "openai/gpt-5-chat-latest", "anthropic/claude-sonnet-5-5", "groq/llama-3.3-70b-versatile"],
)
def test_other_models_keep_max_tokens_and_temperature(model):
    assert request_options(model, 2048) == {"max_tokens": 2048, "temperature": 0.2}
