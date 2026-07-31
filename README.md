# whatGamesNext

Decide what game to play next from your **Steam** and **Epic** libraries — plus anything you paste
in from GOG, itch.io, or elsewhere.

A local, cross-platform web app (Windows / macOS / Linux — anywhere Node runs). It imports your
libraries, enriches every game with ratings, completion times, and an estimated difficulty, then
ranks your backlog in several ways:

| Mode                    | What it does                                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Play next**           | Weighted blend of rating, how untouched the game is, fit with your time budget, and recency — with a time-budget slider |
| **Tonight**             | Games you're already partway through, ranked by how much is _left_ rather than how good they are                        |
| **Quick wins**          | Short, highly rated games you haven't started                                                                           |
| **Backlog shame**       | Acclaimed games (80+) you've barely played                                                                              |
| **Hidden gems**         | ≥90% positive on Steam but with few reviews                                                                             |
| **Classics you missed** | 8+ year old greats still unplayed                                                                                       |
| **Surprise me**         | One weighted-random pick, with a reroll button                                                                          |

The **Library** page lets you sort by rating / Metacritic / Steam review % / length / difficulty /
playtime / release date, and filter by store, status, length bucket, genre, and tag. Each game can
be marked playing / finished / abandoned, hidden, or given a manual difficulty override. Filters,
sort and page are kept in the URL, so a view can be bookmarked or shared. Games synced from Steam
also get **Play** and **Store** links straight from the card.

A game with at least two hours on the clock is marked **playing** automatically on sync — stores
report playtime but never whether you consider a game started, so without this a game with 200
hours would sit at "unplayed" forever. Two hours is Steam's own refund window, and a fair line
between trying something and actually playing it. This only ever applies to games whose status you
haven't set yourself: once you change a status by hand, that game is yours and sync leaves it alone.

The **Shortlist** page is an ordered "next up" queue. Star a game from anywhere to add it, then
reorder with the ↑/↓ buttons — so a pick you liked survives a refresh instead of being re-rolled
away.

The **Stats** page tracks your play history: backlog size and hours, games finished per year
(finish dates are recorded when you mark a game finished), total playtime, and abandonment rate.

The UI follows your system light/dark preference, the recommendation modes are a keyboard-navigable
tab list (arrow keys, Home/End), and `prefers-reduced-motion` is respected.

## Data sources

- **Steam**: official Web API (owned games + playtime) and the public review-summary endpoint.
- **Epic**: the community [legendary](https://github.com/derrod/legendary) CLI, or manual paste
  (Epic has no official library API).
- **Other stores** (GOG, itch.io, Humble, physical…): paste titles in Settings → Other stores —
  one per line, or CSV with `title` and optional `playtime_hours` columns.
- **Ratings**: [RAWG](https://rawg.io/apidocs) — includes Metacritic scores, user ratings, genres, tags.
- **Length**: [HowLongToBeat](https://howlongtobeat.com) (unofficial — fails soft if it changes).
- **Difficulty**: no public source exists, so it's estimated from genres/tags (souls-like, casual,
  roguelike, …) on a 1–5 scale, and you can override it per game. Tags nudge a genre baseline
  rather than replacing it — they're capped, so a game carrying four "hard" tags can't be pinned at
  5 regardless of what it actually is. Only tags that speak to _challenge_ count: "story rich" and
  "atmospheric" describe a game without saying whether it's hard. A game with nothing to go on shows
  **?** rather than a made-up "Moderate", so an un-enriched library doesn't look like it's been
  assessed when it hasn't. Treat the score as a rough sort key, not a verdict.

## Setup

Requires Node 20+.

```bash
npm install
npm run dev            # server on :3001, UI on http://localhost:5173
```

### Keys (all free)

Enter these in the app under **Settings → API keys** (stored in the local database), or put them in
a `.env` file (`cp .env.example .env`) — the Settings values win when both are set.

1. **Steam**: get an API key at [steamcommunity.com/dev/apikey](https://steamcommunity.com/dev/apikey)
   → `STEAM_API_KEY`. Find your SteamID64 (17-digit number) at [steamid.io](https://steamid.io)
   → `STEAM_ID`. Your profile's _game details_ must be public for the API to list your games.
2. **RAWG**: get a key at [rawg.io/apidocs](https://rawg.io/apidocs) → `RAWG_API_KEY`.
3. **Epic (optional)**: `pip install legendary-gl`, then `legendary auth` once. Or skip it and paste
   your titles in Settings → Epic.

### First run

1. Open **Settings**, click **Sync Steam library** (and Epic). It'll offer to enrich whatever it
   brought in.
2. Enrichment fetches ratings, lengths and review scores for every game. Each source is held to
   about one request a second, but three games are worked at once so the sources are waited on in
   parallel — roughly a game a second overall, or ~25 minutes for 1,500 games. A progress bar and
   time estimate show while it runs.
   It's resumable: results are saved per game, so an interrupted run picks up where it stopped and
   already-enriched games are skipped.
3. Go to **What next?** and pick a mode.

### Demo mode

Want to poke at the UI without any keys? Set `DEMO=1` in `.env` and start the app — the library is
seeded with ~20 sample games.

## Development

```bash
npm test           # server unit/API tests + web component tests (Vitest)
npm run typecheck  # server + web
npm run lint       # ESLint
npm run format     # Prettier
npm run build      # production build; then `npm start` serves UI + API on :3001
```

CI (GitHub Actions) runs typecheck, lint, format check, and tests on every push and PR.

Data lives in `data/games.db` (SQLite). Delete it to start over.

## A note on access

The server binds to `127.0.0.1` — it's reachable only from your own machine. There is no
authentication, and the API can both read and write your stored API keys, so only set
`HOST=0.0.0.0` (to reach the app from a phone or another PC) on a network you trust.
