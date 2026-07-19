import { useCallback, useEffect, useRef, useState } from "react";
import { api, type SettingsMap, type SyncStatus } from "../api";

const SETTING_FIELDS: [keyof SettingsMap, string, string][] = [
  ["steam_api_key", "Steam API key", "From steamcommunity.com/dev/apikey"],
  ["steam_id", "SteamID64", "Your 17-digit SteamID (steamid.io can find it)"],
  ["rawg_api_key", "RAWG API key", "Free at rawg.io/apidocs — used for ratings"],
];

export default function Settings() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [settings, setSettings] = useState<SettingsMap | null>(null);
  const [drafts, setDrafts] = useState<Partial<Record<keyof SettingsMap, string>>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [manualText, setManualText] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, cfg] = await Promise.all([api.syncStatus(), api.settings()]);
      setStatus(s);
      setSettings(cfg);
      if (!s.enrichment.running && pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [refresh]);

  function startPolling() {
    if (!pollRef.current) pollRef.current = setInterval(() => void refresh(), 2000);
  }

  async function run(name: string, fn: () => Promise<unknown>, successMsg: (r: never) => string) {
    setBusy(name);
    setError(null);
    setMessage(null);
    try {
      const r = await fn();
      setMessage(successMsg(r as never));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function saveSettings() {
    const patch: Partial<Record<keyof SettingsMap, string>> = {};
    for (const [key, value] of Object.entries(drafts)) {
      if (value.trim()) patch[key as keyof SettingsMap] = value.trim();
    }
    if (!Object.keys(patch).length) return;
    await run(
      "settings",
      () => api.saveSettings(patch),
      () => "Settings saved.",
    );
    setDrafts({});
  }

  async function clearSetting(key: keyof SettingsMap) {
    await run(
      "settings",
      () => api.saveSettings({ [key]: null }),
      () => "Setting cleared.",
    );
  }

  const enrich = status?.enrichment;
  const lib = status?.library;

  return (
    <>
      {message && <div className="notice">{message}</div>}
      {error && <div className="notice error">{error}</div>}

      <div className="settings-card">
        <h3>Library</h3>
        {lib && (
          <p className="hint">
            {lib.total} games total — {lib.steam} on Steam, {lib.epic} on Epic. {lib.enriched}{" "}
            enriched
            {lib.enrich_failed > 0 && (
              <span className="status-warn">, {lib.enrich_failed} failed</span>
            )}
            .
          </p>
        )}
        {status?.config.demo && (
          <p className="hint status-warn">
            Demo mode is on (DEMO=1) — the library is seeded with sample games.
          </p>
        )}
      </div>

      <div className="settings-card">
        <h3>API keys</h3>
        <p className="hint">
          Stored locally in the app's database — no restart needed. A value from <code>.env</code>{" "}
          is used as a fallback when a field is unset here.
        </p>
        {SETTING_FIELDS.map(([key, label, help]) => {
          const info = settings?.[key];
          return (
            <div className="row" key={key}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, flex: 1 }}>
                <span style={{ minWidth: 110, fontSize: 13 }}>{label}</span>
                <input
                  type="text"
                  style={{ flex: 1 }}
                  placeholder={
                    info?.configured
                      ? `configured (${info.preview}${info.source === "env" ? ", from .env" : ""})`
                      : help
                  }
                  value={drafts[key] ?? ""}
                  onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))}
                />
              </label>
              {info?.source === "settings" && (
                <button
                  className="btn secondary"
                  disabled={busy !== null}
                  onClick={() => void clearSetting(key)}
                >
                  Clear
                </button>
              )}
            </div>
          );
        })}
        <div className="row">
          <button
            className="btn"
            disabled={busy !== null || !Object.values(drafts).some((v) => v.trim())}
            onClick={() => void saveSettings()}
          >
            {busy === "settings" ? "Saving…" : "Save settings"}
          </button>
        </div>
      </div>

      <div className="settings-card">
        <h3>Steam</h3>
        <p className="hint">
          {status?.config.steamConfigured ? (
            <span className="status-ok">API key and SteamID configured.</span>
          ) : (
            <span className="status-warn">
              Enter your Steam API key and SteamID64 under API keys above — get a key at{" "}
              <a href="https://steamcommunity.com/dev/apikey" target="_blank" rel="noreferrer">
                steamcommunity.com/dev/apikey
              </a>
              .
            </span>
          )}
        </p>
        <div className="row">
          <button
            className="btn"
            disabled={busy !== null || !status?.config.steamConfigured}
            onClick={() =>
              void run(
                "steam",
                api.syncSteam,
                (r: { fetched: number; added: number }) =>
                  `Steam: fetched ${r.fetched} games, ${r.added} new.`,
              )
            }
          >
            {busy === "steam" ? "Syncing…" : "Sync Steam library"}
          </button>
        </div>
      </div>

      <div className="settings-card">
        <h3>Epic Games</h3>
        <p className="hint">
          Uses the{" "}
          <a href="https://github.com/derrod/legendary" target="_blank" rel="noreferrer">
            legendary
          </a>{" "}
          CLI (<code>pip install legendary-gl</code>, then <code>legendary auth</code>). If you
          don't want to install it, paste your game titles below instead, one per line.
        </p>
        <div className="row">
          <button
            className="btn"
            disabled={busy !== null}
            onClick={() =>
              void run(
                "epic",
                api.syncEpic,
                (r: { fetched: number; added: number }) =>
                  `Epic: fetched ${r.fetched} games, ${r.added} new.`,
              )
            }
          >
            {busy === "epic" ? "Syncing…" : "Sync via legendary"}
          </button>
        </div>
        <div className="row">
          <textarea
            rows={5}
            placeholder={"Alan Wake 2\nControl\nOuter Wilds"}
            value={manualText}
            onChange={(e) => setManualText(e.target.value)}
          />
        </div>
        <div className="row">
          <button
            className="btn secondary"
            disabled={busy !== null || !manualText.trim()}
            onClick={() =>
              void run(
                "epic-manual",
                () => api.syncEpicManual(manualText),
                (r: { fetched: number; added: number }) =>
                  `Imported ${r.fetched} Epic titles, ${r.added} new.`,
              )
            }
          >
            Import pasted titles
          </button>
        </div>
      </div>

      <div className="settings-card">
        <h3>Enrichment</h3>
        <p className="hint">
          Fills in Metacritic/RAWG ratings, HowLongToBeat lengths, Steam review scores, and
          estimated difficulty for every synced game. Rate-limited to be polite — a large library
          takes a while, and you can close the tab and come back.{" "}
          {!status?.config.rawgConfigured && (
            <span className="status-warn">
              No RAWG API key set (free at{" "}
              <a href="https://rawg.io/apidocs" target="_blank" rel="noreferrer">
                rawg.io/apidocs
              </a>
              , enter it under API keys above) — ratings will be skipped.
            </span>
          )}
        </p>
        <div className="row">
          <button
            className="btn"
            disabled={busy !== null || enrich?.running}
            onClick={() => {
              void run("enrich", api.startEnrich, () => "Enrichment started.");
              startPolling();
            }}
          >
            {enrich?.running ? "Enriching…" : "Start enrichment"}
          </button>
          {lib && lib.enrich_failed > 0 && (
            <button
              className="btn secondary"
              disabled={busy !== null || enrich?.running}
              onClick={() => {
                void run(
                  "retry",
                  api.retryFailedEnrich,
                  (r: { requeued: number }) => `Requeued ${r.requeued} failed games.`,
                );
                startPolling();
              }}
            >
              Retry {lib.enrich_failed} failed
            </button>
          )}
        </div>
        {enrich?.running && (
          <>
            <p className="hint">
              {enrich.done + enrich.failed} / {enrich.total}
              {enrich.current && <> — currently: {enrich.current}</>}
            </p>
            <div className="progress-bar">
              <div
                style={{
                  width: `${((enrich.done + enrich.failed) / Math.max(1, enrich.total)) * 100}%`,
                }}
              />
            </div>
          </>
        )}
        {enrich?.hltbUnavailable && (
          <p className="hint status-warn">
            HowLongToBeat looks unreachable right now — game lengths are being skipped. They'll be
            filled in if you re-run enrichment once it's back.
          </p>
        )}
        {enrich?.lastError && <p className="hint status-warn">Last error: {enrich.lastError}</p>}
      </div>
    </>
  );
}
