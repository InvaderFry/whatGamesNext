import { Router } from "express";
import { describeSettings, setSetting, SETTING_KEYS, type SettingKey } from "../lib/settings.js";

export const settingsRouter = Router();

settingsRouter.get("/settings", (_req, res) => {
  res.json(describeSettings());
});

settingsRouter.put("/settings", (req, res) => {
  const body = req.body as Record<string, unknown>;
  const updates: [SettingKey, string][] = [];
  for (const key of SETTING_KEYS) {
    if (!(key in body)) continue;
    const value = body[key];
    if (value !== null && typeof value !== "string") {
      return res.status(400).json({ error: `${key} must be a string or null` });
    }
    updates.push([key, (value ?? "").trim()]);
  }
  if (!updates.length) {
    return res
      .status(400)
      .json({ error: `body must include at least one of: ${SETTING_KEYS.join(", ")}` });
  }
  for (const [key, value] of updates) setSetting(key, value);
  res.json(describeSettings());
});
