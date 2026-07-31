import { useEffect, useState } from "react";
import { api, type Stats as StatsData } from "../api";
import SkeletonGrid from "../components/SkeletonGrid";

const STATUS_LABELS: [keyof StatsData["statusCounts"], string][] = [
  ["unplayed", "Unplayed"],
  ["playing", "Playing"],
  ["finished", "Finished"],
  ["abandoned", "Abandoned"],
];

function BarList({ rows }: { rows: { label: string; value: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="bar-list">
      {rows.map((r) => (
        <div className="bar-row" key={r.label} title={`${r.label}: ${r.value}`}>
          <span className="bar-label">{r.label}</span>
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${(r.value / max) * 100}%` }} />
          </div>
          <span className="bar-value">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

export default function Stats() {
  const [stats, setStats] = useState<StatsData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .stats()
      .then(setStats)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  if (error) return <div className="notice error">{error}</div>;
  if (!stats) return <SkeletonGrid count={4} />;

  const total = Object.values(stats.statusCounts).reduce((a, b) => a + b, 0);
  const { backlog } = stats;
  const yearDelta = stats.finishedThisYear - stats.finishedLastYear;

  return (
    <>
      <div className="stat-tiles">
        <div className="stat-tile">
          <div className="stat-value">{backlog.games}</div>
          <div className="stat-label">games in backlog</div>
        </div>
        <div className="stat-tile">
          <div className="stat-value">
            {/* A tilde reads as "about"; an asterisk promises a footnote. */}
            {backlog.estimatedHours != null && backlog.unknownLength > 0 ? "~" : ""}
            {backlog.estimatedHours ?? backlog.knownHours}h
          </div>
          <div className="stat-label">
            {backlog.estimatedHours != null && backlog.unknownLength > 0
              ? `to clear it — ${backlog.knownHours}h known, ${backlog.unknownLength} unsized costed at the ${backlog.medianLength}h median`
              : "of backlog ahead of you"}
          </div>
        </div>
        <div className="stat-tile">
          <div className="stat-value">{stats.finishedThisYear}</div>
          <div className="stat-label">
            finished this year
            {stats.finishedLastYear > 0 &&
              ` — ${yearDelta === 0 ? "same as" : `${Math.abs(yearDelta)} ${yearDelta > 0 ? "more" : "fewer"} than`} last year`}
          </div>
        </div>
        <div className="stat-tile">
          <div className="stat-value">{stats.statusCounts.finished}</div>
          <div className="stat-label">finished all-time</div>
        </div>
        <div className="stat-tile">
          <div className="stat-value">{stats.totalPlaytimeHours}h</div>
          <div className="stat-label">total playtime on record</div>
        </div>
        {stats.abandonmentRate != null && (
          <div className="stat-tile">
            <div className="stat-value">{stats.abandonmentRate}%</div>
            <div className="stat-label">of decided games abandoned</div>
          </div>
        )}
      </div>

      <div className="settings-card">
        <h3>Library by status</h3>
        {total === 0 ? (
          <p className="hint">No games yet — sync your library in Settings.</p>
        ) : (
          <BarList
            rows={STATUS_LABELS.map(([key, label]) => ({
              label,
              value: stats.statusCounts[key],
            }))}
          />
        )}
      </div>

      <div className="settings-card">
        <h3>Games finished per year</h3>
        {stats.finishedByYear.length === 0 ? (
          <p className="hint">
            Nothing tracked yet — finish dates are recorded when you mark a game finished.
            {stats.untrackedFinishes > 0 &&
              ` ${stats.untrackedFinishes} games were finished before tracking existed.`}
          </p>
        ) : (
          <>
            <BarList rows={stats.finishedByYear.map((r) => ({ label: r.year, value: r.n }))} />
            {stats.untrackedFinishes > 0 && (
              <p className="hint">
                +{stats.untrackedFinishes} finished before date tracking existed.
              </p>
            )}
          </>
        )}
      </div>

      {stats.genres.length > 0 && (
        <div className="settings-card">
          <h3>Where your time goes</h3>
          <p className="hint">
            Hours played by genre. A game with several genres counts under each, so these overlap
            rather than adding up to your total.
          </p>
          <BarList rows={stats.genres.map((g) => ({ label: g.genre, value: g.hours }))} />
        </div>
      )}

      <div className="settings-card">
        <h3>Your ratings</h3>
        {stats.personal.rated === 0 ? (
          <p className="hint">
            You haven&rsquo;t rated anything yet. Use <b>Rate</b> on a game card to score it out of
            10 — your score replaces the critic rating when ranking that game.
          </p>
        ) : (
          <>
            <p className="hint">
              {stats.personal.rated} game{stats.personal.rated === 1 ? "" : "s"} rated, averaging{" "}
              <b>{stats.personal.average}/10</b>.
            </p>
            <BarList
              rows={stats.personal.top.map((g) => ({ label: g.title, value: g.personal_rating }))}
            />
          </>
        )}
      </div>

      {stats.recentFinishes.length > 0 && (
        <div className="settings-card">
          <h3>Recently finished</h3>
          {stats.recentFinishes.map((g) => (
            <p className="hint" key={g.id}>
              {g.title} — {new Date(g.finished_at).toLocaleDateString()}
            </p>
          ))}
        </div>
      )}
    </>
  );
}
