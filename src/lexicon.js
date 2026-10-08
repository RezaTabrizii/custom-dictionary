import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { cleanPersian, cleanSenses, CLEANUP_VERSION } from "./persian.js";
import { createGunzip } from "node:zlib";

// Converts kaikki.org (Wiktionary) English entries into the compact offline
// lexicon, which supplies Persian meanings when there is no Claude API key. One lexicon line looks like:
// {"word":"run","phonetic":"/rʌn/","audio":"https://…/En-us-run.mp3","forms":["ran","runs"],"senses":[{partOfSpeech, persian, definition, example}]}
// After the words come the word families, one base word per line:
// {"base":"quick","derived":["quickly","quickness","quicken"]}

export const LEXICON_FILE = new URL("../lexicon/en-fa.jsonl.gz", import.meta.url);
// English words that appear at least 50 times in the FrequencyWords subtitle
// corpus, so the word families leave out rare words.
export const COMMON_WORDS_FILE = new URL("../lexicon/common-words.txt.gz", import.meta.url);

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

export const tokens = (s = "") => new Set(s.toLowerCase().match(/[a-z]{3,}/g)?.filter((w) => !STOP.has(w)));

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
    .map(({ words, persian, ...s }) => ({ ...s, persian: cleanPersian(persian).slice(0, MAX_PERSIAN) }));
  if (!kept.length) return null;

  const ipa = entry.sounds?.map((x) => x.ipa).filter(Boolean) ?? [];
  const recordings = (entry.sounds ?? []).filter((x) => x.mp3_url);
  const recording = recordings.find((x) => x.tags?.some((t) => t === "US" || t === "General-American")) ?? recordings[0];
  const forms = (entry.forms ?? [])
    .filter((f) => !f.tags?.some((t) => t === "table-tags" || t === "inflection-template"))
    .map((f) => f.form)
    .filter((f) => typeof f === "string" && /^[a-z][a-z'-]*$/i.test(f) && f.toLowerCase() !== entry.word.toLowerCase());

  return {
    word: entry.word,
    phonetic: ipa.find((p) => p.startsWith("/")) ?? ipa[0] ?? "",
    audio: recording?.mp3_url ?? "",
    forms,
    senses: kept,
  };
}

// Merges every part of speech of a word into one lexicon record. Lines that
// aren't valid JSON are skipped and counted in stats.badLines.
/* ---------- Word families ---------- */

// Suffixes that make another form of the same word (quick -> quickly, quickness).
// Prefixes are left out: they change the meaning (happy -> unhappy).
const SUFFIXES = [
  "ly", "ally", "ness", "ity", "ment", "ion", "tion", "ation", "er", "or", "ful", "less",
  "able", "ible", "al", "ial", "ive", "ize", "ise", "en", "ous", "ic", "ical",
  "ance", "ence", "ant", "ent", "ship", "hood", "ist", "ism", "y",
];
// Senses with these tags don't make a word common enough to add on its own.
const UNCOMMON_TAGS = new Set([...SKIP_TAGS, "nonstandard", "nonce-word", "dialectal", "slang", "uncommon"]);
const PLAIN_WORD = /^[a-z]+$/;

// The spellings a word takes before a suffix: happy -> happi(ness), make -> mak(er),
// run -> runn(er), gentle -> gentl(y).
function stems(base) {
  const out = [base];
  if (base.endsWith("e")) out.push(base.slice(0, -1));
  if (/[^aeiou]y$/.test(base)) out.push(`${base.slice(0, -1)}i`);
  if (/[^aeiou][aeiou][bdgklmnprt]$/.test(base)) out.push(base + base.at(-1));
  return out;
}

// Whether `word` is `base` plus one of the suffixes.
export function derivesFrom(word, base) {
  return word !== base && stems(base).some((stem) =>
    word.startsWith(stem) && SUFFIXES.includes(word.slice(stem.length)));
}

// The base word an entry's etymology says it was made from, as in "quick + -ly".
function etymologyBase(entry) {
  for (const t of entry.etymology_templates ?? []) {
    if (!["suffix", "suf", "surf", "af", "affix"].includes(t.name) || t.args?.["1"] !== "en") continue;
    const parts = Object.keys(t.args).filter((k) => /^\d+$/.test(k) && k !== "1")
      .sort((a, b) => a - b).map((k) => t.args[k]);
    if (parts.length === 2 && PLAIN_WORD.test(parts[0]) && SUFFIXES.includes(parts[1].replace(/^-/, ""))) return parts[0];
  }
  return null;
}

// Collects suffix pairs (word made from base) from every English entry, so the
// families include words without Persian, like "quickness". With a list of
// common words (`known`), a family keeps only words on it or in the lexicon,
// which leaves out rare ones like "quickener".
function familyCollector(known) {
  const pairs = new Map(); // "word base" -> [word, base]
  const common = new Set(); // words with at least one ordinary sense
  const posOf = new Map(); // word types of common words, for the -ly and -ness rule
  return {
    add(entry) {
      if (entry.lang_code !== "en" || !PLAIN_WORD.test(entry.word ?? "")) return;
      const word = entry.word;
      if (entry.senses?.some((s) => s.glosses?.length && !s.tags?.some((t) => UNCOMMON_TAGS.has(t)))) {
        common.add(word);
        if (!known || known.has(word)) posOf.set(word, (posOf.get(word) ?? new Set()).add(entry.pos));
      }
      const base = etymologyBase(entry);
      if (base) pairs.set(`${word} ${base}`, [word, base]);
      for (const d of entry.derived ?? []) {
        if (PLAIN_WORD.test(d.word ?? "")) pairs.set(`${d.word} ${word}`, [d.word, word]);
      }
    },
    // Families that include at least one word of the lexicon, by base word.
    *families(lexiconWords) {
      const lexicon = new Set(lexiconWords);
      // Wiktionary doesn't always link the most regular forms, so an adjective
      // also gets the common words its spelling makes: quick -> quickly (adverb),
      // quickness (noun).
      for (const [base, types] of posOf) {
        if (!types.has("adj") || base.length < 3) continue;
        for (const stem of stems(base)) {
          for (const [suffix, pos] of [["ly", "adv"], ["ally", "adv"], ["ness", "noun"]]) {
            if (posOf.get(stem + suffix)?.has(pos)) pairs.set(`${stem + suffix} ${base}`, [stem + suffix, base]);
          }
        }
      }

      const usable = (w) => common.has(w) && (!known || known.has(w) || lexicon.has(w));
      const valid = [...pairs.values()].filter(([word, base]) =>
        usable(word) && usable(base) && derivesFrom(word, base));
      // Joins pairs into families, so quickly and quickness meet through quick.
      const parent = new Map();
      const find = (w) => {
        while (parent.has(w) && parent.get(w) !== w) w = parent.get(w);
        return w;
      };
      for (const [word, base] of valid) parent.set(find(word), find(base));
      const inFamily = new Set(valid.flat());
      const keep = new Set([...lexicon].filter((w) => inFamily.has(w)).map(find));
      const byBase = Map.groupBy(valid.filter(([word]) => keep.has(find(word))), ([, base]) => base);
      for (const [base, list] of byBase) yield { base, derived: list.map(([word]) => word) };
    },
  };
}

// `common` is an optional set of common English words for the word families.
export async function* buildLexicon(lines, stats = {}, { common } = {}) {
  const byWord = new Map();
  const families = familyCollector(common);
  stats.badLines = 0;
  stats.families = 0;
  for await (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      stats.badLines++;
      continue;
    }
    families.add(entry);
    const converted = convertEntry(entry);
    if (!converted) continue;
    const key = converted.word.toLowerCase();
    const prev = byWord.get(key);
    if (!prev) {
      byWord.set(key, converted);
      continue;
    }
    prev.phonetic ||= converted.phonetic;
    prev.audio ||= converted.audio;
    prev.forms = [...new Set([...prev.forms, ...converted.forms])];
    prev.senses.push(...converted.senses);
  }
  for (const rec of byWord.values()) {
    rec.senses = rec.senses.slice(0, MAX_SENSES);
    yield rec;
  }
  for (const family of families.families(byWord.keys())) {
    stats.families++;
    yield family;
  }
}

