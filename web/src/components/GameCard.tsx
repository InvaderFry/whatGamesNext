import { useState } from "react";
import { api, difficultyLabel, formatPlaytime, type Game } from "../api";

function ratingClass(r: number | null): string {
  if (r == null) return "";
  if (r >= 80) return "rating-good";
  if (r >= 60) return "rating-mid";
  return "rating-bad";
}

const STORE_LABEL = { steam: "Steam", epic: "Epic", both: "Steam + Epic" } as const;

export default function GameCard({
  game: initial,
  reason,
  onChanged,
}: {
  game: Game;
  reason?: string;
  onChanged?: () => void;
}) {
  const [game, setGame] = useState(initial);
  const [busy, setBusy] = useState(false);

  async function patch(p: Parameters<typeof api.patchGame>[1]) {
    setBusy(true);
    try {
      const updated = await api.patchGame(game.id, p);
      setGame(updated);
      onChanged?.();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      {game.cover_url ? (
        <img className="cover" src={game.cover_url} alt="" loading="lazy" />
      ) : (
        <div className="cover-placeholder">{game.title}</div>
      )}
      <div className="body">
        <div className="title">{game.title}</div>
        {reason && <div className="reason">{reason}</div>}
        <div className="badges">
          <span className="badge store">{STORE_LABEL[game.store]}</span>
          {game.effective_rating != null && (
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
        <div className="controls">
          <select
            value={game.status}
            disabled={busy}
            onChange={(e) => void patch({ status: e.target.value })}
            title="Play status"
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
              void patch({ difficulty_override: e.target.value === "" ? null : Number(e.target.value) })
            }
            title="Difficulty override"
          >
            <option value="">Auto diff.</option>
            {[1, 2, 3, 4, 5].map((d) => (
              <option key={d} value={d}>
                {difficultyLabel(d)}
              </option>
            ))}
          </select>
          <button disabled={busy} onClick={() => void patch({ hidden: !game.hidden })}>
            {game.hidden ? "Unhide" : "Hide"}
          </button>
        </div>
      </div>
    </div>
  );
}
