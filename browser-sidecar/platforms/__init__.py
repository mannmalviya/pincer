"""Per-platform deterministic browser automations.

Each module exposes async functions that drive a real Chromium (via Playwright)
through a hand-written, selector-stable flow for that platform. No LLM is
involved at this layer — the Node agent has already drafted/approved the
content by the time we get called, and our job is to mechanically deliver it.

Add a new platform by dropping a new module here and wiring it into app.py's
dispatcher.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

log = logging.getLogger("pincer.sidecar")


def clear_stale_singleton(profile_dir: str) -> None:
    """Remove leftover Chromium Singleton* lock files when their owner PID
    is dead.

    Chromium uses SingletonLock (a symlink whose target is "<hostname>-<pid>")
    to enforce one process per --user-data-dir. When the prior Chromium
    crashes, is SIGKILLed, or is `pkill`ed, the lock survives. The next
    launch_persistent_context sees the lock, tries to forward to the
    "existing browser session", finds no one listening, and aborts —
    surfacing to Playwright as a TargetClosedError.

    This helper is idempotent and conservative: if the owner PID is still
    alive (legitimate in-flight session), we leave everything alone.
    Only when the PID is dead do we sweep SingletonLock + Cookie + Socket.
    """
    lock = Path(profile_dir) / "SingletonLock"
    if not lock.is_symlink():
        return

    target = os.readlink(lock)
    # "<hostname>-<pid>" — split from the right since hostnames can
    # themselves contain dashes.
    _, _, pid_str = target.rpartition("-")
    try:
        pid = int(pid_str)
    except ValueError:
        # Malformed target. Don't guess; surface the underlying issue
        # by leaving the file in place.
        log.warning("malformed SingletonLock target %r — leaving in place", target)
        return

    # /proc/<pid> exists iff the process is alive (Linux). The sidecar
    # only runs on Linux (Brev host), so this check is sufficient.
    if Path(f"/proc/{pid}").exists():
        return

    log.info("removing stale Chromium Singleton* files (owner pid=%d dead)", pid)
    for name in ("SingletonLock", "SingletonCookie", "SingletonSocket"):
        (Path(profile_dir) / name).unlink(missing_ok=True)
