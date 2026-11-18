"""Optional LLM narration of research reports.

The research pipeline is fully deterministic and never depends on an LLM. When enabled
(ATLAS_LLM_PROVIDER=anthropic and `pip install anthropic`, credentials via ANTHROPIC_API_KEY or
ATLAS_ANTHROPIC_API_KEY), the LLM only rewrites an already-computed report as prose. It receives
numbers, never makes decisions, and its output is labelled as LLM-generated."""
from __future__ import annotations

import json
import logging

from ..config import get_settings

log = logging.getLogger("atlas.llm")

SYSTEM = ("You are the narrator for a quantitative research platform. Summarise the JSON research report "
          "in at most 180 words of plain prose for a researcher. Use only numbers present in the report. "
          "State clearly that backtests are historical simulations and not evidence of future profitability. "
          "Never recommend live trading.")


def llm_status() -> dict:
    s = get_settings()
    if s.llm_provider != "anthropic":
        return {"enabled": False, "provider": "none", "reason": "ATLAS_LLM_PROVIDER is not 'anthropic'"}
    try:
        import anthropic  # noqa: F401
    except ImportError:
        return {"enabled": False, "provider": "anthropic", "reason": "`anthropic` package not installed"}
    return {"enabled": True, "provider": "anthropic", "model": s.anthropic_model}


def narrate(report: dict) -> dict | None:
    """Return {"text", "model", "label"} or None when disabled/failed (failure is logged, never raised)."""
    if not llm_status()["enabled"]:
        return None
    import anthropic

    s = get_settings()
    client = anthropic.Anthropic(api_key=s.anthropic_api_key) if s.anthropic_api_key else anthropic.Anthropic()
    try:
        resp = client.beta.messages.create(
            model=s.anthropic_model,
            max_tokens=2000,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            output_config={"effort": "low"},
            system=SYSTEM,
            messages=[{"role": "user", "content": json.dumps(report, default=str)[:60000]}],
        )
    except anthropic.APIStatusError as e:
        log.warning("LLM narration failed (%s): %s", e.status_code, e.message)
        return None
    except anthropic.APIConnectionError as e:
        log.warning("LLM narration connection error: %s", e)
        return None
    if resp.stop_reason == "refusal":
        return None
    text = "".join(b.text for b in resp.content if b.type == "text").strip()
    return {"text": text, "model": resp.model, "label": "LLM-generated narration of deterministic results"} if text else None
