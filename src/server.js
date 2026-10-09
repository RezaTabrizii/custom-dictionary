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

// TRUST_PROXY: set when an https proxy sits in front (most hosts), e.g. "1".
const trust = process.env.TRUST_PROXY ?? "";
const trustProxy = /^\d+$/.test(trust) ? Number(trust) : trust === "true" ? true : trust || false;
const signupCode = process.env.SIGNUP_CODE ?? "";
const app = createApp({ db, lookup, signupCode, trustProxy });
console.log(signupCode
  ? "New accounts need the invite code in SIGNUP_CODE."
  : db.userCount()
    ? "Sign-up is closed (set SIGNUP_CODE to let others create accounts)."
    : "Open the app to create the first account; it gets the words saved so far.");
if (process.env.APP_PASSWORD) console.warn("APP_PASSWORD is no longer used: everyone signs in with their own account.");

const port = Number(process.env.PORT ?? 3000);
const server = app.listen(port, () => {
  console.log(`Vazhe is running on http://localhost:${port}`);
  // Addresses other devices on the same Wi-Fi, like your phone, can use.
  for (const net of Object.values(networkInterfaces()).flat()) {
    if (net.family === "IPv4" && !net.internal) console.log(`  on your network: http://${net.address}:${port}`);
  }
});

// Docker stops containers with SIGTERM: finish open requests, then close the database cleanly.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
