"""Runtime settings, read from the environment (and the repo-root .env in development)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

# services/agent/src/agent2db/config.py -> repo root is four levels up.
REPO_ROOT = Path(os.environ.get("AGENT2DB_REPO_ROOT") or Path(__file__).resolve().parents[4])
SERVICE_DIR = Path(__file__).resolve().parents[2]
PROMPTS_DIR = SERVICE_DIR / "prompts"
MIGRATIONS_DIR = SERVICE_DIR / "migrations"

# Preferred default models, first one whose provider key is set wins.
_DEFAULT_MODELS = (
    ("ANTHROPIC_API_KEY", "anthropic/claude-sonnet-5-5"),
    ("OPENAI_API_KEY", "openai/gpt-5-mini"),
    ("GEMINI_API_KEY", "gemini/gemini-2.5-flash"),
    ("XAI_API_KEY", "xai/grok-4"),
    ("GROQ_API_KEY", "groq/llama-3.3-70b-versatile"),
)

# Embedding model used for hybrid schema ranking when its provider key is set. Lexical ranking
# (BM25) always works without it.
_DEFAULT_EMBEDDINGS = (
    ("OPENAI_API_KEY", "openai/text-embedding-3-small"),
    ("GEMINI_API_KEY", "gemini/gemini-embedding-001"),
)


def load_env() -> None:
    """Load the repo-root .env without overriding variables already set by the parent process."""
    env_file = REPO_ROOT / ".env"
    if env_file.is_file():
        load_dotenv(env_file, override=False)


def _int_env(name: str, default: int) -> int:
    value = os.environ.get(name, "").strip()
    return int(value) if value else default


def _list_env(name: str) -> list[str]:
    return [item.strip() for item in os.environ.get(name, "").split(",") if item.strip()]


@dataclass(frozen=True)
class Settings:
    model: str
    max_steps: int
    max_tool_chars: int
    max_tokens: int
    mcp_config: Path | None
    read_dsn: str | None
    app_dsn: str | None = None
    # EXPLAIN of an UPDATE/DELETE needs the write privilege even though nothing executes, so impact
    # estimates run on the write role inside a read-only transaction.
    write_dsn: str | None = None
    fallback_models: list[str] = field(default_factory=list)
    embedding_model: str | None = None
    max_history_chars: int = 60_000
    schema_max_tables: int = 12
    schema_max_chars: int = 14_000

    @classmethod
    def from_env(cls) -> "Settings":
        model = os.environ.get("AGENT2DB_MODEL", "").strip()
        if not model:
            model = next((m for key, m in _DEFAULT_MODELS if os.environ.get(key)), "openai/gpt-5-mini")
        embedding = os.environ.get("AGENT2DB_EMBEDDING_MODEL", "").strip()
        if embedding.lower() in {"off", "none", "0", "false"}:
            embedding = ""
        elif not embedding:
            embedding = next((m for key, m in _DEFAULT_EMBEDDINGS if os.environ.get(key)), "")
        mcp_config = os.environ.get("AGENT2DB_MCP_CONFIG", "").strip()
        if mcp_config:
            mcp_path = Path(mcp_config)
        elif (REPO_ROOT / "config" / "mcp.json").is_file():
            mcp_path = REPO_ROOT / "config" / "mcp.json"
        else:
            mcp_path = REPO_ROOT / "config" / "mcp.example.json"
        app_dsn = os.environ.get("AGENT2DB_APP_DSN") or os.environ.get("DATABASE_URL") or None
        return cls(
            model=model,
            max_steps=_int_env("AGENT2DB_MAX_STEPS", 15),
            max_tool_chars=_int_env("AGENT2DB_MAX_TOOL_CHARS", 12000),
            max_tokens=_int_env("AGENT2DB_MAX_TOKENS", 4096),
            mcp_config=mcp_path,
            read_dsn=os.environ.get("AGENT2DB_RO_DSN") or os.environ.get("DATABASE_URL") or None,
            app_dsn=app_dsn,
            write_dsn=os.environ.get("AGENT2DB_RW_DSN") or None,
            fallback_models=_list_env("AGENT2DB_FALLBACK_MODELS"),
            embedding_model=embedding or None,
            max_history_chars=_int_env("AGENT2DB_MAX_HISTORY_CHARS", 60_000),
            schema_max_tables=_int_env("AGENT2DB_SCHEMA_MAX_TABLES", 12),
            schema_max_chars=_int_env("AGENT2DB_SCHEMA_MAX_CHARS", 14_000),
        )