export function readLines(stream, gzipped) {
  return createInterface({ input: gzipped ? stream.pipe(createGunzip()) : stream, crlfDelay: Infinity });
}

// Fills the lexicon table from the bundled file on first run, and again only
// when the file has changed.
export async function loadLexicon(db, file = LEXICON_FILE, commonFile = COMMON_WORDS_FILE) {
  if (!existsSync(file)) return db.lexiconSize();
  const hash = (f) => (existsSync(f) ? createHash("sha256").update(readFileSync(f)).digest("hex") : "");
  // Includes the cleanup version, so a file built before a cleanup change is cleaned on load.
  const version = `${hash(file)}:${hash(commonFile)}:${CLEANUP_VERSION}`;
  if (db.lexiconVersion() === version) return db.lexiconSize();

  const records = [];
  const families = [];
  for await (const line of readLines(createReadStream(file), true)) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    if (record.base) families.push(record);
    else records.push({ ...record, senses: cleanSenses(record.senses) });
  }

  // Leaves rare words out of the families, also for files built before the
  // build did this itself.
  if (existsSync(commonFile)) {
    const usable = new Set(records.map((r) => r.word.toLowerCase()));
    for await (const w of readLines(createReadStream(commonFile), true)) usable.add(w.trim());
    for (const f of families) f.derived = usable.has(f.base) ? f.derived.filter((w) => usable.has(w)) : [];
  }
  db.importLexicon(records, version, families);
  return records.length;
}
