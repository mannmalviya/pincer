// GET/PATCH /settings — surface the agent's user-tweakable knobs to the
// dashboard. Only two settings exist today: base poll interval (seconds)
// and adaptive polling toggle. The PATCH handler re-applies the watch
// loop's timer immediately so a changed interval doesn't wait for the
// next process restart to take effect.

import type { FastifyInstance } from "fastify";

import { getSettings, updateSettings } from "../lib/settings.js";
import { applyWatchSettings } from "../watch/loop.js";

const PATCH_BODY_SCHEMA = {
  type: "object",
  properties: {
    base_poll_interval_seconds: { type: "number", minimum: 30, maximum: 3600 },
    adaptive_polling_enabled: { type: "boolean" },
  },
  additionalProperties: false,
} as const;

export function registerSettingsRoute(app: FastifyInstance): void {
  app.get("/settings", async () => {
    const s = getSettings();
    return {
      base_poll_interval_seconds: s.basePollIntervalSeconds,
      adaptive_polling_enabled: s.adaptivePollingEnabled,
    };
  });

  app.patch<{
    Body: {
      base_poll_interval_seconds?: number;
      adaptive_polling_enabled?: boolean;
    };
  }>(
    "/settings",
    { schema: { body: PATCH_BODY_SCHEMA } },
    async (req) => {
      const updated = updateSettings({
        ...(req.body.base_poll_interval_seconds !== undefined && {
          basePollIntervalSeconds: req.body.base_poll_interval_seconds,
        }),
        ...(req.body.adaptive_polling_enabled !== undefined && {
          adaptivePollingEnabled: req.body.adaptive_polling_enabled,
        }),
      });
      // Re-schedule the watch loop with the new base interval. No-op if
      // the interval didn't actually change.
      applyWatchSettings();
      return {
        base_poll_interval_seconds: updated.basePollIntervalSeconds,
        adaptive_polling_enabled: updated.adaptivePollingEnabled,
      };
    },
  );
}
