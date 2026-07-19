# whatGamesNext

Decide what game to play next from your **Steam** and **Epic** libraries.

A local, cross-platform web app (Windows / macOS / Linux — anywhere Node runs). It imports your
libraries, enriches every game with ratings, completion times, and an estimated difficulty, then
ranks your backlog in several ways:

| Mode                    | What it does                                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Play next**           | Weighted blend of rating, how untouched the game is, fit with your time budget, and recency — with a time-budget slider |
| **Quick wins**          | Short, highly rated games you haven't started                                                                           |
| **Backlog shame**       | Acclaimed games (80+) you've barely played                                                                              |
| **Hidden gems**         | ≥90% positive on Steam but with few reviews                                                                             |
| **Classics you missed** | 8+ year old greats still unplayed                                                                                       |
| **Surprise me**         | One weighted-random pick, with a reroll button                                                                          |

The **Library** page lets you sort by rating / Metacritic / Steam review % / length / difficulty /
playtime / release date, and filter by store, status, length bucket, genre, and tag. Each game can
be marked playing / finished / abandoned, hidden, or given a manual difficulty override.

## Data sources

- **Steam**: official Web API (owned games + playtime) and the public review-summary endpoint.
- **Epic**: the community [legendary](https://github.com/derrod/legendary) CLI, or manual paste
  (Epic has no official library API).
- **Ratings**: [RAWG](https://rawg.io/apidocs) — includes Metacritic scores, user ratings, genres, tags.
- **Length**: [HowLongToBeat](https://howlongtobeat.com) (unofficial — fails soft if it changes).
- **Difficulty**: no public source exists, so it's estimated from genres/tags (souls-like, casual,
  roguelike, …) on a 1–5 scale, and you can override it per game.

## Setup

Requires Node 20+.

```bash
npm install
cp .env.example .env   # then fill in the keys below
npm run dev            # server on :3001, UI on http://localhost:5173
```

### Keys (all free)

1. **Steam**: get an API key at [steamcommunity.com/dev/apikey](https://steamcommunity.com/dev/apikey)
   → `STEAM_API_KEY`. Find your SteamID64 (17-digit number) at [steamid.io](https://steamid.io)
   → `STEAM_ID`. Your profile's _game details_ must be public for the API to list your games.
2. **RAWG**: get a key at [rawg.io/apidocs](https://rawg.io/apidocs) → `RAWG_API_KEY`.
3. **Epic (optional)**: `pip install legendary-gl`, then `legendary auth` once. Or skip it and paste
   your titles in Settings → Epic.

### First run

1. Open **Settings**, click **Sync Steam library** (and Epic).
2. Click **Start enrichment** — this fetches ratings/lengths for every game at ~1 request/sec, so a
   big library takes a while. It's resumable; already-enriched games are skipped on later runs.
3. Go to **What next?** and pick a mode.

### Demo mode

Want to poke at the UI without any keys? Set `DEMO=1` in `.env` and start the app — the library is
seeded with ~20 sample games.

## Development

```bash
npm test           # unit tests (title matching, difficulty heuristic, ranking modes)
npm run typecheck  # server + web
npm run build      # production build; then `npm start` serves UI + API on :3001
```

Data lives in `data/games.db` (SQLite). Delete it to start over.
