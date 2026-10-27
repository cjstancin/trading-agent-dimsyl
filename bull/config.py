"""Settings: config.toml holds the knobs (committed), .env holds keys (never committed)."""
from __future__ import annotations

import os
import tomllib
from datetime import time
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
ET = ZoneInfo("America/New_York")


def runtime_dir() -> Path:
    path = Path(os.environ.get("BULL_RUNTIME", ROOT / "runtime"))
    path.mkdir(parents=True, exist_ok=True)
    return path


def load_env(path: Path | None = None) -> None:
    path = path or ROOT / ".env"
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def load_config(path: Path | None = None) -> dict:
    path = path or Path(os.environ.get("BULL_CONFIG", ROOT / "config.toml"))
    with open(path, "rb") as f:
        cfg = tomllib.load(f)
    assert_paper(cfg)
    return cfg


def assert_paper(cfg: dict) -> None:
    """Paper is the only mode v3 knows. Any hint of live trading stops the process."""
    if cfg.get("account", {}).get("paper") is not True:
        raise SystemExit("config.toml [account] paper must be true — v3 is paper-only")
    base = os.environ.get("ALPACA_BASE_URL", "")
    if base and "paper-api.alpaca.markets" not in base:
        raise SystemExit(f"ALPACA_BASE_URL={base!r} is not the paper endpoint — refusing to run")


def alpaca_keys() -> tuple[str, str]:
    load_env()
    key = os.environ.get("ALPACA_API_KEY")
    secret = os.environ.get("ALPACA_SECRET_KEY") or os.environ.get("ALPACA_API_SECRET")
    if not key or not secret:
        raise SystemExit("ALPACA_API_KEY / ALPACA_SECRET_KEY missing from .env")
    return key, secret


def hhmm(value: str) -> time:
    h, m = value.split(":")
    return time(int(h), int(m))


def variants(cfg: dict) -> list[dict]:
    return cfg.get("variant", [])


def shadow_variants(cfg: dict) -> list[dict]:
    return cfg.get("shadow", [])


def universe() -> list[str]:
    lines = (ROOT / "universe.txt").read_text(encoding="utf-8").splitlines()
    return [s.strip().upper() for s in lines if s.strip() and not s.startswith("#")]
