// Checks every online dictionary with a real request and shows what each returns.
//
//   npm run check:sources              checks "run"
//   npm run check:sources -- happy     checks another word

import { openDb } from "../src/db.js";
import { createFreeLookup, englishSources } from "../src/freeLookup.js";
import { loadLexicon } from "../src/lexicon.js";

const word = process.argv[2] ?? "run";
const key = process.env.MERRIAM_WEBSTER_KEY ?? "";
const sources = englishSources({ merriamWebsterKey: key });
let failures = 0;

if (!key) console.log("MERRIAM_WEBSTER_KEY isn't set, so Merriam-Webster is skipped. Add it to .env to check it.\n");

async function playable(url) {
  try {
    const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(8000) });
    return res.ok ? "plays" : `HTTP ${res.status}`;
  } catch (err) {
    return err.message;
  }
}

for (const source of sources) {
  console.log(`== ${source.name}`);
  try {
    const entry = await source.lookup(word);
    if (!entry) {
      console.log(`   doesn't know "${word}"\n`);
      continue;
    }
    console.log(`   OK: "${entry.word}" ${entry.phonetic}, ${entry.senses.length} meanings`);
    console.log(`   recording: ${entry.audio ? `${entry.audio} (${await playable(entry.audio)})` : "none"}`);
    for (const s of entry.senses.slice(0, 3)) {
      console.log(`   - ${s.partOfSpeech}: ${s.definition}${s.example ? `\n       e.g. ${s.example}` : ""}`);
    }
  } catch (err) {
    failures++;
    console.log(`   FAILED: ${err.message}`);
  }
  console.log("");
}

console.log("== What the app saves (first source that knows the word + offline Persian)");
const db = openDb();
const offlineWords = await loadLexicon(db);
if (!offlineWords) console.log("   (offline dictionary not found, so there's no Persian)");
try {
  const entry = await createFreeLookup({ db, sources })(word);
  console.log(`   "${entry.word}" ${entry.phonetic}`);
  for (const s of entry.senses) {
    console.log(`   - ${s.partOfSpeech}: ${s.persian.join("، ") || "(no Persian)"} | ${s.definition}`);
  }
} catch (err) {
  failures++;
  console.log(`   FAILED: ${err.message}`);
}

process.exitCode = failures ? 1 : 0;
