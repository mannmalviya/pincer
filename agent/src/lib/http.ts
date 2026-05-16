// Thin wrapper around the native fetch() that handles the three things we
// always want for outbound Reddit / HN calls:
//
//   1. The User-Agent header. Reddit's API bans anonymous fetch UAs on
//      sight; this header is non-negotiable.
//   2. A 10s timeout. Reddit and HN occasionally hang for tens of seconds
//      on transient infra issues; we'd rather fail a single tick than have
//      the whole watch loop block.
//   3. JSON parsing with a typed return. The fetchers in platforms/*.ts
//      have specific response shapes — they cast through this helper.
//
// Deliberately small. If we need retries, backoff, or auth headers later,
// add them here.

import { USER_AGENT } from "../config.js";

const DEFAULT_TIMEOUT_MS = 10_000;

export async function getJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} on ${url}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}
