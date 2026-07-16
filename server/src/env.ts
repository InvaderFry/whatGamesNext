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
  demo: process.env.DEMO === "1",
  dataDir: process.env.DATA_DIR || path.join(repoRoot, "data"),
};
