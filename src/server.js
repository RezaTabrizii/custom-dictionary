import { mkdirSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { createApp } from "./app.js";
import { openDb } from "./db.js";
import { createFreeLookup, englishSources, withRecording } from "./freeLookup.js";
import { loadLexicon } from "./lexicon.js";
import { createLookup } from "./lookup.js";

const dataDir = process.env.DATA_DIR ?? "data";
mkdirSync(dataDir, { recursive: true });
const db = openDb(join(dataDir, "dictionary.db"));

const lexiconSize = await loadLexicon(db);
console.log(lexiconSize
  ? `Offline dictionary: ${lexiconSize} words.`
  : "Offline dictionary is empty: run `npm run build:lexicon` to create lexicon/en-fa.jsonl.gz.");

// Claude when an API key is set; otherwise online dictionaries for English plus
// the offline dictionary for Persian.
const sources = englishSources({ merriamWebsterKey: process.env.MERRIAM_WEBSTER_KEY ?? "" });
const lookup = process.env.ANTHROPIC_API_KEY
  ? withRecording(createLookup(), { db, sources })
  : createFreeLookup({ db, sources });
console.log(process.env.ANTHROPIC_API_KEY
  ? "Word lookups use Claude."
  : `Word lookups use ${sources.map((s) => s.name).join(", then ")} for English, and the offline dictionary for Persian.`);

const app = createApp({ db, lookup, password: process.env.APP_PASSWORD ?? "" });

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`Vazhe is running on http://localhost:${port}`);
  // Addresses other devices on the same Wi-Fi, like your phone, can use.
  for (const net of Object.values(networkInterfaces()).flat()) {
    if (net.family === "IPv4" && !net.internal) console.log(`  on your network: http://${net.address}:${port}`);
  }
});
