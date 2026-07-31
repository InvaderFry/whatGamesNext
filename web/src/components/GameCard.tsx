import { useState } from "react";
import { api, difficultyLabel, formatPlaytime, type Game, type ScoreBreakdown } from "../api";

const BREAKDOWN_LABELS: [keyof ScoreBreakdown, string][] = [
  ["rating", "rating"],
  ["unplayed", "untouched"],
  ["lengthFit", "length fit"],
  ["recency", "recency"],
];

function describeBreakdown(b: ScoreBreakdown): string {
  return BREAKDOWN_LABELS.filter(([k]) => b[k] >= 0.005)
    .sort((x, y) => b[y[0]] - b[x[0]])
    .map(([k, label]) => `${label} ${Math.round(b[k] * 100)}%`)
    .join(" · ");
}

function ratingClass(r: number | null): string {
  if (r == null) return "";
  if (r >= 80) return "rating-good";
  if (r >= 60) return "rating-mid";
  return "rating-bad";
}

const STORE_LABEL = {
  steam: "Steam",
  epic: "Epic",
  both: "Steam + Epic",
  gog: "GOG",
  itch: "itch.io",
  other: "Other",
} as const;

export default function GameCard({
  game: initial,
  reason,
  breakdown,
  onChanged,
  showShortlistToggle = true,
}: {
  game: Game;
  reason?: string;
  breakdown?: ScoreBreakdown | null;
  onChanged?: () => void;
  /** Off on the Shortlist page, where each row already has a remove button —
   *  two controls doing the same job would carry the same label. */
  showShortlistToggle?: boolean;
}) {
  const [game, setGame] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [coverFailed, setCoverFailed] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState(initial.notes ?? "");

  async function toggleShortlist() {
    const listed = game.queue_position != null;
    setBusy(true);
    try {
      await (listed ? api.removeFromQueue(game.id) : api.addToQueue(game.id));
      // The card owns its copy of the game, so reflect the change locally
      // rather than making the whole page reload for one toggle.
      setGame((g) => ({ ...g, queue_position: listed ? null : Number.MAX_SAFE_INTEGER }));
      setError(null);
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    } finally {
      setBusy(false);
    }
  }

  async function patch(p: Parameters<typeof api.patchGame>[1]) {
    setBusy(true);
    try {
      const updated = await api.patchGame(game.id, p);
      setGame(updated);
      setError(null);
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      {game.cover_url && !coverFailed ? (
        <img
          className="cover"
          src={game.cover_url}
          alt={`${game.title} cover art`}
          loading="lazy"
          onError={() => setCoverFailed(true)}
        />
      ) : (
        <div className="cover-placeholder">{game.title}</div>
      )}
      <div className="body">
        <div className="title">{game.title}</div>
        {reason && <div className="reason">{reason}</div>}
        {breakdown && <div className="breakdown">why: {describeBreakdown(breakdown)}</div>}
        {error && <div className="card-error">{error}</div>}
        <div className="badges">
          <span className="badge store">{STORE_LABEL[game.store]}</span>
          {/* Your own score is shown as itself rather than folded into the
              critic badge, even though it's what the ranking now uses. */}
          {game.personal_rating != null && (
            <span className={`badge ${ratingClass(game.personal_rating * 10)}`} title="Your rating">
              ♥ {game.personal_rating}/10
            </span>
          )}
          {game.effective_rating != null && game.personal_rating == null && (
            <span className={`badge ${ratingClass(game.effective_rating)}`}>
              ★ {Math.round(game.effective_rating)}
            </span>
          )}
          {game.hltb_main != null && <span className="badge">⏱ {game.hltb_main}h main</span>}
          {game.effective_difficulty != null && (
            <span className="badge">⚔ {difficultyLabel(game.effective_difficulty)}</span>
          )}
          <span className="badge">{formatPlaytime(game.playtime_minutes)}</span>
          {game.steam_review_pct != null && (
            <span className="badge">{game.steam_review_pct}% on Steam</span>
          )}
        </div>
        {game.genres.length > 0 && (
          <div className="badges">
            {game.genres.slice(0, 4).map((g) => (
              <span key={g} className="badge">
                {g}
              </span>
            ))}
          </div>
        )}

        {game.notes && !noteOpen && <div className="card-note">{game.notes}</div>}
        {noteOpen && (
          <div className="take">
            <label>
              <span>Your rating</span>
              <select
                disabled={busy}
                aria-label={`Your rating for ${game.title}`}
                value={game.personal_rating ?? ""}
                onChange={(e) =>
                  void patch({
                    personal_rating: e.target.value === "" ? null : Number(e.target.value),
                  })
                }
              >
                <option value="">—</option>
                {[10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map((n) => (
                  <option key={n} value={n}>
                    {n}/10
                  </option>
                ))}
              </select>
            </label>
            <textarea
              rows={3}
              disabled={busy}
              aria-label={`Notes on ${game.title}`}
              placeholder="dropped at the swamp…"
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              // Saved on blur so a note isn't lost by clicking away, and so
              // every keystroke isn't a request.
              onBlur={() => {
                if (noteDraft.trim() !== (game.notes ?? "")) void patch({ notes: noteDraft });
              }}
            />
          </div>
        )}
        {/* Gated on the appid rather than the store: a "both" game is launchable,
            a manually-imported or GOG one has no id to launch with. */}
        {game.steam_appid != null && (
          <div className="actions">
            <a
              href={`steam://rungameid/${game.steam_appid}`}
              aria-label={`Launch ${game.title} in Steam`}
            >
              ▶ Play
            </a>
            <a
              href={`https://store.steampowered.com/app/${game.steam_appid}/`}
              target="_blank"
              rel="noreferrer noopener"
              aria-label={`Open ${game.title} on the Steam store`}
            >
              Store ↗
            </a>
          </div>
        )}
        <div className="controls">
          <select
            value={game.status}
            disabled={busy}
            onChange={(e) => void patch({ status: e.target.value })}
            title="Play status"
            aria-label={`Play status for ${game.title}`}
          >
            <option value="unplayed">Unplayed</option>
            <option value="playing">Playing</option>
            <option value="finished">Finished</option>
            <option value="abandoned">Abandoned</option>
          </select>
          <select
            value={game.difficulty_override ?? ""}
            disabled={busy}
            onChange={(e) =>
              void patch({
                difficulty_override: e.target.value === "" ? null : Number(e.target.value),
              })
            }
            title="Difficulty override"
            aria-label={`Difficulty override for ${game.title}`}
          >
            <option value="">Auto diff.</option>
            {[1, 2, 3, 4, 5].map((d) => (
              <option key={d} value={d}>
                {difficultyLabel(d)}
              </option>
            ))}
          </select>
          {showShortlistToggle && (
            <button
              disabled={busy}
              aria-pressed={game.queue_position != null}
              aria-label={`${game.queue_position != null ? "Remove" : "Add"} ${game.title} ${
                game.queue_position != null ? "from" : "to"
              } the shortlist`}
              onClick={() => void toggleShortlist()}
            >
              {game.queue_position != null ? "★ Listed" : "☆ Shortlist"}
            </button>
          )}
          <button
            disabled={busy}
            aria-expanded={noteOpen}
            aria-label={`Your rating and notes for ${game.title}`}
            onClick={() => setNoteOpen((o) => !o)}
          >
            {game.personal_rating != null || game.notes ? "✎ Edit take" : "✎ Rate"}
          </button>
          <button
            disabled={busy}
            aria-label={`${game.hidden ? "Unhide" : "Hide"} ${game.title}`}
            onClick={() => void patch({ hidden: !game.hidden })}
          >
            {game.hidden ? "Unhide" : "Hide"}
          </button>
        </div>
      </div>
    </div>
  );
}
