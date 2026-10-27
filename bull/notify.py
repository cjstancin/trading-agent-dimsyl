"""Phone pings via ntfy — only for real trouble, and never the same one twice an hour."""
from __future__ import annotations

import json
import logging
import os
import time
import urllib.request

from .config import load_env, runtime_dir

log = logging.getLogger("bull.notify")


def ping(key: str, title: str, message: str, priority: str = "high", every_s: int = 3600) -> None:
    load_env()
    url, topic, token = (os.environ.get(k) for k in ("NTFY_URL", "NTFY_TOPIC", "NTFY_TOKEN"))
    seen_path = runtime_dir() / "notify-seen.json"
    try:
        seen = json.loads(seen_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        seen = {}
    if time.time() - seen.get(key, 0) < every_s:
        return
    seen[key] = time.time()
    seen_path.write_text(json.dumps(seen), encoding="utf-8")
    log.warning("PING %s: %s", title, message)
    if not (url and topic):
        return
    req = urllib.request.Request(f"{url.rstrip('/')}/{topic}", data=message.encode(), method="POST",
                                 headers={"Title": f"Bull: {title}", "Priority": priority, "Tags": "chart_with_downwards_trend"})
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        urllib.request.urlopen(req, timeout=10).read()
    except Exception as exc:  # a failed ping must never take the engine down
        log.warning("ntfy failed: %s", exc)
