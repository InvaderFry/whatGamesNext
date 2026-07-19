import { useEffect, useState } from "react";
import { api, type Recommendation } from "../api";
import GameCard from "../components/GameCard";

const MODES: [string, string, string][] = [
  ["play-next", "Play next", "Weighted blend of rating, backlog status, length fit, and recency"],
  ["quick-wins", "Quick wins", "Short, highly rated games you haven't touched"],
  ["backlog-shame", "Backlog shame", "Acclaimed games (80+) you've barely played"],
  ["hidden-gems", "Hidden gems", "Loved on Steam but with few reviews"],
  ["classics-missed", "Classics you missed", "8+ year old greats still unplayed"],
  ["surprise", "Surprise me", "One weighted-random pick from your best candidates"],
];

export default function Recommend() {
  const [mode, setMode] = useState("play-next");
  const [budget, setBudget] = useState(20);
  const [useBudget, setUseBudget] = useState(true);
  const [results, setResults] = useState<Recommendation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [roll, setRoll] = useState(0);

  // Bumping `roll` forces a re-fetch (surprise rerolls, card edits).
  const reload = () => setRoll((r) => r + 1);

  useEffect(() => {
    let stale = false;
    const params = new URLSearchParams({ mode });
    if (useBudget) params.set("budget", String(budget));
    api
      .recommend(params)
      .then((res) => {
        if (stale) return;
        setResults(res.results);
        setError(null);
      })
      .catch((err) => {
        if (!stale) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      stale = true;
    };
  }, [mode, budget, useBudget, roll]);

  const modeInfo = MODES.find(([k]) => k === mode);

  return (
    <>
      <div className="mode-chips">
        {MODES.map(([key, label]) => (
          <button key={key} className={mode === key ? "active" : ""} onClick={() => setMode(key)}>
            {label}
          </button>
        ))}
      </div>

      {modeInfo && (
        <p className="hint" style={{ color: "var(--text-dim)", fontSize: 13 }}>
          {modeInfo[2]}
        </p>
      )}

      <div className="slider-row">
        <label>
          <input
            type="checkbox"
            checked={useBudget}
            onChange={(e) => setUseBudget(e.target.checked)}
          />{" "}
          I have about
        </label>
        <input
          type="range"
          min={2}
          max={100}
          step={2}
          value={budget}
          disabled={!useBudget}
          onChange={(e) => setBudget(Number(e.target.value))}
        />
        <b style={{ color: "var(--text)" }}>{budget}h</b> to spend on my next game
        {mode === "surprise" && (
          <button className="btn" onClick={reload}>
            🎲 Reroll
          </button>
        )}
      </div>

      {error && <div className="notice error">{error}</div>}
      {results && results.length === 0 && (
        <div className="empty">
          Nothing matched this mode.
          <br />
          Sync and enrich your library in <b>Settings</b>, or try another mode.
        </div>
      )}
      <div className="grid">
        {(results ?? []).map((r) => (
          <GameCard
            key={`${r.game.id}-${roll}`}
            game={r.game}
            reason={r.reason}
            onChanged={reload}
          />
        ))}
      </div>
    </>
  );
}
