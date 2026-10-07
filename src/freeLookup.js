import { tokens } from "./lexicon.js";
import { LookupError } from "./lookup.js";

// The free lookup, used when there is no Claude API key:
// English (word types, definitions, examples, pronunciation) comes from the
// Free Dictionary API, and Persian meanings from the offline lexicon.

const API = "https://api.dictionaryapi.dev/api/v2/entries/en/";
const POS = new Set([
  "noun", "verb", "adjective", "adverb", "pronoun", "preposition",
  "conjunction", "interjection", "determiner", "phrasal verb", "idiom",
]);
const PER_POS = 4;
const MAX_SENSES = 10;

// Returns the Free Dictionary entries, null when the word is unknown, and
// throws when the service can't be reached.
async function fetchEnglish(word, fetchImpl) {
  const res = await fetchImpl(API + encodeURIComponent(word), { signal: AbortSignal.timeout(8000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Free Dictionary API answered ${res.status}`);
  return res.json();
}

function englishSenses(entries) {
  const senses = [];
  for (const meaning of entries.flatMap((e) => e.meanings ?? [])) {
    const pos = POS.has(meaning.partOfSpeech) ? meaning.partOfSpeech : "other";
    for (const d of (meaning.definitions ?? []).slice(0, PER_POS)) {
      if (d.definition) senses.push({ partOfSpeech: pos, persian: [], definition: d.definition, example: d.example ?? "" });
    }
  }
  return senses.slice(0, MAX_SENSES);
}

// A recorded pronunciation, preferring American English.
function audioOf(entries) {
  const urls = entries.flatMap((e) => e.phonetics ?? []).map((p) => p.audio).filter(Boolean)
    .map((url) => (url.startsWith("//") ? `https:${url}` : url));
  return urls.find((u) => /-us\.mp3$/.test(u)) ?? urls[0] ?? "";
}

function phoneticOf(entries) {
  const all = entries.flatMap((e) => [e.phonetic, ...(e.phonetics ?? []).map((p) => p.text)]);
  return all.find((p) => p?.startsWith("/")) ?? all.find(Boolean) ?? "";
}

// Gives each English sense the Persian of the offline sense with the same word
// type whose definition shares the most words with it.
export function addPersian(senses, offlineSenses) {
  for (const sense of senses) {
    const words = tokens(sense.definition);
    let best = null;
    let bestScore = 0;
    for (const o of offlineSenses.filter((x) => x.partOfSpeech === sense.partOfSpeech)) {
      const score = [...tokens(o.definition)].filter((w) => words.has(w)).length;
      if (score > bestScore) [best, bestScore] = [o, score];
    }
    if (best) sense.persian = [...best.persian];
  }
  // A word type that has offline Persian but no matching definition still shows
  // it, on its first sense.
  for (const pos of new Set(offlineSenses.map((o) => o.partOfSpeech))) {
    const ofPos = senses.filter((s) => s.partOfSpeech === pos);
    if (ofPos.length && ofPos.every((s) => !s.persian.length)) {
      ofPos[0].persian = [...offlineSenses.find((o) => o.partOfSpeech === pos).persian];
    }
  }
  return senses;
}

export function createFreeLookup({ db, fetchImpl = fetch }) {
  return async function lookup(input) {
    const offline = db.findInLexicon(input);
    const word = offline?.word ?? input; // "ran" -> "run"

    let entries = null;
    let unreachable = false;
    try {
      entries = await fetchEnglish(word, fetchImpl);
    } catch (err) {
      console.error("Free Dictionary API failed:", err.message);
      unreachable = true;
    }

    const senses = entries ? englishSenses(entries) : [];
    if (senses.length) {
      return {
        word: entries[0].word?.toLowerCase() || word,
        phonetic: phoneticOf(entries) || offline?.phonetic || "",
        audio: audioOf(entries) || offline?.audio || "",
        senses: addPersian(senses, offline?.senses ?? []),
      };
    }
    if (offline) return offline;
    throw new LookupError(unreachable
      ? "Couldn't reach the Free Dictionary, and this word isn't in the offline dictionary. Try again later."
      : `"${input}" isn't in the Free Dictionary or the offline dictionary.`);
  };
}

// Claude gives no audio, so add a recording from the offline dictionary or the
// Free Dictionary API when one exists.
export function withRecording(lookup, { db, fetchImpl = fetch }) {
  return async function lookupWithRecording(input) {
    const entry = await lookup(input);
    let audio = db.findInLexicon(entry.word)?.audio ?? "";
    if (!audio) {
      try {
        audio = audioOf((await fetchEnglish(entry.word, fetchImpl)) ?? []);
      } catch {
        // No recording; the app falls back to the device's voice.
      }
    }
    return { ...entry, audio };
  };
}
