"""Per-platform deterministic browser automations.

Each module exposes async functions that drive a real Chromium (via Playwright)
through a hand-written, selector-stable flow for that platform. No LLM is
involved at this layer — the Node agent has already drafted/approved the
content by the time we get called, and our job is to mechanically deliver it.

Add a new platform by dropping a new module here and wiring it into app.py's
dispatcher.
"""
