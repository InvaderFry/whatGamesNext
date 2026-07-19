import { useCallback, useEffect, useRef, useState } from "react";
import { api, type SyncStatus } from "../api";

export default function Settings() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [manualText, setManualText] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await api.syncStatus();
      setStatus(s);
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
        <h3>Steam</h3>
        <p className="hint">
          {status?.config.steamConfigured ? (
            <span className="status-ok">API key and SteamID configured.</span>
          ) : (
            <span className="status-warn">
              Set STEAM_API_KEY and STEAM_ID in .env — get a key at{" "}
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
              RAWG_API_KEY is not set (free at{" "}
              <a href="https://rawg.io/apidocs" target="_blank" rel="noreferrer">
                rawg.io/apidocs
              </a>
              ) — ratings will be skipped.
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
        {enrich?.lastError && <p className="hint status-warn">Last error: {enrich.lastError}</p>}
      </div>
    </>
  );
}
