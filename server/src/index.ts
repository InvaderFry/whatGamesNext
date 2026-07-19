import { env } from "./env.js";
import { getDb } from "./db.js";
import { createApp } from "./app.js";
import { seedDemoData } from "./demo.js";

const app = createApp();

getDb();
if (env.demo) {
  const seeded = seedDemoData();
  if (seeded) console.log(`[demo] seeded ${seeded} sample games`);
}

app.listen(env.port, () => {
  console.log(`whatGamesNext server listening on http://localhost:${env.port}`);
  if (!env.steamApiKey) console.log("  (STEAM_API_KEY not set — Steam sync disabled)");
  if (!env.rawgApiKey) console.log("  (RAWG_API_KEY not set — rating enrichment disabled)");
});
