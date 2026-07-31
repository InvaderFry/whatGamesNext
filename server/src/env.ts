import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// .env lives at the repo root, two levels up from server/src (or server/dist)
export const repoRoot = path.resolve(__dirname, "..", "..");
dotenv.config({ path: path.join(repoRoot, ".env") });

export const env = {
  steamApiKey: process.env.STEAM_API_KEY ?? "",
  steamId: process.env.STEAM_ID ?? "",
  rawgApiKey: process.env.RAWG_API_KEY ?? "",
  port: Number(process.env.PORT) || 3001,
  // Loopback by default: the API has no auth and can read and write your API
  // keys, so it must not be reachable from the rest of the network unless the
  // user opts in (HOST=0.0.0.0).
  host: process.env.HOST || "127.0.0.1",
  demo: process.env.DEMO === "1",
  dataDir: process.env.DATA_DIR || path.join(repoRoot, "data"),
};
