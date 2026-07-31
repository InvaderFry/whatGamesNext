import { useCallback, useEffect, useState } from "react";
import { api, type Game } from "../api";
import GameCard from "../components/GameCard";
import SkeletonGrid from "../components/SkeletonGrid";

/**
 * The ordered "next up" list. Reordering is buttons rather than drag-and-drop:
 * a list you can only reorder by dragging is unusable by keyboard, and this
 * needs about four entries of precision, not pixel accuracy.
 */
export default function Shortlist() {
  const [games, setGames] = useState<Game[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setGames((await api.queue()).games);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(fn: () => Promise<{ games: Game[] }>) {
    setBusy(true);
    try {
      setGames((await fn()).games);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (games === null && !error) return <SkeletonGrid count={4} />;

  return (
    <>
      {error && <div className="notice error">{error}</div>}

      {games && games.length === 0 ? (
        <div className="empty">
          Your shortlist is empty.
          <br />
          Star a game from <b>What next?</b> or <b>Library</b> to queue it up here.
        </div>
      ) : (
        <>
          <p className="hint" style={{ color: "var(--text-dim)", fontSize: 13 }}>
            {games?.length} game{games?.length === 1 ? "" : "s"} queued up, in the order you plan to
            play them.
          </p>
          <ol className="queue">
            {(games ?? []).map((g, i) => (
              <li key={g.id}>
                <div className="queue-controls">
                  <span className="queue-rank" aria-hidden="true">
                    {i + 1}
                  </span>
                  <button
                    className="btn secondary"
                    disabled={busy || i === 0}
                    aria-label={`Move ${g.title} up`}
                    onClick={() => void act(() => api.moveInQueue(g.id, "up"))}
                  >
                    ↑
                  </button>
                  <button
                    className="btn secondary"
                    disabled={busy || i === (games?.length ?? 0) - 1}
                    aria-label={`Move ${g.title} down`}
                    onClick={() => void act(() => api.moveInQueue(g.id, "down"))}
                  >
                    ↓
                  </button>
                  <button
                    className="btn secondary"
                    disabled={busy}
                    aria-label={`Remove ${g.title} from the shortlist`}
                    onClick={() => void act(() => api.removeFromQueue(g.id))}
                  >
                    ✕
                  </button>
                </div>
                <GameCard game={g} onChanged={() => void load()} showShortlistToggle={false} />
              </li>
            ))}
          </ol>
        </>
      )}
    </>
  );
}
