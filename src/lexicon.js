import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import { LookupError } from "./lookup.js";

// Converts kaikki.org (Wiktionary) English entries into the compact offline
// lexicon, and looks words up in it. One lexicon line looks like:
// {"word":"run","phonetic":"/rʌn/","forms":["ran","runs"],"senses":[{partOfSpeech, persian, definition, example}]}

export const LEXICON_FILE = new URL("../lexicon/en-fa.jsonl.gz", import.meta.url);

const POS = {
  noun: "noun", verb: "verb", adj: "adjective", adv: "adverb", pron: "pronoun",
  prep: "preposition", conj: "conjunction", intj: "interjection", det: "determiner",
  article: "determiner", phrase: "idiom", prep_phrase: "idiom", proverb: "idiom",
  num: "other", particle: "other", contraction: "other",
};
const SKIP_TAGS = new Set(["form-of", "alt-of", "obsolete", "archaic", "rare", "dated", "misspelling", "abbreviation"]);
const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "into", "something", "someone", "one", "its"]);
const MAX_SENSES = 8;
const MAX_PERSIAN = 4;

const isPersian = (t) => (t.code === "fa" || t.lang === "Persian" || t.lang === "Iranian Persian")
  && typeof t.word === "string" && /[؀-ۿ]/.test(t.word);

const tokens = (s = "") => new Set(s.toLowerCase().match(/[a-z]{3,}/g)?.filter((w) => !STOP.has(w)));

function shortExample(sense) {
  const texts = (sense.examples ?? []).map((e) => e.text?.trim()).filter((t) => t && t.length <= 160);
  return texts.find((t) => /^[A-Z"']/.test(t)) ?? texts[0] ?? "";
}

// Turns one kaikki entry (one word + part of speech) into senses that carry Persian.
export function convertEntry(entry) {
  if (entry.lang_code !== "en" || !entry.word) return null;
  let pos = POS[entry.pos];
  if (!pos) return null;
  if (pos === "verb" && entry.word.includes(" ")) pos = "phrasal verb";

  const senses = (entry.senses ?? [])
    .filter((s) => s.glosses?.length && !s.tags?.some((t) => SKIP_TAGS.has(t)))
    .map((s) => ({
      partOfSpeech: pos,
      persian: (s.translations ?? []).filter(isPersian).map((t) => t.word),
      definition: s.glosses.at(-1),
      example: shortExample(s),
      words: tokens(s.glosses.join(" ")),
    }));
  if (!senses.length) return null;

  // Translation tables are usually per entry, labelled with a short gloss; attach
  // each one to the sense whose definition shares the most words with that label.
  for (const t of (entry.translations ?? []).filter(isPersian)) {
    const label = tokens(t.sense);
    let best = senses[0];
    let bestScore = 0;
    for (const s of senses) {
      const score = [...label].filter((w) => s.words.has(w)).length;
      if (score > bestScore) [best, bestScore] = [s, score];
    }
    best.persian.push(t.word);
  }

  const kept = senses
    .filter((s) => s.persian.length)
    .map(({ words, persian, ...s }) => ({ ...s, persian: [...new Set(persian)].slice(0, MAX_PERSIAN) }));
  if (!kept.length) return null;

  const ipa = entry.sounds?.map((x) => x.ipa).filter(Boolean) ?? [];
  const forms = (entry.forms ?? [])
    .filter((f) => !f.tags?.some((t) => t === "table-tags" || t === "inflection-template"))
    .map((f) => f.form)
    .filter((f) => typeof f === "string" && /^[a-z][a-z'-]*$/i.test(f) && f.toLowerCase() !== entry.word.toLowerCase());

  return { word: entry.word, phonetic: ipa.find((p) => p.startsWith("/")) ?? ipa[0] ?? "", forms, senses: kept };
}

// Merges every part of speech of a word into one lexicon record.
export async function* buildLexicon(lines) {
  const byWord = new Map();
  for await (const line of lines) {
    if (!line.trim()) continue;
    const converted = convertEntry(JSON.parse(line));
    if (!converted) continue;
    const key = converted.word.toLowerCase();
    const prev = byWord.get(key);
    if (!prev) {
      byWord.set(key, converted);
      continue;
    }
    prev.phonetic ||= converted.phonetic;
    prev.forms = [...new Set([...prev.forms, ...converted.forms])];
    prev.senses.push(...converted.senses);
  }
  for (const rec of byWord.values()) {
    rec.senses = rec.senses.slice(0, MAX_SENSES);
    yield rec;
  }
}

export function readLines(stream, gzipped) {
  return createInterface({ input: gzipped ? stream.pipe(createGunzip()) : stream, crlfDelay: Infinity });
}

// Fills the lexicon table from the bundled file on first run, and again only
// when the file has changed.
export async function loadLexicon(db, file = LEXICON_FILE) {
  if (!existsSync(file)) return db.lexiconSize();
  const version = createHash("sha256").update(readFileSync(file)).digest("hex");
  if (db.lexiconVersion() === version) return db.lexiconSize();

  const records = [];
  for await (const line of readLines(createReadStream(file), true)) {
    if (line.trim()) records.push(JSON.parse(line));
  }
  db.importLexicon(records, version);
  return records.length;
}

export function createOfflineLookup(db) {
  return async function lookup(word) {
    const entry = db.findInLexicon(word);
    if (!entry) throw new LookupError(`"${word}" isn't in the offline dictionary.`);
    return entry;
  };
}
