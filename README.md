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

Over time the app **learns what you actually stick with**. Every game you rate, finish or abandon is
evidence, and the genres and tags that stand out from your own average nudge the "Play next"
ranking — so if you finish RPGs and drop shooters, it stops suggesting shooters. Stats shows exactly
what it thinks it has learned, and the **Your taste** slider under Tune turns it down or off.

Two honest caveats. It only speaks up once there's enough history — before that it's inert and
changes nothing. And it is a feedback loop by construction: it will tend to surface more of what you
already play, which is the point but also worth knowing. The slider is there for when you want to be
surprised instead.

Every game takes **your own 1–10 score and a free-text note** ("dropped at the swamp"). Where you've
scored something, that score is what the recommendations rank it by — you've played it and a critic
hasn't played it for you.

The **Stats** page tracks your play history: backlog size and hours, games finished per year
(finish dates are recorded when you mark a game finished), this year against last, hours by genre,
your own ratings, total playtime, and abandonment rate. Backlog hours include games of unknown
length, costed at the median of the lengths that are known — so the figure isn't quietly understated
by whatever HowLongToBeat had no entry for.

The UI follows your system light/dark preference, the recommendation modes are a keyboard-navigable
tab list (arrow keys, Home/End), and `prefers-reduced-motion` is respected.

## Data sources

- **Steam**: official Web API (owned games + playtime), plus two public store endpoints — the review
  summary and the store page details (Metacritic score, genres, co-op/multiplayer) — which need no
  key.
