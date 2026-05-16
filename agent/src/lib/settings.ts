// Runtime-mutable agent settings, backed by the `settings` key/value table.
// Loaded fresh on every read so a PATCH from the dashboard takes effect
// without a process restart. The watch loop calls getSettings() at the
// top of each scheduler tick.

import { getDb } from "../db.js";
import { WATCH_INTERVAL_MS } from "../config.js";

export type Settings = {
  // Base scheduler period in seconds. Posts with adaptive multiplier 1
  // poll once per `basePollIntervalSeconds`. Floor at 30s so a fat-finger
  // edit can't melt Reddit's rate limit; ceiling at 1h.
  basePollIntervalSeconds: number;
  // When false, every post polls at the base interval regardless of age.
  adaptivePollingEnabled: boolean;
};

const MIN_INTERVAL = 30;
const MAX_INTERVAL = 3600;

function defaultSettings(): Settings {
  return {
    basePollIntervalSeconds: Math.max(
      MIN_INTERVAL,
      Math.floor(WATCH_INTERVAL_MS / 1000),
    ),
    adaptivePollingEnabled: true,
  };
}

export function getSettings(): Settings {
  const db = getDb();
  const rows = db
    .prepare(`SELECT key, value FROM settings`)
    .all() as Array<{ key: string; value: string }>;
  const map = new Map(rows.map((r) => [r.key, r.value]));

  const defaults = defaultSettings();
  const baseRaw = map.get("base_poll_interval_seconds");
  const baseParsed = baseRaw === undefined ? NaN : Number(baseRaw);
  const base =
    Number.isFinite(baseParsed) && baseParsed >= MIN_INTERVAL
      ? Math.min(MAX_INTERVAL, Math.floor(baseParsed))
      : defaults.basePollIntervalSeconds;

  const adaptiveRaw = map.get("adaptive_polling_enabled");
  const adaptive =
    adaptiveRaw === undefined
      ? defaults.adaptivePollingEnabled
      : adaptiveRaw === "1";

  return {
    basePollIntervalSeconds: base,
    adaptivePollingEnabled: adaptive,
  };
}

// Partial update. Unspecified keys keep their current value. Clamps to
// the same bounds getSettings() uses so a bad value never lands in the DB.
export function updateSettings(patch: Partial<Settings>): Settings {
  const db = getDb();
  const upsert = db.prepare(
    `INSERT INTO settings(key, value) VALUES(?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );

  if (patch.basePollIntervalSeconds !== undefined) {
    const clamped = Math.max(
      MIN_INTERVAL,
      Math.min(MAX_INTERVAL, Math.floor(patch.basePollIntervalSeconds)),
    );
    upsert.run("base_poll_interval_seconds", String(clamped));
  }
  if (patch.adaptivePollingEnabled !== undefined) {
    upsert.run(
      "adaptive_polling_enabled",
      patch.adaptivePollingEnabled ? "1" : "0",
    );
  }
  return getSettings();
}

// Multiplier applied to the base interval based on how old the post is.
// Older posts move slower because their score/comment velocity flattens.
// Returns the integer multiplier; callers multiply by basePollIntervalSeconds.
//
// Cutoffs are deliberately coarse — pick a bucket, not a continuous decay,
// because each post moves on second-by-second clock comparisons and the
// extra precision doesn't change behavior meaningfully.
const HOUR = 3600;
const DAY = 86_400;
export function adaptiveMultiplier(ageSeconds: number): number {
  if (ageSeconds < HOUR) return 1; // fresh post, full speed
  if (ageSeconds < DAY) return 2; // 1h-24h old
  if (ageSeconds < 7 * DAY) return 10; // 1d-7d
  if (ageSeconds < 30 * DAY) return 60; // 7d-30d
  return 360; // 30d+
}
