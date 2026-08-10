import { getDb, type GameRow, type Store } from "../db.js";
import { findExistingGame } from "./library.js";
import { normalizeTitle } from "./match.js";
import { compactQueue } from "./queue.js";
import { splitCsvLine, splitCsvRecords, toCsvLine } from "./import.js";

/**
 * Backup and restore of the part of the library you wrote yourself.
 *
 * Everything else in `games` — ratings, lengths, review scores, cover art,
 * playtime — comes back by re-syncing and re-enriching. These columns don't:
 * they exist only in data/games.db, and deleting that file is the documented
 * way to start over. So this is the one thing in the app worth a backup.
 */

export const BACKUP_VERSION = 1;

export interface BackupGame {
  // Identity, so a restore can find the game again after a fresh sync.
  title: string;
  normalized_title: string;
  store: Store;
  steam_appid: number | null;
  epic_app_name: string | null;
  // The authored part. All nullable, including the two columns the database
  // stores NOT NULL: an export always fills them in, but a CSV someone trimmed
  // by hand may not have the column at all, and a missing column has to mean
  // "leave it alone" rather than "set it to the default".
  status: GameRow["status"] | null;
  status_changed_at: string | null;
  finished_at: string | null;
  personal_rating: number | null;
  notes: string | null;
  queue_position: number | null;
  hidden: 0 | 1 | null;
  difficulty_override: number | null;
}

export interface Backup {
  version: number;
  exportedAt: string;
  games: BackupGame[];
}

export interface RestoreSummary {
  restored: number;
  unchanged: number;
  /** Titles in the backup with nothing in the library to attach them to. */
  notFound: string[];
}

const COLUMNS: (keyof BackupGame)[] = [
  "title",
  "normalized_title",
  "store",
  "steam_appid",
  "epic_app_name",
  "status",
  "status_changed_at",
  "finished_at",
  "personal_rating",
  "notes",
  "queue_position",
  "hidden",
  "difficulty_override",
];

/** Fields a restore writes back. The rest are only there to find the row. */
const AUTHORED = [
  "status",
  "status_changed_at",
  "finished_at",
  "personal_rating",
  "notes",
  "queue_position",
  "hidden",
  "difficulty_override",
] as const satisfies readonly (keyof BackupGame)[];

const STATUSES: GameRow["status"][] = ["unplayed", "playing", "finished", "abandoned"];

/**
 * Only games carrying something you did. A library is mostly rows the app
 * filled in by itself, and a backup of those is a slower way to re-sync.
 *
 * `status` alone isn't evidence: it's inferred from playtime for anything with
 * two hours on it, and `status_changed_at` is written only by the PATCH route,
 * so a value there is what marks a status as yours.
 */
const AUTHORED_FILTER = `
  status_changed_at IS NOT NULL
  OR finished_at IS NOT NULL
  OR personal_rating IS NOT NULL
  OR notes IS NOT NULL
  OR queue_position IS NOT NULL
  OR difficulty_override IS NOT NULL
  OR hidden = 1
`;

export function exportBackup(): Backup {
  const games = getDb()
    .prepare(`SELECT ${COLUMNS.join(", ")} FROM games WHERE ${AUTHORED_FILTER} ORDER BY id`)
    .all() as BackupGame[];
  return { version: BACKUP_VERSION, exportedAt: new Date().toISOString(), games };
}

export function toCsv(backup: Backup): string {
  const rows = backup.games.map((g) => toCsvLine(COLUMNS.map((c) => g[c])));
  return [COLUMNS.join(","), ...rows].join("\n") + "\n";
}

function fail(message: string): never {
  throw new Error(message);
}

function asNumber(value: unknown, field: string, title: string): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n))
    fail(`${title}: ${field} must be a whole number, got "${String(value)}"`);
  return n;
}

function asText(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  return s ? s : null;
}

