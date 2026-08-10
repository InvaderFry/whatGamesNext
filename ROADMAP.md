# Remaining work

Handoff notes for whatever picks this up next. Everything here comes out of a feature review of the
whole codebase; the items already built are listed at the bottom for context.

**Branch:** `claude/whatgamesnext-review-assessment-v408hr`.
**Suite:** 268 tests — 181 server, 87 web. CI runs `npm test`, `npm run typecheck`, `npm run lint`,
`npm run format:check`; all four should stay green.

---

## How this codebase likes to be worked on

Worth reading before writing anything, so new work doesn't look bolted on.

- **The architecture is deliberately plain.** Express + better-sqlite3 + React. No ORM, no state
  library, no CSS framework, no router. URL state is a 20-line helper (`web/src/urlState.ts`)
  precisely so react-router isn't needed. Reach for a dependency only if it earns itself.
- **Comments say _why_, not _what_.** Every non-obvious constant in this repo explains the reasoning
  behind its value. `MAX_TAG_ADJUSTMENT = 2` has a paragraph on why not 1.5. Match that.
- **Missing data degrades to neutral, never to zero.** `lib/score.ts` returns 0.4–0.5 for unknown
  components so unenriched games aren't unfairly buried, and `deriveDifficulty` returns `null`
  rather than a confident "Moderate" when it knows nothing. Follow the pattern; don't invent
  certainty.
- **Unofficial sources fail soft.** HowLongToBeat is scraped and has a circuit breaker after three
  consecutive errors. Anything new that scrapes should do the same and say so in the README.
- **Tests read as sentences.** `it("keeps the chosen page when a pending search debounce resolves")`.
  Route-level integration tests against in-memory SQLite are the high-value kind here — prefer them
  over mocking internals.
- **Verify in a real browser, not just in tests.** Roughly half the bugs found while building the
  shipped work were invisible to the test suite: a prompt rendering above the fold, buttons wrapping
  mid-word, bar charts pointing the wrong way, two controls sharing an accessible name. Drive the
  app with Playwright and _look at a screenshot_ before calling something done.
- **Measure claims instead of asserting them.** "~3× faster" became a throwaway benchmark that said
  2.6×; the commit message says 2.6×.
- **Never fabricate data.** Demo mode deliberately has no Steam appids, because its library is a
  curated fiction and a Play button there would hand Steam a game the user may not own.

### Environment gotchas that cost time

- **Every external data source is unreachable** from the dev sandbox under its network policy — all
  Steam domains (`api.steampowered.com`, `store.steampowered.com`, `steamcommunity.com`) and also
  `api.rawg.io` and `howlongtobeat.com`, all curl exit 56. Only the npm registry resolves. Anything
  touching a source has to be built against fixtures and verified by unit test, and the demo library
  is the only way to drive the real UI. Worth weighing when picking what to do next: the roadmap
  items that lean hardest on Steam are the ones that can't be confirmed here at all.
- **jsdom has no `Element.prototype.scrollIntoView`** — stubbed in `web/src/test-setup.ts`.
- Playwright is at `/opt/pw-browsers`; don't run `playwright install`.
- `data/` is gitignored. `rm -f data/games.db*` then restart with `DEMO=1` for a clean library.
- Demo seeding runs the same playtime→status promotion a sync does, so every recommend mode returns
  something. If you add a mode, make sure the demo can demonstrate it.

---

## Feature ideas still open

Ranked by what I'd do next. Export/import used to sit at #2 here and was done first: it protects the
only data in the app that can't be re-derived, and it was verifiable end to end in a sandbox that
can't reach Steam.

### 1. Steam achievements + recently-played

The biggest missing input for the taste model. Today a game you played 60 hours and never marked
contributes nothing to what the app has learned about you.

- `GetRecentlyPlayedGames` — **one call**, cheap, high value. Auto-marks what you're actually playing
  without touching a dropdown. Should respect the same `status_changed_at IS NULL` guard the playtime
  inference uses (`lib/library.ts:promoteStartedGames`) so it never overrides a manual choice.
- `GetPlayerAchievements` — **one call per game**, so it belongs inside the enrichment pipeline
  behind the existing per-host rate limiter (`lib/enrich.ts`), not in a sync. Gives real completion
  percentages, which are far better evidence than a binary finished flag.

