import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface EpicGame {
  appName: string; // legendary's internal id
  title: string;
}

/**
 * List owned Epic games via the `legendary` CLI (https://github.com/derrod/legendary).
 * Requires the user to have run `legendary auth` once.
 */
export async function fetchEpicGames(): Promise<EpicGame[]> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("legendary", ["list", "--json"], {
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120_000,
    }));
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      throw new Error(
        "legendary CLI not found on PATH. Install it (pip install legendary-gl), run `legendary auth`, " +
          "or use manual import instead.",
      );
    }
    throw new Error(`legendary list failed: ${e.message ?? String(err)}`);
  }
  return parseLegendaryList(stdout);
}

export function parseLegendaryList(json: string): EpicGame[] {
  const parsed = JSON.parse(json) as Array<{
    app_name?: string;
    app_title?: string;
    metadata?: { title?: string };
  }>;
  if (!Array.isArray(parsed)) throw new Error("Unexpected legendary output");
  return parsed
    .map((g) => ({
      appName: g.app_name ?? "",
      title: g.app_title ?? g.metadata?.title ?? "",
    }))
    .filter((g) => g.title);
}

/**
 * Parse a manually pasted list of Epic game titles — one per line.
 * Tolerates bullet characters and blank lines.
 */
export function parseManualTitles(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^[\s\-–•*]+/, "").trim())
    .filter((line) => line.length > 0);
}
