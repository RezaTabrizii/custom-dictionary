import { mkdirSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { createApp } from "./app.js";
import { openDb } from "./db.js";
import { createFreeLookup, withRecording } from "./freeLookup.js";
import { loadLexicon } from "./lexicon.js";
import { createLookup } from "./lookup.js";

const dataDir = process.env.DATA_DIR ?? "data";
mkdirSync(dataDir, { recursive: true });
const db = openDb(join(dataDir, "dictionary.db"));

const lexiconSize = await loadLexicon(db);
console.log(lexiconSize
  ? `Offline dictionary: ${lexiconSize} words.`
  : "Offline dictionary is empty: run `npm run build:lexicon` to create lexicon/en-fa.jsonl.gz.");

// Claude when an API key is set; otherwise the Free Dictionary API for English
// plus the offline dictionary for Persian.
const lookup = process.env.ANTHROPIC_API_KEY
  ? withRecording(createLookup(), { db })
  : createFreeLookup({ db });
console.log(`Word lookups use ${process.env.ANTHROPIC_API_KEY ? "Claude" : "the Free Dictionary API and the offline dictionary"}.`);

const app = createApp({ db, lookup, password: process.env.APP_PASSWORD ?? "" });

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`Vazhe is running on http://localhost:${port}`);
  // Addresses other devices on the same Wi-Fi, like your phone, can use.
  for (const net of Object.values(networkInterfaces()).flat()) {
    if (net.family === "IPv4" && !net.internal) console.log(`  on your network: http://${net.address}:${port}`);
  }
});
