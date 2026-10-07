import { tokens } from "./lexicon.js";
import { LookupError } from "./lookup.js";
import { createFreeDictionary, createMerriamWebster, createWiktionary } from "./sources.js";

// The free lookup, used when there is no Claude API key: English (word types,
// definitions, examples, pronunciation) comes from the first online source that
// knows the word, and Persian meanings from the offline lexicon.

// In order: Merriam-Webster Learner's (when its key is set), the Free
// Dictionary API, then Wiktionary.
export function englishSources({ merriamWebsterKey = "", fetchImpl = fetch } = {}) {
  return [
    ...(merriamWebsterKey ? [{ name: "Merriam-Webster", lookup: createMerriamWebster({ key: merriamWebsterKey, fetchImpl }) }] : []),
    { name: "Free Dictionary", lookup: createFreeDictionary({ fetchImpl }) },
    { name: "Wiktionary", lookup: createWiktionary({ fetchImpl }) },
  ];
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

export function createFreeLookup({ db, sources = englishSources() }) {
  return async function lookup(input) {
    const offline = db.findInLexicon(input);
    const word = offline?.word ?? input; // "ran" -> "run"

    let unreachable = 0;
    for (const source of sources) {
      let english;
      try {
        english = await source.lookup(word);
      } catch (err) {
        console.error(`${source.name} failed for "${word}": ${err.message}`);
        unreachable++;
        continue;
      }
      if (!english) continue;
      return {
        word: english.word || word,
        phonetic: english.phonetic || offline?.phonetic || "",
        audio: english.audio || offline?.audio || "",
        senses: addPersian(english.senses, offline?.senses ?? []),
      };
    }

    if (offline) return offline;
    throw new LookupError(unreachable === sources.length
      ? "Couldn't reach any online dictionary, and this word isn't in the offline dictionary. Try again later."
      : `"${input}" wasn't found in any dictionary.`);
  };
}

// Claude gives no audio, so add a recording from the offline dictionary or the
// first online source that has one.
export function withRecording(lookup, { db, sources = englishSources() }) {
  return async function lookupWithRecording(input) {
    const entry = await lookup(input);
    let audio = db.findInLexicon(entry.word)?.audio ?? "";
    for (const source of sources) {
      if (audio) break;
      try {
        audio = (await source.lookup(entry.word))?.audio ?? "";
      } catch {
        // Try the next one; without any, the app uses the device's voice.
      }
    }
    return { ...entry, audio };
  };
}