Fail soft: the achievements endpoint 403s for private profiles and for games that have no
achievements at all. Neither is an error worth showing.

### 2. Import from other trackers

Export/import of your own data is done (`lib/backup.ts`). Pulling a history _in_ from Backloggd,
HLTB or GOG Galaxy is the separate, bigger job it always was: each has its own export shape, and
each needs mapping onto the four statuses and a 1–10 scale. `lib/import.ts` now has a record
splitter that keeps quoted newlines intact, so the CSV side of it is groundwork already laid.

### 3. Wishlist mode

"Should I buy this or play something I own" — and the answer is usually the latter, which suits the
whole thesis of the app. Steam wishlists are fetchable but the endpoint is unofficial and needs a
public profile, so treat it like HLTB: fail soft, say so in the README.

Needs a decision on whether wishlist entries live in `games` behind a flag or in their own table.
They shouldn't pollute backlog counts or recommendations either way.

### 4. Co-op / multiplayer filter

The cheap half is nearly free: RAWG tags already include co-op and multiplayer markers, and the
Library and Recommend pages both have tag filtering. The expensive half — intersecting with a
friend's library via `GetFriendList` + their `GetOwnedGames` to answer "what do we both own" — is a
much bigger feature and depends on their profile being public.

### 5. Steam Deck compatibility

"What can I play on the Deck tonight" is a strong filter for exactly this app's audience. Steam
exposes compatibility categories through an unofficial endpoint; same fail-soft treatment as HLTB,
and it slots into enrichment alongside the other per-game lookups.

### 6. PWA

Deciding what to play from the couch. The layout half is done (R18): there's a `max-width: 640px`
block at the bottom of `web/src/styles.css`, the header wraps, the nav scrolls sideways and the
Shortlist stacks, all verified at 390px in Chromium. What's left is the PWA proper — a manifest, a
service worker, an install prompt, and offline access to the last synced library — plus the
couch-sized rethink of the controls, which is a design job rather than a CSS one.

### 7. Weekly digest

**Has a design problem worth resolving before writing code.** A scheduled "your pick of the week"
assumes something is running to fire it, but this is a local tool people start when they want it —
there's no daemon, and a desktop notification needs the browser open. Options are a real background
service, an email send from a machine that _is_ always on, or reframing it as "here's what you missed"
shown on next launch. The third is the only one that doesn't change what this app _is_.

### 8. Multiple profiles

For a shared machine. Touches every table and every query — a foreign key on `games` plus a profile
scope threaded through all of `lib/library.ts`, `lib/queue.ts`, `lib/taste.ts` and the stats
aggregates. Large, and the least valuable for a tool most people run alone. Do it last, if at all.

---

## Already shipped

For context on what's been touched, and so nothing gets built twice.

| #   | Item                                                              | Commit               |
| --- | ----------------------------------------------------------------- | -------------------- |
| R1  | Fix `EDITION_SUFFIXES` over-stripping (silent data loss)          | PR #3                |
| R2  | Make enrichment re-runnable; stop marking games done with no data | PR #3                |
| R3  | Bind to `127.0.0.1` by default                                    | PR #3                |
| R9  | Test `lib/enrich.ts`                                              | PR #3                |
| R4  | Paginate the Library, debounce search                             | `87a4ec2`            |
| R5  | Expose scoring weights + genre/tag/difficulty filters             | `87a4ec2`            |
| F1  | Steam launch + store links on the card                            | `c3a17fb`            |
| R12 | Filter/sort/page state in the URL                                 | `c3a17fb`            |
| R7  | Offer to enrich right after a sync                                | `0a66a87`            |
| R8  | Infer `playing` status from playtime                              | `0a66a87`            |
| R10 | Persist enrichment run state, show an ETA                         | `ee79d37`            |
| R11 | Parallel enrichment with per-host rate limiting (2.6× measured)   | `ee79d37`            |
| R13 | Cap difficulty tag adjustment, drop non-signal genres             | `5219214`, `f4fc166` |
| R14 | A11y pass — tablist, light theme, loading skeletons               | `5219214`            |
| F2  | "Tonight" mode — games already under way, ranked by time left     | `106d866`            |
| F3  | Shortlist queue                                                   | `106d866`            |
| F7  | Personal 1–10 rating + notes                                      | `808f441`            |
| F9  | Richer Stats — genre breakdown, backlog estimate, year-on-year    | `808f441`            |
| F5  | Learned taste from your own history                               | `683d0db`            |
| R6  | Match on a store id first, so two DOOMs stay two rows             | `911a001`            |
| F4  | Backup/restore of everything you authored (JSON + CSV)            | `39b8559`            |
| R15 | A failed RAWG lookup no longer marks a game enriched              | `93ac818`            |
| R16 | Quick wins checks the rating its own subtitle promises            | `7744609`            |
| R17 | Restore normalizes hand-written titles; backup version guard      | `d035fa0`            |
| R18 | Narrow-screen layout — the app fits a 390px phone                 | `ef438c3`            |

