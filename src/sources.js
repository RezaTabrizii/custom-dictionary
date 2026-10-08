// Online sources of English definitions, used when there is no Claude API key.
// Each takes a word and resolves to { word, phonetic, audio, senses } with empty
// Persian, or to null when it doesn't know the word. It throws when the service
// can't be reached or answers with an error.

// Longer names first, since "adverb" contains "verb" and "pronoun" contains "noun".
const POS = [
  "phrasal verb", "adverb", "adjective", "pronoun", "preposition", "conjunction",
  "interjection", "determiner", "idiom", "noun", "verb",
];
const PER_POS = 4;
const MAX_SENSES = 10;
const TIMEOUT_MS = 8000;

export const partOfSpeech = (label = "") => POS.find((p) => label.toLowerCase().includes(p)) ?? "other";

function limitSenses(senses) {
  const perPos = new Map();
  return senses
    .filter((s) => {
      const n = (perPos.get(s.partOfSpeech) ?? 0) + 1;
      perPos.set(s.partOfSpeech, n);
      return n <= PER_POS;
    })
    .slice(0, MAX_SENSES);
}

async function getJson(url, fetchImpl, headers = {}) {
  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(text.slice(0, 120).trim() || "not JSON"); // e.g. "Invalid API key"
  }
}

/* ---------- Merriam-Webster Learner's ---------- */

// Turns Merriam-Webster's inline markup ({bc}, {it}…{/it}, {sx|word||} …) into plain text.
export function mwText(s = "") {
  return s
    .replace(/\{dx\}.*?\{\/dx\}/g, "")
    .replace(/\{(?:sx|a_link|d_link|i_link|et_link|dxt)\|([^|}]*)[^}]*\}/g, "$1")
    .replace(/\{ldquo\}/g, "“").replace(/\{rdquo\}/g, "”")
    .replace(/^\s*\{bc\}/, "")
    .replace(/\{bc\}/g, ": ")
    .replace(/\{[^}]*\}/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .trim();
}

function mwAudioUrl(file) {
  const dir = file.startsWith("bix") ? "bix"
    : file.startsWith("gg") ? "gg"
    : /^[^a-z]/i.test(file) ? "number"
    : file[0];
  return `https://media.merriam-webster.com/audio/prons/en/us/mp3/${dir}/${file}.mp3`;
}

// All "sense" objects in a def's sseq, including those inside "bs" (binding sense).
function* mwSenses(def) {
  for (const seq of def.sseq ?? []) {
    for (const [kind, body] of seq) {
      if (kind === "sense") yield body;
      else if (kind === "bs" && body?.sense) yield body.sense;
      else if (kind === "pseq") for (const [k, b] of body) if (k === "sense") yield b;
    }
  }
}

function mwDefinition(sense) {
  let definition = "";
  let example = "";
  for (const [kind, value] of sense.dt ?? []) {
    if (kind === "text" && !definition) definition = mwText(value);
    if (kind === "vis" && !example) example = mwText(value[0]?.t);
    if (kind === "uns" && !definition) {
      // Usage notes ("used to say …") stand in for a definition.
      definition = mwText(value.flat().find((x) => x[0] === "text")?.[1]);
    }
  }
  return { definition, example };
}

export function createMerriamWebster({ key, fetchImpl = fetch }) {
  return async function merriamWebster(word) {
    const url = `https://www.dictionaryapi.com/api/v3/references/learners/json/${encodeURIComponent(word)}?key=${encodeURIComponent(key)}`;
    const data = await getJson(url, fetchImpl);
    // An unknown word returns a list of spelling suggestions (strings).
    if (!Array.isArray(data) || typeof data[0] !== "object") return null;

    const wanted = word.toLowerCase();
    const headword = (e) => e.meta?.id?.split(":")[0].toLowerCase();
    let entries = data.filter((e) => headword(e) === wanted);
    if (!entries.length) {
      // An inflected form ("ran") is listed in the base entry's stems.
      const base = data.find((e) => e.meta?.stems?.some((s) => s.toLowerCase() === wanted));
      if (!base) return null;
      // A run-on word ("quickly" under "quick") is a word of its own, which
      // this entry doesn't define; the next source will.
      const runOn = (e) => e.uros?.some((u) => u.ure?.replace(/\*/g, "").toLowerCase() === wanted);
      if (data.some(runOn)) return null;
      entries = data.filter((e) => headword(e) === headword(base));
    }

    const senses = [];
    for (const entry of entries) {
      const pos = partOfSpeech(entry.fl);
      for (const def of entry.def ?? []) {
        for (const sense of mwSenses(def)) {
          const { definition, example } = mwDefinition(sense);
          if (definition) senses.push({ partOfSpeech: pos, persian: [], definition, example });
        }
      }
      if (!entry.def?.length) {
        for (const d of entry.shortdef ?? []) senses.push({ partOfSpeech: pos, persian: [], definition: d, example: "" });
      }
    }
    if (!senses.length) return null;

    const pron = entries.flatMap((e) => e.hwi?.prs ?? []).find((p) => p.ipa || p.sound?.audio);
    return {
      word: headword(entries[0]),
      phonetic: pron?.ipa ? `/${pron.ipa}/` : "",
      audio: pron?.sound?.audio ? mwAudioUrl(pron.sound.audio) : "",
      senses: limitSenses(senses),
    };
  };
}

/* ---------- Free Dictionary API ---------- */

export function createFreeDictionary({ fetchImpl = fetch } = {}) {
  return async function freeDictionary(word) {
    const entries = await getJson(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`, fetchImpl);
    if (!Array.isArray(entries)) return null;

    const senses = [];
    for (const meaning of entries.flatMap((e) => e.meanings ?? [])) {
      for (const d of meaning.definitions ?? []) {
        if (d.definition) senses.push({ partOfSpeech: partOfSpeech(meaning.partOfSpeech), persian: [], definition: d.definition, example: d.example ?? "" });
      }
    }
    if (!senses.length) return null;

    const phonetics = entries.flatMap((e) => [{ text: e.phonetic }, ...(e.phonetics ?? [])]);
    const texts = phonetics.map((p) => p.text).filter(Boolean);
    const audios = phonetics.map((p) => p.audio).filter(Boolean).map((u) => (u.startsWith("//") ? `https:${u}` : u));
    return {
      word: entries[0].word?.toLowerCase() || word,
      phonetic: texts.find((t) => t.startsWith("/")) ?? texts[0] ?? "",
      audio: audios.find((u) => /-us\.mp3$/.test(u)) ?? audios[0] ?? "",
      senses: limitSenses(senses),
    };
  };
}

/* ---------- Wiktionary (Wikimedia REST API) ---------- */

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };

export function htmlText(html = "") {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e) => ENTITIES[e])
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}

export function createWiktionary({ fetchImpl = fetch } = {}) {
  return async function wiktionary(word) {
    const data = await getJson(
      `https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(word)}`,
      fetchImpl,
      // Wikimedia asks API clients to identify themselves.
      { "user-agent": "Vazhe/1.0 (personal English-Persian dictionary)" },
    );
    const english = data?.en ?? [];

    const senses = [];
    for (const group of english) {
      for (const d of group.definitions ?? []) {
        const definition = htmlText(d.definition);
        if (!definition) continue;
        const example = htmlText(d.parsedExamples?.[0]?.example ?? d.examples?.[0] ?? "");
        senses.push({ partOfSpeech: partOfSpeech(group.partOfSpeech), persian: [], definition, example });
      }
    }
    if (!senses.length) return null;
    return { word, phonetic: "", audio: "", senses: limitSenses(senses) };
  };
}
