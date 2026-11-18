"""Runtime configuration. All values can be overridden with ATLAS_* environment variables
(or a .env file in the backend directory). Secrets are never hardcoded."""
from __future__ import annotations

import subprocess
from functools import lru_cache
from typing import Literal
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = BACKEND_DIR.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="ATLAS_", env_file=BACKEND_DIR / ".env", extra="ignore")

    data_dir: Path = REPO_DIR / "data"
    db_filename: str = "atlas.db"

    # Market data
    history_start: str = "2015-01-01"
    # Extra liquid crypto to research besides BTC and ETH, e.g. "SOL,XRP" (see data/instruments.py LIQUID_CRYPTO)
    crypto_assets: str = ""
    # Historical intraday candles kept for charts (research itself runs on completed daily bars)
    intraday_history_days: dict[str, int] = {"1h": 60, "6h": 365}
    # "personal": all integrated sources usable for your own research.
    # "beta": only sources whose licence was verified to allow showing data to other people (docs/DATA_LICENSING.md)
    deployment_mode: Literal["personal", "beta"] = "personal"
    # Cross-source check: flag days where primary and secondary closes differ by more than this
    cross_source_tolerance_bps: float = 50.0
    http_timeout_s: float = 20.0
    provider_min_interval_s: float = 0.35  # simple client-side rate limit per provider

    # Autonomous research loop (defaults are deliberately conservative)
    autonomy_on_start: bool = False
    research_interval_minutes: int = Field(default=60, ge=5)
    data_refresh_minutes: int = Field(default=30, ge=5)
    max_hypotheses_per_cycle: int = Field(default=12, ge=1, le=200)
    max_cycles_per_day: int = Field(default=24, ge=1, le=288)
    max_job_runtime_s: int = Field(default=900, ge=30)
    worker_threads: int = Field(default=2, ge=1, le=8)

    # Paper trading
    paper_initial_cash: float = 100_000.0

    # Optional LLM narration of research reports. Disabled unless a key is provided.
    llm_provider: str = "none"  # "none" | "anthropic"
    anthropic_api_key: str | None = None
    anthropic_model: str = "claude-opus-5-5"

    cors_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]

    @property
    def db_path(self) -> Path:
        return self.data_dir / self.db_filename

    @property
    def snapshot_dir(self) -> Path:
        return self.data_dir / "snapshots"


@lru_cache
def get_settings() -> Settings:
    s = Settings()
    s.data_dir.mkdir(parents=True, exist_ok=True)
    s.snapshot_dir.mkdir(parents=True, exist_ok=True)
    return s


@lru_cache
def code_version() -> str:
    """Git commit of the running code (with -dirty suffix) for experiment reproducibility."""
    try:
        sha = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=REPO_DIR, capture_output=True,
                             text=True, timeout=5).stdout.strip()
        dirty = subprocess.run(["git", "status", "--porcelain", "--", "backend/atlas"], cwd=REPO_DIR,
                               capture_output=True, text=True, timeout=5).stdout.strip()
        return f"{sha}{'-dirty' if dirty else ''}" or "unknown"
    except Exception:
        return "unknown"
