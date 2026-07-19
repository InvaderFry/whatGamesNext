import { useCallback, useEffect, useState } from "react";
import { api, type Facets, type Game } from "../api";
import GameCard from "../components/GameCard";

const SORTS: [string, string][] = [
  ["rating", "Best rated"],
  ["metacritic", "Metacritic"],
  ["steam_reviews", "Steam review %"],
  ["length", "Shortest first"],
  ["difficulty", "Difficulty"],
  ["playtime", "Most played"],
  ["release", "Newest"],
  ["title", "Title A–Z"],
];

const LENGTH_BUCKETS: [string, string, number | undefined, number | undefined][] = [
  ["any", "Any length", undefined, undefined],
  ["short", "Under 10h", undefined, 10],
  ["mid", "10–30h", 10, 30],
  ["long", "30h+", 30, undefined],
];

export default function Library() {
  const [games, setGames] = useState<Game[] | null>(null);
  const [facets, setFacets] = useState<Facets>({ genres: [], tags: [] });
  const [error, setError] = useState<string | null>(null);

  const [sort, setSort] = useState("rating");
  const [dir, setDir] = useState<"asc" | "desc" | "">("");
  const [store, setStore] = useState("");
  const [status, setStatus] = useState("");
  const [genre, setGenre] = useState("");
  const [tag, setTag] = useState("");
  const [lengthBucket, setLengthBucket] = useState("any");
  const [search, setSearch] = useState("");
  const [includeHidden, setIncludeHidden] = useState(false);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    params.set("sort", sort);
    if (dir) params.set("dir", dir);
    else params.set("dir", sort === "title" ? "asc" : sort === "length" ? "asc" : "desc");
    if (store) params.set("store", store);
    if (status) params.set("status", status);
    if (genre) params.set("genre", genre);
    if (tag) params.set("tag", tag);
    if (search) params.set("search", search);
    if (includeHidden) params.set("includeHidden", "1");
    const bucket = LENGTH_BUCKETS.find(([k]) => k === lengthBucket);
    if (bucket?.[2] != null) params.set("minLength", String(bucket[2]));
    if (bucket?.[3] != null) params.set("maxLength", String(bucket[3]));
    try {
      const res = await api.games(params);
      setGames(res.games);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [sort, dir, store, status, genre, tag, search, includeHidden, lengthBucket]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    api
      .facets()
      .then(setFacets)
      .catch(() => {});
  }, []);

  return (
    <>
      <div className="toolbar">
        <input
          type="text"
          placeholder="Search titles…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          value={sort}
          onChange={(e) => {
            setSort(e.target.value);
            setDir("");
          }}
        >
          {SORTS.map(([k, label]) => (
            <option key={k} value={k}>
              Sort: {label}
            </option>
          ))}
        </select>
        <button
          className="btn secondary"
          title="Flip sort direction"
          onClick={() => setDir(dir === "asc" ? "desc" : "asc")}
        >
          {(dir || (sort === "title" || sort === "length" ? "asc" : "desc")) === "asc" ? "↑" : "↓"}
        </button>
        <select value={store} onChange={(e) => setStore(e.target.value)}>
          <option value="">All stores</option>
          <option value="steam">Steam</option>
          <option value="epic">Epic</option>
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Any status</option>
          <option value="unplayed">Unplayed</option>
          <option value="playing">Playing</option>
          <option value="finished">Finished</option>
          <option value="abandoned">Abandoned</option>
        </select>
        <select value={lengthBucket} onChange={(e) => setLengthBucket(e.target.value)}>
          {LENGTH_BUCKETS.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
        <select value={genre} onChange={(e) => setGenre(e.target.value)}>
          <option value="">All genres</option>
          {facets.genres.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
        <select value={tag} onChange={(e) => setTag(e.target.value)}>
          <option value="">All tags</option>
          {facets.tags.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <label style={{ fontSize: 13, color: "var(--text-dim)" }}>
          <input
            type="checkbox"
            checked={includeHidden}
            onChange={(e) => setIncludeHidden(e.target.checked)}
          />{" "}
          show hidden
        </label>
      </div>

      {error && <div className="notice error">{error}</div>}
      {games && games.length === 0 && (
        <div className="empty">
          No games found.
          <br />
          Head to <b>Settings</b> to sync your Steam and Epic libraries.
        </div>
      )}
      <div className="grid">
        {(games ?? []).map((g) => (
          <GameCard key={g.id} game={g} />
        ))}
      </div>
    </>
  );
}