/** Normalize one entry from either format, rejecting anything the schema would. */
function toBackupGame(raw: Record<string, unknown>): BackupGame {
  const title = asText(raw.title) ?? fail("every entry needs a title");
  const rating = asNumber(raw.personal_rating, "personal_rating", title);
  if (rating != null && (rating < 1 || rating > 10)) {
    fail(`${title}: personal_rating must be between 1 and 10, got ${rating}`);
  }
  const difficulty = asNumber(raw.difficulty_override, "difficulty_override", title);
  if (difficulty != null && (difficulty < 1 || difficulty > 5)) {
    fail(`${title}: difficulty_override must be between 1 and 5, got ${difficulty}`);
  }
  const status = asText(raw.status) as GameRow["status"] | null;
  if (status && !STATUSES.includes(status)) fail(`${title}: unknown status "${status}"`);

  return {
    title,
    // A backup written by hand may not carry it; the export always does.
    normalized_title: asText(raw.normalized_title) ?? "",
    store: (asText(raw.store) as Store | null) ?? "other",
    steam_appid: asNumber(raw.steam_appid, "steam_appid", title),
    epic_app_name: asText(raw.epic_app_name),
    status,
    status_changed_at: asText(raw.status_changed_at),
    finished_at: asText(raw.finished_at),
    personal_rating: rating,
    notes: asText(raw.notes),
    queue_position: asNumber(raw.queue_position, "queue_position", title),
    hidden:
      raw.hidden == null || raw.hidden === ""
        ? null
        : asNumber(raw.hidden, "hidden", title)
          ? 1
          : 0,
    difficulty_override: difficulty,
  };
}

/** Accepts either format: JSON round-trips exactly, CSV opens in a spreadsheet. */
export function parseBackup(text: string): Backup {
  const trimmed = text.trim();
  if (!trimmed) fail("that file is empty");

  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      fail("that doesn't look like a backup file — the JSON wouldn't parse");
    }
    const body = parsed as Partial<Backup>;
    if (!Array.isArray(body.games)) fail("a backup needs a `games` array");
    // Refusing beats guessing. A newer file may carry columns this build would
    // drop on the floor, and a restore that silently loses half your notes is
    // worse than one that declines and tells you why.
    if (typeof body.version === "number" && body.version > BACKUP_VERSION) {
      fail(
        `this backup is version ${body.version}, but this version of whatGamesNext only understands version ${BACKUP_VERSION} — update the app first`,
      );
    }
    return {
      version: typeof body.version === "number" ? body.version : BACKUP_VERSION,
      exportedAt: typeof body.exportedAt === "string" ? body.exportedAt : "",
      games: body.games.map((g) => toBackupGame(g as unknown as Record<string, unknown>)),
    };
  }

  const records = splitCsvRecords(trimmed);
  const header = splitCsvLine(records[0]).map((c) => c.trim().toLowerCase());
  if (!header.includes("title")) fail("a CSV backup needs a header row with a `title` column");
  const games = records.slice(1).map((record) => {
    const cells = splitCsvLine(record);
    const raw: Record<string, unknown> = {};
    header.forEach((name, i) => (raw[name] = cells[i]));
    return toBackupGame(raw);
  });
  return { version: BACKUP_VERSION, exportedAt: "", games };
}

/**
 * Apply a backup to the library.
 *
 * The rule is one sentence: the backup wins for every field it carries a value
 * for, and a null in it never clears something the row already has. That makes
 * restoring onto a fresh sync exact, and a hand-trimmed CSV safe to paste.
 *
 * Games it can't match are reported, not created. A backup carries no ratings,
 * lengths or cover art, so a row invented here would be a bare title pretending
 * to be a game you own.
 */
export function importBackup(backup: Backup): RestoreSummary {
  const db = getDb();
  const summary: RestoreSummary = { restored: 0, unchanged: 0, notFound: [] };

  // All or nothing: a half-applied restore is harder to reason about than one
  // that refused, and the parse above has already rejected bad values.
  db.transaction(() => {
    for (const entry of backup.games) {
      const match = findExistingGame({
        // The same normalizer the library was built with. Lowercasing alone
        // isn't it: `normalized_title` has had punctuation folded, roman
        // numerals mapped and edition suffixes stripped, so a hand-written
        // "Control: Ultimate Edition" would never match the "Control" row it
        // obviously means.
        normalizedTitle: entry.normalized_title || normalizeTitle(entry.title),
        steamAppid: entry.steam_appid,
        epicAppName: entry.epic_app_name,
      });
      if (!match) {
        summary.notFound.push(entry.title);
        continue;
      }

      const current = db
        .prepare(`SELECT ${AUTHORED.join(", ")} FROM games WHERE id = ?`)
        .get(match.id) as Record<string, unknown>;
      const target: Record<string, unknown> = {};
      for (const field of AUTHORED) target[field] = entry[field] ?? current[field];

      if (AUTHORED.every((f) => target[f] === current[f])) {
        summary.unchanged++;
        continue;
      }
      db.prepare(
        `UPDATE games SET ${AUTHORED.map((f) => `${f} = @${f}`).join(", ")} WHERE id = @id`,
      ).run({ ...target, id: match.id });
      summary.restored++;
    }
    compactQueue(db);
  })();

  return summary;
}
