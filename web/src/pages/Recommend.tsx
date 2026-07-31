import { useEffect, useState } from "react";
import {
  api,
  difficultyLabel,
  DEFAULT_WEIGHTS,
  WEIGHT_LABELS,
  type Facets,
  type Recommendation,
  type Weights,
} from "../api";
import GameCard from "../components/GameCard";
import { toast } from "../components/Toasts";

const MODES: [string, string, string][] = [
  ["play-next", "Play next", "Weighted blend of rating, backlog status, length fit, and recency"],
  ["quick-wins", "Quick wins", "Short, highly rated games you haven't touched"],
  ["backlog-shame", "Backlog shame", "Acclaimed games (80+) you've barely played"],
  ["hidden-gems", "Hidden gems", "Loved on Steam but with few reviews"],
  ["classics-missed", "Classics you missed", "8+ year old greats still unplayed"],
  ["surprise", "Surprise me", "One weighted-random pick from your best candidates"],
];

// Only these two modes use the composite score. The rest have their own fixed
// ranking in server/src/lib/score.ts and ignore the weights, so showing sliders
// for them would imply control that doesn't exist.
const WEIGHTED_MODES = ["play-next", "surprise"];

export default function Recommend() {
  const [mode, setMode] = useState("play-next");
  const [budget, setBudget] = useState(20);
  const [useBudget, setUseBudget] = useState(true);
  const [results, setResults] = useState<Recommendation[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [roll, setRoll] = useState(0);

  const [showTuning, setShowTuning] = useState(false);
  const [weights, setWeights] = useState<Weights>(DEFAULT_WEIGHTS);
  const [genre, setGenre] = useState("");
  const [tag, setTag] = useState("");
  const [maxDifficulty, setMaxDifficulty] = useState("");
  const [facets, setFacets] = useState<Facets>({ genres: [], tags: [] });

  // Bumping `roll` forces a re-fetch (surprise rerolls, card edits).
  const reload = () => setRoll((r) => r + 1);

  useEffect(() => {
    api
      .facets()
      .then(setFacets)
      .catch(() => toast("Couldn't load genre/tag filters — is the server running?"));
  }, []);

  useEffect(() => {
    let stale = false;
    const params = new URLSearchParams({ mode });
    if (useBudget) params.set("budget", String(budget));
    if (genre) params.set("genre", genre);
    if (tag) params.set("tag", tag);
    if (maxDifficulty) params.set("maxDifficulty", maxDifficulty);
    for (const [key] of WEIGHT_LABELS) params.set(`w_${key}`, String(weights[key]));
    api
      .recommend(params)
      .then((res) => {
        if (stale) return;
        setResults(res.results);
        setTotal(res.total);
        setError(null);
      })
      .catch((err) => {
        if (!stale) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      stale = true;
    };
  }, [mode, budget, useBudget, roll, weights, genre, tag, maxDifficulty]);

  const modeInfo = MODES.find(([k]) => k === mode);
  const showWeights = WEIGHTED_MODES.includes(mode);
  const weightsChanged = WEIGHT_LABELS.some(([k]) => weights[k] !== DEFAULT_WEIGHTS[k]);
  const filtered = !!(genre || tag || maxDifficulty);

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
          aria-label="Time budget in hours"
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
        <button
          className="btn secondary"
          aria-expanded={showTuning}
          onClick={() => setShowTuning(!showTuning)}
        >
          {showTuning ? "Hide tuning" : "Tune"}
        </button>
      </div>

      {showTuning && (
        <div className="settings-card">
          <h3>Tune</h3>
          <p style={{ color: "var(--text-dim)", fontSize: 13, margin: 0 }}>
            {total.toLocaleString()} game{total === 1 ? " matches" : "s match"}{" "}
            {filtered ? "your filters" : "this mode"}.
          </p>

          <div className="row">
            <select
              aria-label="Filter by genre"
              value={genre}
              onChange={(e) => setGenre(e.target.value)}
            >
              <option value="">All genres</option>
              {facets.genres.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
            <select aria-label="Filter by tag" value={tag} onChange={(e) => setTag(e.target.value)}>
              <option value="">All tags</option>
              {facets.tags.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <select
              aria-label="Maximum difficulty"
              value={maxDifficulty}
              onChange={(e) => setMaxDifficulty(e.target.value)}
            >
              <option value="">Any difficulty</option>
              {[1, 2, 3, 4, 5].map((d) => (
                <option key={d} value={d}>
                  {difficultyLabel(d)} or easier
                </option>
              ))}
            </select>
          </div>

          {showWeights ? (
            <>
              <p style={{ color: "var(--text-dim)", fontSize: 13, margin: "14px 0 0" }}>
                What should count, and how much?
              </p>
              {WEIGHT_LABELS.map(([key, label]) => (
                <div className="slider-row" key={key} style={{ marginBottom: 8 }}>
                  <label style={{ width: 90 }} htmlFor={`w-${key}`}>
                    {label}
                  </label>
                  <input
                    id={`w-${key}`}
                    type="range"
                    min={0}
                    max={2}
                    step={0.1}
                    aria-label={`${label} weight`}
                    value={weights[key]}
                    onChange={(e) => setWeights({ ...weights, [key]: Number(e.target.value) })}
                  />
                  <b style={{ color: "var(--text)" }}>{weights[key].toFixed(1)}</b>
                </div>
              ))}
              <div className="row">
                <button
                  className="btn secondary"
                  disabled={!weightsChanged}
                  onClick={() => setWeights(DEFAULT_WEIGHTS)}
                >
                  Reset to defaults
                </button>
              </div>
            </>
          ) : (
            <p style={{ color: "var(--text-dim)", fontSize: 13, margin: "14px 0 0" }}>
              {modeInfo?.[1]} has its own fixed ranking, so the score weights don&rsquo;t apply.
              Switch to <b>Play next</b> or <b>Surprise me</b> to tune them.
            </p>
          )}
        </div>
      )}

      {error && <div className="notice error">{error}</div>}
      {results && results.length === 0 && (
        <div className="empty">
          {filtered ? (
            <>
              Nothing matched this mode with your current filters.
              <br />
              Try widening them in <b>Tune</b>.
            </>
          ) : (
            <>
              Nothing matched this mode.
              <br />
              Sync and enrich your library in <b>Settings</b>, or try another mode.
            </>
          )}
        </div>
      )}
      <div className="grid">
        {(results ?? []).map((r) => (
          <GameCard
            key={`${r.game.id}-${roll}`}
            game={r.game}
            reason={r.reason}
            breakdown={r.breakdown}
            onChanged={reload}
          />
        ))}
      </div>
    </>
  );
}
