import { getDb } from "../db.js";
import { env } from "../env.js";

/**
 * User-editable settings, stored in the sync_meta key/value table so they can
 * be changed from the UI without editing .env and restarting. Environment
 * variables still work as a fallback when a setting is unset.
 */

export const SETTING_KEYS = ["steam_api_key", "steam_id", "rawg_api_key"] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

const SECRET_KEYS: ReadonlySet<SettingKey> = new Set(["steam_api_key", "rawg_api_key"]);

const ENV_FALLBACK: Record<SettingKey, () => string> = {
  steam_api_key: () => env.steamApiKey,
  steam_id: () => env.steamId,
  rawg_api_key: () => env.rawgApiKey,
};

function getStored(key: SettingKey): string {
  const row = getDb().prepare("SELECT value FROM sync_meta WHERE key = ?").get(`setting:${key}`) as
    { value: string } | undefined;
  return row?.value ?? "";
}

/** Resolved value: stored setting first, then environment variable. */
export function getSetting(key: SettingKey): string {
  return getStored(key) || ENV_FALLBACK[key]();
}

export function setSetting(key: SettingKey, value: string): void {
  const db = getDb();
  if (value) {
    db.prepare(
      "INSERT INTO sync_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(`setting:${key}`, value);
  } else {
    db.prepare("DELETE FROM sync_meta WHERE key = ?").run(`setting:${key}`);
  }
}

export interface SettingInfo {
  configured: boolean;
  source: "settings" | "env" | null;
  /** Full value for non-secret settings, last 4 characters for API keys. */
  preview: string | null;
}

export function describeSettings(): Record<SettingKey, SettingInfo> {
  const out = {} as Record<SettingKey, SettingInfo>;
  for (const key of SETTING_KEYS) {
    const stored = getStored(key);
    const value = stored || ENV_FALLBACK[key]();
    out[key] = {
      configured: !!value,
      source: stored ? "settings" : value ? "env" : null,
      preview: value ? (SECRET_KEYS.has(key) ? `…${value.slice(-4)}` : value) : null,
    };
  }
  return out;
}