- **Epic**: the community [legendary](https://github.com/derrod/legendary) CLI, or manual paste
  (Epic has no official library API).
- **Other stores** (GOG, itch.io, Humble, physical…): paste titles in Settings → Other stores —
  one per line, or CSV with `title` and optional `playtime_hours` columns.
- **Ratings, genres and tags**: [IGDB](https://www.igdb.com/api) (owned by Twitch; free for
  personal use) is the main source — critic and user ratings, genres, themes, keywords and game
  modes. It also knows each game's Steam id, which is how **Epic and pasted games get Steam's
  review % and Metacritic score too**, not just games synced from Steam. Steam games are matched to
  IGDB exactly by their Steam id; everything else is matched by title.
- **RAWG (optional backup)**: [RAWG](https://rawg.io/apidocs) was the original ratings source but
  is often down for days at a time, so it's now only asked when IGDB isn't set up, errors, or has
  no match for a game. It's likely to be removed in a future version — you don't need a key.
- **Which rating a game shows**: the first one it has, in this order — your own 1–10 score,
  Metacritic, Steam review %, IGDB's critic average, RAWG, then IGDB's user rating.
- **Length**: [HowLongToBeat](https://howlongtobeat.com) (unofficial — fails soft if it changes).
- **Difficulty**: no public source exists, so it's estimated from genres/tags (souls-like, casual,
  roguelike, …) on a 1–5 scale, and you can override it per game. Tags nudge a genre baseline
  rather than replacing it — they're capped, so a game carrying four "hard" tags can't be pinned at
  5 regardless of what it actually is. Only tags that speak to _challenge_ count: "story rich" and
  "atmospheric" describe a game without saying whether it's hard. A game with nothing to go on shows
  **?** rather than a made-up "Moderate", so an un-enriched library doesn't look like it's been
  assessed when it hasn't. Treat the score as a rough sort key, not a verdict.

A game you own on more than one store is matched by title and kept as a single entry. Games are
matched on a store's own id first, though, so two different games that share a name — DOOM
(1993/2016), Prey (2006/2017) — stay separate as long as each came from a store that has ids. A
pasted list has no ids to go on, so those still match by title alone; any merge made on a title is
listed after the sync, in case one of them was really two different games.

## Setup

Requires Node 20 through 26 — the range the native SQLite driver ships builds for.

```bash
npm install
npm run dev            # server on :3001, UI on http://localhost:5173
```

### Keys (all free)

Enter these in the app under **Settings → API keys** (stored in the local database), or put them in
a `.env` file (`cp .env.example .env`) — the Settings values win when both are set.

1. **Steam** (for your Steam library):
   1. Sign in at [steamcommunity.com/dev/apikey](https://steamcommunity.com/dev/apikey). For the
      domain name, anything works — `localhost` is fine. Copy the key → **Steam API key** /
      `STEAM_API_KEY`.
   2. Find your SteamID64 (a 17-digit number) at [steamid.io](https://steamid.io) → **SteamID64** /
      `STEAM_ID`.
   3. In Steam, open your profile → **Edit Profile → Privacy Settings** and set **Game details** to
      **Public**. Otherwise the API can't list your games.
2. **IGDB** (ratings, genres and tags — about five minutes, and you only do it once). IGDB is run
   by Twitch, so you sign in with a Twitch account:
   1. If you don't have a Twitch account, sign up at [twitch.tv](https://www.twitch.tv/). Twitch
      requires **two-factor authentication** before it lets you register an app — turn it on under
      **Settings → Security and Privacy**.
   2. Go to the [Twitch developer console](https://dev.twitch.tv/console/apps) and click
      **Register Your Application**.
   3. Fill it in: **Name** — anything unique, e.g. `whatgamesnext-yourname`. **OAuth Redirect
      URLs** — `http://localhost` (IGDB doesn't use it, but the form requires one). **Category** —
      _Application Integration_. **Client Type** — **Confidential**. Click **Create**.
   4. Click **Manage** on the new app. Copy the **Client ID** → **IGDB Client ID** /
      `IGDB_CLIENT_ID`.
   5. Click **New Secret** and copy it → **IGDB Client Secret** / `IGDB_CLIENT_SECRET`. Twitch only
      shows the secret once; if you lose it, generate a new one (the old one stops working).

   The app logs in to IGDB with these itself and renews its login as needed — there's nothing else
   to do. IGDB is free for non-commercial use under the
   [Twitch Developer Agreement](https://www.twitch.tv/p/legal/developer-agreement/).

3. **Epic (optional)**: `pip install legendary-gl`, then `legendary auth` once. Or skip it and paste
   your titles in Settings → Epic.
4. **RAWG (optional backup — you can skip this)**: a key from
   [rawg.io/apidocs](https://rawg.io/apidocs) → **RAWG API key** / `RAWG_API_KEY`. Only used for
   games IGDB can't answer for. RAWG is frequently down, so don't worry if its site won't load.

### First run

1. Open **Settings**, click **Sync Steam library** (and Epic). It'll offer to enrich whatever it
   brought in.
2. Enrichment fetches ratings, lengths and review scores for every game. Each source is held to
   its own polite pace, but three games are worked at once so the sources are waited on in
   parallel. Steam's store-details endpoint is the slowest lane (about one request every 1.5
   seconds), so expect roughly 40 minutes for 1,500 games that have a Steam id. A progress bar and
   time estimate show while it runs.
   It's resumable: results are saved per game, so an interrupted run picks up where it stopped and
   already-enriched games are skipped. A game whose IGDB lookup failed — wrong credentials, a rate
   limit, an outage — stays pending rather than counting as enriched (RAWG fills in meanwhile if you
   set it up), so the next run retries it on its own. If it keeps failing, Settings says so instead
   of reporting a clean run.
   Already enriched with RAWG before IGDB was added? Click **Refresh game data** once to fetch IGDB
   and Steam data for the whole library. Nothing RAWG already saved is thrown away.
3. Go to **What next?** and pick a mode.

### Backup and restore

**Settings → Backup** downloads your statuses, 1–10 ratings, notes, shortlist, finish dates, hidden
games and difficulty overrides. Everything else — ratings, lengths, review scores, cover art,
playtime — comes back on its own by re-syncing and re-enriching, so it isn't in the file; games
carrying nothing you wrote are left out entirely. JSON round-trips exactly. CSV holds the same data
for a spreadsheet, quoted properly, so a note with commas or line breaks in it survives the trip.

Restoring fills in games you already have and reports any it couldn't place rather than inventing
rows for them — sync first if you're restoring into an empty library. The file wins wherever it has
a value, and anything it has no value for is left as it is, so restoring onto a fresh sync is exact
and a hand-trimmed CSV is safe to paste.

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

The key fields under **Settings → API keys** are masked, with a **Show** button on each. That's
cover for whoever is stood behind you and nothing more — the API still hands a preview of every key
to anything that can reach the port, so the localhost binding above is what's actually protecting
them. Your SteamID is left visible on purpose: it's the number in your own profile URL.
