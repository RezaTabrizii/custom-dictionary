// Builds lexicon/en-fa.jsonl.gz from kaikki.org's English Wiktionary data,
// keeping only words with Persian translations.
//
//   npm run build:lexicon                     download from kaikki.org (a few GB), then build
//   npm run build:lexicon -- ./English.jsonl   use a file you downloaded (.jsonl or .jsonl.gz)

import { createReadStream, createWriteStream, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { buildLexicon, COMMON_WORDS_FILE, LEXICON_FILE, readLines } from "../src/lexicon.js";
import { download } from "./download.js";

const DEFAULT_SOURCE = "https://kaikki.org/dictionary/English/kaikki.org-dictionary-English.jsonl";
const out = fileURLToPath(LEXICON_FILE);
mkdirSync(dirname(out), { recursive: true });

let source = process.argv[2] ?? DEFAULT_SOURCE;
if (/^https?:/.test(source)) {
  // Downloaded first, so a dropped connection resumes instead of cutting the data short.
  const file = join(dirname(out), "kaikki-English.jsonl");
  await download(source, file);
  source = file;
}

let read = 0;
async function* counted(lines) {
  for await (const line of lines) {
    if (++read % 100_000 === 0) console.log(`  read ${read.toLocaleString()} entries`);
    yield line;
  }
}

let written = 0;
async function* toJsonl(records) {
  for await (const r of records) {
    if (r.word) written++;
    yield `${JSON.stringify(r)}\n`;
  }
}

console.log(`Building from ${source}`);
const stats = {};
const common = new Set();
for await (const word of readLines(createReadStream(COMMON_WORDS_FILE), true)) common.add(word.trim());
const lines = readLines(createReadStream(source), source.endsWith(".gz"));
await pipeline(toJsonl(buildLexicon(counted(lines), stats, { common })), createGzip({ level: 9 }), createWriteStream(out));

console.log(`Wrote ${written.toLocaleString()} words with Persian meanings and ${stats.families.toLocaleString()} word families to ${out}`);
if (stats.badLines) console.warn(`Skipped ${stats.badLines} unreadable line(s) in the source file.`);
if (source.endsWith("kaikki-English.jsonl")) console.log(`You can delete ${source} to free disk space.`);
