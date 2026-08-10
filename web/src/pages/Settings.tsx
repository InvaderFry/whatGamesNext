import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  STORE_LABEL,
  type MergeNote,
  type RestoreSummary,
  type SettingsMap,
  type SyncResult,
  type SyncStatus,
} from "../api";

function formatEta(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatWhen(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(iso).toLocaleDateString();
}

function summarizeRestore(r: RestoreSummary): string {
  const parts = [`Restored ${r.restored} game${r.restored === 1 ? "" : "s"}.`];
  if (r.unchanged > 0) parts.push(`${r.unchanged} already matched the backup.`);
  // Naming them beats a count: the usual cause is a store not synced yet, and
  // the titles are what tell you which one.
  if (r.notFound.length > 0) {
    const names = r.notFound.slice(0, 5).join(", ");
    const rest = r.notFound.length > 5 ? ` and ${r.notFound.length - 5} more` : "";
    parts.push(`Not in your library yet: ${names}${rest} — sync first, then restore again.`);
  }
  return parts.join(" ");
}

interface SettingField {
  key: keyof SettingsMap;
  label: string;
  help: string;
  /** Masked until asked for. Cover for whoever is stood behind you, no more. */
  secret: boolean;
}

const SETTING_FIELDS: SettingField[] = [
  {
    key: "steam_api_key",
    label: "Steam API key",
    help: "From steamcommunity.com/dev/apikey",
    secret: true,
  },
  {
    key: "steam_id",
    label: "SteamID64",
    help: "Your 17-digit SteamID (steamid.io can find it)",
    // Not a secret: it's the number in your own profile URL, and masking it
    // would imply a secrecy it doesn't have.
    secret: false,
  },
  {
    key: "rawg_api_key",
    label: "RAWG API key",
    help: "Free at rawg.io/apidocs — used for ratings",
    secret: true,
  },
];

export default function Settings() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [settings, setSettings] = useState<SettingsMap | null>(null);
  const [drafts, setDrafts] = useState<Partial<Record<keyof SettingsMap, string>>>({});
  const [revealed, setRevealed] = useState<Partial<Record<keyof SettingsMap, boolean>>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [manualText, setManualText] = useState("");
  const [importText, setImportText] = useState("");
  const [importStore, setImportStore] = useState("gog");
  const [justAdded, setJustAdded] = useState<number | null>(null);
  const [merged, setMerged] = useState<MergeNote[]>([]);
  const offerRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, cfg] = await Promise.all([api.syncStatus(), api.settings()]);
      setStatus(s);
      setSettings(cfg);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Enrichment is a long server-side run that outlives the page, so what drives
  // the poll is the server saying it's running — not the click that started it.
  // Started from another tab, or reloaded halfway through, this picks it up on
  // the first status response either way. It used to hang off the buttons, and
  // a reload mid-run left the progress bar frozen on one snapshot.
  const running = status?.enrichment.running ?? false;
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => void refresh(), 2000);
    return () => clearInterval(id);
  }, [running, refresh]);

  /** Returns the result, or undefined if the call failed. */
  async function run<T>(
    name: string,
    fn: () => Promise<T>,
    successMsg: (r: T) => string,
  ): Promise<T | undefined> {
    setBusy(name);
    setError(null);
    setMessage(null);
    // Merges belong to the action that caused them. Left up, the list reads as
    // if the next thing you clicked had done it.
    setMerged([]);
    try {
      const r = await fn();
      setMessage(successMsg(r));
      await refresh();
      return r;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return undefined;
    } finally {
      setBusy(null);
    }
  }

  /** A sync that brought in new games offers to enrich them, rather than
   *  leaving the user to find the button on their own. */
  async function runSync(name: string, fn: () => Promise<SyncResult>, label: string) {
    const r = await run(name, fn, (r) => {
      const parts = [`${label}: fetched ${r.fetched} games, ${r.added} new.`];
      // The promotion sweep is library-wide, so it's reported as its own fact
      // rather than folded into this sync's tally.
      if (r.promoted > 0) {
        parts.push(
          `${r.promoted} game${r.promoted === 1 ? "" : "s"} marked as playing based on playtime.`,
        );
      }
      return parts.join(" ");
    });
    if (r && r.added > 0) setJustAdded(r.added);
    setMerged(r?.merged ?? []);
  }

  async function restore(file: File | undefined) {
    if (!file) return;
    const text = await file.text();
    await run("restore", () => api.restoreBackup(text), summarizeRestore);
    // Clearing the input means picking the same file again re-runs it, which is
    // what you want after fixing a sync and retrying.
    if (restoreRef.current) restoreRef.current.value = "";
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
  const pending = lib?.enrich_pending ?? 0;
  const offerEnrich = justAdded != null && pending > 0 && !enrich?.running;

  // The sync buttons are scattered down a long page, so the offer renders well
  // above wherever the user just clicked. Bring it to them.
  useEffect(() => {
    if (offerEnrich) offerRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [offerEnrich]);

  return (
    <>
      {message && <div className="notice">{message}</div>}
      {error && <div className="notice error">{error}</div>}

      {/* Matching on title is how a game owned on two stores becomes one row,
          and it is also the only way two different games can be combined by
          mistake. Same event either way, so it is reported rather than judged. */}
      {merged.length > 0 && (
        <div className="notice">
          <p style={{ margin: "0 0 8px" }}>
            Folded {merged.length} title{merged.length === 1 ? "" : "s"} into entries you already
            had. That is what you want for a game you own twice — if two of these are actually
            different games, mark one hidden or rename it in the source list.
          </p>
          <ul className="merge-list">
            {merged.map((m) => (
              <li key={`${m.title}-${m.into}`}>
                {m.title} → {m.into} <span className="hint">(was {STORE_LABEL[m.store]})</span>
              </li>
            ))}
          </ul>
          <button className="btn secondary" onClick={() => setMerged([])}>
            Dismiss
          </button>
        </div>
      )}

      {offerEnrich && (
        <div className="notice" ref={offerRef}>
          <p style={{ margin: "0 0 10px" }}>
            Added {justAdded} game{justAdded === 1 ? "" : "s"}. {pending} game
            {pending === 1 ? " has" : "s have"} no ratings, lengths or difficulty yet, and the
            recommendations lean on all three.
          </p>
          <div className="row" style={{ margin: 0 }}>
            <button
              className="btn"
              disabled={busy !== null}
              onClick={() => {
                setJustAdded(null);
                void run("enrich", api.startEnrich, () => "Enrichment started.");
              }}
            >
              Enrich {pending} game{pending === 1 ? "" : "s"} now
            </button>
            <button className="btn secondary" onClick={() => setJustAdded(null)}>
              Later
            </button>
          </div>
        </div>
      )}

      <div className="settings-card">
        <h3>Library</h3>
        {lib && (
          <p className="hint">
            {lib.total} games total — {lib.steam} on Steam, {lib.epic} on Epic
            {lib.other > 0 && `, ${lib.other} elsewhere`}. {lib.enriched} enriched
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
        {SETTING_FIELDS.map(({ key, label, help, secret }) => {
          const info = settings?.[key];
          const shown = !secret || revealed[key];
          return (
            <div className="row" key={key}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, flex: 1 }}>
                <span style={{ minWidth: 110, fontSize: 13 }}>{label}</span>
                <input
                  type={shown ? "text" : "password"}
                  style={{ flex: 1 }}
                  // A key isn't a word and isn't worth offering back later.
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={
                    info?.configured
                      ? `configured (${info.preview}${info.source === "env" ? ", from .env" : ""})`
                      : help
                  }
                  value={drafts[key] ?? ""}
                  onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))}
                />
              </label>
              {/* Outside the label on purpose: inside it, clicking the toggle
                  would also focus the input it's covering. Both this and Clear
                  name their own field — three buttons all called "Clear" is a
                  screen reader being told nothing. */}
              {secret ? (
                <button
                  className="btn secondary reveal-toggle"
                  aria-label={`${shown ? "Hide" : "Show"} ${label}`}
                  onClick={() => setRevealed((r) => ({ ...r, [key]: !r[key] }))}
                >
                  {shown ? "Hide" : "Show"}
                </button>
              ) : (
                // Holds the toggle's column open so this row's input ends where
                // the other two do. Decorative, hence hidden from the tree.
                <span className="reveal-toggle" aria-hidden="true" />
              )}
              {info?.source === "settings" && (
                <button
                  className="btn secondary"
                  aria-label={`Clear ${label}`}
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
            onClick={() => void runSync("steam", api.syncSteam, "Steam")}
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
            onClick={() => void runSync("epic", api.syncEpic, "Epic")}
          >
            {busy === "epic" ? "Syncing…" : "Sync via legendary"}
          </button>
        </div>
        <div className="row">
          <textarea
            rows={5}
            aria-label="Epic game titles, one per line"
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
              void runSync("epic-manual", () => api.syncEpicManual(manualText), "Epic paste")
            }
          >
            Import pasted titles
          </button>
        </div>
      </div>

      <div className="settings-card">
        <h3>Other stores</h3>
        <p className="hint">
          GOG, itch.io, Humble, physical — paste titles one per line, or CSV with a{" "}
          <code>title</code> column (and optional <code>playtime_hours</code>). Games you already
          own on Steam/Epic are matched by title and not duplicated.
        </p>
        <div className="row">
          <select
            aria-label="Store to import into"
            value={importStore}
            onChange={(e) => setImportStore(e.target.value)}
          >
            <option value="gog">GOG</option>
            <option value="itch">itch.io</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div className="row">
          <textarea
            rows={5}
            aria-label="Titles to import, one per line or CSV"
            placeholder={
              "The Witcher 3\nDisco Elysium\n\nor:\ntitle,playtime_hours\nCyberpunk 2077,42"
            }
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
          />
        </div>
        <div className="row">
          <button
            className="btn secondary"
            disabled={busy !== null || !importText.trim()}
            onClick={() =>
              void runSync("import", () => api.syncImport(importStore, importText), "Import")
            }
          >
            Import titles
          </button>
        </div>
      </div>

      <div className="settings-card">
        <h3>Backup</h3>
        <p className="hint">
          Your statuses, ratings, notes, shortlist, finish dates, hidden games and difficulty
          overrides — the only things here that a re-sync can't rebuild. Games with nothing on them
          are left out, since re-syncing brings those back as they were. JSON round-trips exactly;
          CSV is the same data for a spreadsheet.
        </p>
        <div className="row">
          <a className="btn" href={api.exportUrl("json")} download>
            Download JSON
          </a>
          <a className="btn secondary" href={api.exportUrl("csv")} download>
            Download CSV
          </a>
        </div>
        <div className="row">
          <label style={{ display: "flex", alignItems: "center", gap: 8, flex: 1 }}>
            <span style={{ minWidth: 110, fontSize: 13 }}>Restore</span>
            <input
              type="file"
              accept=".json,.csv,application/json,text/csv"
              disabled={busy !== null}
              ref={restoreRef}
              style={{ flex: 1 }}
              onChange={(e) => void restore(e.target.files?.[0])}
            />
          </label>
        </div>
        <p className="hint">
          A restore only fills in games you already have, so sync first if you're starting from an
          empty library. Anything the file doesn't have a value for is left alone.
        </p>
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
              , enter it under API keys above) — ratings will be skipped and games stay unenriched
              so they can be completed once you add a key.
            </span>
          )}
        </p>
        <div className="row">
          <button
            className="btn"
            disabled={busy !== null || enrich?.running}
            onClick={() => {
              void run("enrich", api.startEnrich, () => "Enrichment started.");
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
              }}
            >
              Retry {lib.enrich_failed} failed
            </button>
          )}
          {lib && lib.enriched > 0 && (
            <button
              className="btn secondary"
              title="Re-fetch ratings, lengths and review scores for every game"
              disabled={busy !== null || enrich?.running}
              onClick={() => {
                void run(
                  "refresh",
                  api.refreshEnrich,
                  (r: { requeued: number }) => `Refreshing data for ${r.requeued} games.`,
                );
              }}
            >
              Refresh game data
            </button>
          )}
        </div>
        {status?.interrupted && !enrich?.running && (
          <p className="hint status-warn">
            An enrichment run was interrupted — the server restarted while it was working. Nothing
            was lost: {pending} game{pending === 1 ? "" : "s"} still pending, and starting again
            picks up where it stopped.
          </p>
        )}
        {!enrich?.running && status?.lastRun && (
          <p className="hint">
            {/* "processed", not "enriched": a game with no RAWG key available is
                worked through successfully but deliberately stays pending. */}
            Last run: {status.lastRun.done} game{status.lastRun.done === 1 ? "" : "s"} processed
            {status.lastRun.failed > 0 && `, ${status.lastRun.failed} failed`}, finished{" "}
            {formatWhen(status.lastRun.finishedAt)}.
          </p>
        )}
        {enrich?.running && (
          <>
            <p className="hint">
              {enrich.done + enrich.failed} / {enrich.total}
              {enrich.current && <> — currently: {enrich.current}</>}
              {enrich.etaSeconds != null && <> — about {formatEta(enrich.etaSeconds)} left</>}
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
        {enrich?.rawgUnavailable && (
          <p className="hint status-warn">
            RAWG keeps returning errors — check that your API key is still valid and that you
            haven't hit its daily quota. Ratings are being skipped, and the games are left pending
            so a later run picks them up.
          </p>
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
