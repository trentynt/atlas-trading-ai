"""Loader for config/apex_rules.toml. Refuses unverified rules: ATLAS never guesses prop-firm rules."""
from __future__ import annotations

import tomllib
from pathlib import Path

PATH = Path(__file__).resolve().parents[2] / "config" / "apex_rules.toml"


class UnverifiedRules(RuntimeError):
    pass


def load(path: Path = PATH, require_verified: bool = True) -> dict:
    rules = tomllib.loads(path.read_text())
    if require_verified and not rules.get("verified"):
        raise UnverifiedRules(f"{path.name} is not verified. Fill it in from apextraderfunding.com and set verified = true.")
    if rules.get("verified") and not (rules.get("verified_on") and rules.get("source_url")):
        raise UnverifiedRules("verified = true needs verified_on and source_url (where and when you read the rules).")
    return rules