Things shipped with known, deliberate limits, in case they look like oversights:

- **URL state uses `replaceState` only.** Bookmark, reload and share work; back/forward _between_
  filter states does not. Adding a `popstate` listener is the follow-up if it's wanted.
- **The taste model is a feedback loop by construction.** It surfaces more of what you already play.
  The Stats section makes the bias visible and the weight slider turns it down; that's the mitigation,
  not a fix.
- **A pasted list can still collide.** R6 keys on a store's own id, and a title typed into Settings →
  Other stores has none, so two same-named games imported that way still merge. It's reported now
  rather than silent, which is as far as it goes without an id to key on.
- **A backup holds no games, only what you wrote about them.** Restoring into an empty library
  restores nothing and says so. That's deliberate — the alternative is inventing rows for titles
  with no store, no ratings and no lengths behind them.

### Left open from the R15–R18 pass

An external feature review turned these up. All four are real, all four are cheap, none of them
were worth their own risk alongside the correctness fixes:

- **Unbounded numeric query params.** `/api/recommend` takes `budget`, `limit`, `maxDifficulty` and
  the five `w_*` weights straight from the query string through `Number()`, so `limit=99999`
  serializes the whole library and a negative weight inverts the ranking. Harmless on a
  single-user localhost app with no adversary, but a small `boundedNumber(value, {min, max,
fallback})` helper in `routes/recommend.ts` would close all eight at once.
- **Library requests can land out of order.** `load()` in `web/src/pages/Library.tsx` has no
  `AbortController` and no sequence guard, so a slow response for an old filter can overwrite a
  newer one. The 300ms search debounce hides most of it and the window is tiny over loopback.
- **`LIKE` wildcards aren't escaped.** `lib/library.ts:312` interpolates the search term into
  `title LIKE @search`, so a `%` or `_` typed into the box acts as a wildcard. Parameterized, so
  not an injection — just a surprise if a title ever needs one.
- **API keys are plain text inputs** (`pages/Settings.tsx`). A password input with a reveal toggle
  is a one-word change, though it's cosmetic: `GET /api/settings` returns a preview of each key to
  anyone who can reach the port anyway, which is what the localhost binding is really protecting.

And one thing found while fixing R17, left alone deliberately:

- **`normalizeTitle` leaves a bare "edition" behind on "GOTY Edition".** `BARE_EDITIONS` strips
  `goty` on its own, and nothing then removes the orphaned `edition`, so
  `"Wild Hunt - GOTY Edition"` normalizes to `wild hunt edition` while
  `"... - Game of the Year Edition"` correctly gives `wild hunt`. Worth fixing, but
  `normalized_title` is the key rows are matched on: changing the function changes which games
  merge, so it wants a migration plan and a careful look at existing libraries rather than a
  one-line regex tweak.

Two small things noticed earlier and still open:

- **`.btn` was scoped to `button`**, so the first pass at the download links rendered as bare text.
  Fixed by broadening the selector, but it's the sort of thing only a screenshot catches — the
  test suite was green through both versions.
- **Enrichment still can't be stopped** once started. A 1,500-game run is ~25 minutes and the only
  way out is restarting the server, which the interrupted-run notice then explains. A cancel flag
  the workers check between games would be a small, self-contained job.
