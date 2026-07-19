/**
 * Generic library import for stores without an API integration (GOG, itch.io,
 * humble, …). Accepts either a plain list of titles (one per line, bullets
 * tolerated) or CSV with a header row containing a `title` column and an
 * optional playtime column (`playtime_hours`, `hours`, or `playtime`).
 */

export interface ImportedGame {
  title: string;
  playtimeMinutes?: number;
}

const PLAYTIME_HEADERS = ["playtime_hours", "hours", "playtime"];

export function parseImportText(text: string): ImportedGame[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return [];

  const header = splitCsvLine(lines[0]).map((c) => c.trim().toLowerCase());
  const titleIdx = header.indexOf("title");
  if (titleIdx < 0) {
    // Plain title-per-line list.
    return lines
      .map((line) => line.replace(/^[\s\-–•*]+/, "").trim())
      .filter(Boolean)
      .map((title) => ({ title }));
  }

  const hoursIdx = header.findIndex((c) => PLAYTIME_HEADERS.includes(c));
  return lines
    .slice(1)
    .map(splitCsvLine)
    .map((cells) => {
      const title = (cells[titleIdx] ?? "").trim();
      const hours = hoursIdx >= 0 ? Number(cells[hoursIdx]) : NaN;
      const game: ImportedGame = { title };
      if (Number.isFinite(hours) && hours > 0) game.playtimeMinutes = Math.round(hours * 60);
      return game;
    })
    .filter((g) => g.title);
}

/** Minimal quote-aware CSV field splitter for a single line. */
export function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      cells.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells;
}
