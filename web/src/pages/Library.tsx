import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Facets, type Game } from "../api";
import GameCard from "../components/GameCard";
import SkeletonGrid from "../components/SkeletonGrid";
import { toast } from "../components/Toasts";
import { readUrl, writeUrl } from "../urlState";

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

const PAGE_SIZE = 60;
const SEARCH_DEBOUNCE_MS = 300;

const DEFAULT_SORT = "rating";
const DEFAULT_LENGTH = "any";

function readInitialFilters() {
  const url = readUrl();
  const dir = url.get("dir");
  return {
    sort: url.get("sort") ?? DEFAULT_SORT,
    dir: (dir === "asc" || dir === "desc" ? dir : "") as "asc" | "desc" | "",
    store: url.get("store") ?? "",
    status: url.get("status") ?? "",
    genre: url.get("genre") ?? "",
    tag: url.get("tag") ?? "",
    length: url.get("length") ?? DEFAULT_LENGTH,
    search: url.get("search") ?? "",
    hidden: url.get("hidden") === "1",
    // 1-based in the URL, 0-based internally.
    page: Math.max(0, (Number(url.get("page")) || 1) - 1),
  };
}

export default function Library() {
  // Read once on mount. The URL is written back below, never watched.
  const [initial] = useState(readInitialFilters);

  const [games, setGames] = useState<Game[] | null>(null);
  const [facets, setFacets] = useState<Facets>({ genres: [], tags: [] });
  const [error, setError] = useState<string | null>(null);

  const [sort, setSort] = useState(initial.sort);
  const [dir, setDir] = useState<"asc" | "desc" | "">(initial.dir);
  const [store, setStore] = useState(initial.store);
  const [status, setStatus] = useState(initial.status);
  const [genre, setGenre] = useState(initial.genre);
  const [tag, setTag] = useState(initial.tag);
  const [lengthBucket, setLengthBucket] = useState(initial.length);
  const [search, setSearch] = useState(initial.search);
  const [debouncedSearch, setDebouncedSearch] = useState(initial.search);
  const [includeHidden, setIncludeHidden] = useState(initial.hidden);
  const [page, setPage] = useState(initial.page);
  const [total, setTotal] = useState(0);

  // Only the debounced value drives the query, so typing stays instant while a
  // large library isn't refetched on every keystroke. The page is reset by the
  // input's onChange rather than here — resetting on the timer would also undo
  // a page change the user made while a debounce was still pending.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  // Two guards for one bug, because they catch different halves of it.
  //
  // Nothing made the responses arrive in the order they were asked for, so a
  // slow answer for an old filter could land after a fast answer for the new one
  // and leave the grid showing games the controls no longer describe. The 300ms
  // search debounce hid most of it, and over loopback the window is tiny — but
  // switching store and status quickly is enough.
  //
  // Aborting is the better half: it stops the server work and the stale parse.
  // What it can't do is unwind a response that already resolved before the abort
  // landed — that microtask is queued and will run. So each call also takes a
  // sequence number and re-checks it after the await before touching state.
  //
  // Both live in refs rather than the load effect's cleanup because `load` is
  // called from two places: the effect below and a card reporting an edit.
  const inFlight = useRef<AbortController | null>(null);
  const latestLoad = useRef(0);

  const load = useCallback(async () => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    const seq = ++latestLoad.current;

    const params = new URLSearchParams();
    params.set("sort", sort);
    if (dir) params.set("dir", dir);
    else params.set("dir", sort === "title" ? "asc" : sort === "length" ? "asc" : "desc");
    if (store) params.set("store", store);
    if (status) params.set("status", status);
    if (genre) params.set("genre", genre);
    if (tag) params.set("tag", tag);
    if (debouncedSearch) params.set("search", debouncedSearch);
    if (includeHidden) params.set("includeHidden", "1");
    const bucket = LENGTH_BUCKETS.find(([k]) => k === lengthBucket);
    if (bucket?.[2] != null) params.set("minLength", String(bucket[2]));
    if (bucket?.[3] != null) params.set("maxLength", String(bucket[3]));
    params.set("limit", String(PAGE_SIZE));
    params.set("offset", String(page * PAGE_SIZE));
    try {
      const res = await api.games(params, controller.signal);
      if (seq !== latestLoad.current) return;
      setGames(res.games);
      setTotal(res.count);
      setError(null);
      // Hiding or restatusing a card can shrink the result set out from under
      // us and strand the user past the last page.
      if (res.games.length === 0 && page > 0) setPage(0);
    } catch (err) {
      // A request we cancelled ourselves isn't a failure worth a red banner —
      // untreated, every filter change would flash one.
      if (controller.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) {
        return;
      }
      if (seq !== latestLoad.current) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [sort, dir, store, status, genre, tag, debouncedSearch, includeHidden, lengthBucket, page]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    api
      .facets()
      .then(setFacets)
      .catch(() => toast("Couldn't load genre/tag filters — is the server running?"));
  }, []);

  // Defaults are written as null so an untouched view leaves a clean URL. The
  // applied search is used rather than the raw input, so the URL tracks what
  // was actually queried.
  useEffect(() => {
    writeUrl({
      sort: sort === DEFAULT_SORT ? null : sort,
      dir,
      store,
      status,
      genre,
      tag,
      length: lengthBucket === DEFAULT_LENGTH ? null : lengthBucket,
      search: debouncedSearch,
      hidden: includeHidden ? "1" : null,
      page: page > 0 ? String(page + 1) : null,
    });
  }, [sort, dir, store, status, genre, tag, lengthBucket, debouncedSearch, includeHidden, page]);

  const pageCount = Math.ceil(total / PAGE_SIZE);

  return (
    <>
      <div className="toolbar">
        <input
          type="text"
          placeholder="Search titles…"
          aria-label="Search titles"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(0);
          }}
        />
        <select
          aria-label="Sort by"
          value={sort}
          onChange={(e) => {
            setSort(e.target.value);
            setDir("");
            setPage(0);
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
          aria-label="Flip sort direction"
          onClick={() => {
            setDir(dir === "asc" ? "desc" : "asc");
            setPage(0);
          }}
        >
          {(dir || (sort === "title" || sort === "length" ? "asc" : "desc")) === "asc" ? "↑" : "↓"}
        </button>
        <select
          aria-label="Filter by store"
          value={store}
          onChange={(e) => {
            setStore(e.target.value);
            setPage(0);
          }}
        >
          <option value="">All stores</option>
          <option value="steam">Steam</option>
          <option value="epic">Epic</option>
          <option value="gog">GOG</option>
          <option value="itch">itch.io</option>
          <option value="other">Other</option>
        </select>
        <select
          aria-label="Filter by status"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(0);
          }}
        >
          <option value="">Any status</option>
          <option value="unplayed">Unplayed</option>
          <option value="playing">Playing</option>
          <option value="finished">Finished</option>
          <option value="abandoned">Abandoned</option>
        </select>
        <select
          aria-label="Filter by length"
          value={lengthBucket}
          onChange={(e) => {
            setLengthBucket(e.target.value);
            setPage(0);
          }}
        >
          {LENGTH_BUCKETS.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by genre"
          value={genre}
          onChange={(e) => {
            setGenre(e.target.value);
            setPage(0);
          }}
        >
          <option value="">All genres</option>
          {facets.genres.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by tag"
          value={tag}
          onChange={(e) => {
            setTag(e.target.value);
            setPage(0);
          }}
        >
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
            onChange={(e) => {
              setIncludeHidden(e.target.checked);
              setPage(0);
            }}
          />{" "}
          show hidden
        </label>
      </div>

      {error && <div className="notice error">{error}</div>}
      {games && games.length === 0 && total === 0 && (
        <div className="empty">
          No games found.
          <br />
          Head to <b>Settings</b> to sync your Steam and Epic libraries.
        </div>
      )}
      {games === null && !error ? (
        <SkeletonGrid />
      ) : (
        <div className="grid">
          {(games ?? []).map((g) => (
            <GameCard key={g.id} game={g} onChanged={() => void load()} />
          ))}
        </div>
      )}

      {games && total > 0 && (
        <div className="pager">
          {pageCount > 1 && (
            <button
              className="btn secondary"
              aria-label="Previous page"
              disabled={page === 0}
              onClick={() => setPage(page - 1)}
            >
              ← Prev
            </button>
          )}
          <span>
            {pageCount > 1
              ? `Showing ${(page * PAGE_SIZE + 1).toLocaleString()}–${(page * PAGE_SIZE + games.length).toLocaleString()} of ${total.toLocaleString()}`
              : `${total.toLocaleString()} game${total === 1 ? "" : "s"}`}
          </span>
          {pageCount > 1 && (
            <button
              className="btn secondary"
              aria-label="Next page"
              disabled={page >= pageCount - 1}
              onClick={() => setPage(page + 1)}
            >
              Next →
            </button>
          )}
        </div>
      )}
    </>
  );
}
