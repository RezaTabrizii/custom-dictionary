// Builds lexicon/en-fa.jsonl.gz from kaikki.org's English Wiktionary data,
// keeping only words with Persian translations.
//
//   npm run build:lexicon                     download from kaikki.org (a few GB, streamed)
//   npm run build:lexicon -- ./English.jsonl   use a file you downloaded (.jsonl or .jsonl.gz)

import { createReadStream, createWriteStream, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { buildLexicon, LEXICON_FILE, readLines } from "../src/lexicon.js";

const DEFAULT_SOURCE = "https://kaikki.org/dictionary/English/kaikki.org-dictionary-English.jsonl";
const source = process.argv[2] ?? DEFAULT_SOURCE;

async function open(src) {
  if (!/^https?:/.test(src)) return createReadStream(src);
  console.log(`Downloading ${src}`);
  const res = await fetch(src);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  return Readable.fromWeb(res.body);
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
    written++;
    yield `${JSON.stringify(r)}\n`;
  }
}

const lines = readLines(await open(source), source.endsWith(".gz"));
const out = fileURLToPath(LEXICON_FILE);
mkdirSync(dirname(out), { recursive: true });
await pipeline(toJsonl(buildLexicon(counted(lines))), createGzip({ level: 9 }), createWriteStream(out));
console.log(`Wrote ${written.toLocaleString()} words with Persian meanings to ${out}`);
