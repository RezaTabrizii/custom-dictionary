// Shows a word's family from the offline data, and what happens to each word
// when it's added: already saved, skipped because you deleted it, or added.
//
//   npm run check:family -- quick

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../src/db.js";
import { loadLexicon } from "../src/lexicon.js";

const word = (process.argv[2] ?? "quick").toLowerCase();
const dataDir = process.env.DATA_DIR ?? "data";
mkdirSync(dataDir, { recursive: true });
const db = openDb(join(dataDir, "dictionary.db"));
await loadLexicon(db);

const { name, members } = db.wordFamily(word, 50);
if (!members.length) {
  console.log(`"${word}" has no family in the offline data.`);
  console.log("If the offline file was built before word families were added, rebuild it (see the README).");
} else {
  console.log(`Family "${name}", nearest first (up to 8 are added):`);
  members.forEach((m, i) => {
    const state = db.findWord(m) ? "already saved"
      : db.isDismissed(m) ? "skipped: you deleted it before"
      : i < 8 ? "would be added" : "not added (more than 8)";
    console.log(`  ${m.padEnd(20)} ${state}`);
  });
}
