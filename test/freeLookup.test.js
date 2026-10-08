import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { addPersian, createFreeLookup, englishSources, withRecording } from "../src/freeLookup.js";
import { LookupError } from "../src/lookup.js";

// Offline lexicon records, as built from kaikki.org data.
const OFFLINE = [
  {
    word: "run", phonetic: "/ɹʌn/", audio: "", forms: ["ran", "runs"], senses: [
      { partOfSpeech: "verb", persian: ["دویدن"], definition: "To move swiftly on foot.", example: "" },
      { partOfSpeech: "verb", persian: ["اداره کردن"], definition: "To manage or be in charge of something.", example: "" },
      { partOfSpeech: "noun", persian: ["دو"], definition: "An act of running.", example: "" },
    ],
  },
  {
    word: "bright", phonetic: "/bɹaɪt/", audio: "https://upload.wikimedia.org/bright.mp3", forms: [], senses: [
      { partOfSpeech: "adjective", persian: ["روشن"], definition: "Emitting much light.", example: "" },
    ],
  },
];

const RUN = {
  word: "run", phonetic: "/ˈrʌn/", audio: "https://media.merriam-webster.com/run.mp3", senses: [
    { partOfSpeech: "verb", persian: [], definition: "to move with your legs at a speed that is faster than walking", example: "He ran home." },
    { partOfSpeech: "verb", persian: [], definition: "to direct the business of (something): manage", example: "She runs a bakery." },
    { partOfSpeech: "noun", persian: [], definition: "an act of running", example: "" },
  ],
};
const ZEBRA = { word: "zebra", phonetic: "", audio: "", senses: [{ partOfSpeech: "noun", persian: [], definition: "A striped horse.", example: "" }] };

// A source that knows some words, or is down.
function source(name, known, { down = false } = {}) {
  const asked = [];
  return {
    name,
    asked,
    lookup: async (word) => {
      asked.push(word);
      if (down) throw new Error("fetch failed");
      return known[word] ? structuredClone(known[word]) : null;
    },
  };
}

function setup(sources) {
  const db = openDb();
  db.importLexicon(OFFLINE, "test");
  return { db, lookup: createFreeLookup({ db, sources }) };
}

test("English from the first source, Persian from the offline dictionary", async () => {
  const mw = source("Merriam-Webster", { run: RUN });
  const { lookup } = setup([mw]);
  const entry = await lookup("ran");
  assert.deepEqual(mw.asked, ["run"]); // an inflected form is looked up by its base word
  assert.equal(entry.audio, RUN.audio);
  assert.deepEqual(entry.senses.map((s) => s.persian), [["دویدن"], ["اداره کردن"], ["دو"]]);
});

test("the next source is used when one is down or doesn't know the word", async () => {
  const mw = source("Merriam-Webster", {}, { down: true });
  const free = source("Free Dictionary", {});
  const wiki = source("Wiktionary", { zebra: ZEBRA });
  const { lookup } = setup([mw, free, wiki]);
  const entry = await lookup("zebra");
  assert.deepEqual([mw.asked, free.asked, wiki.asked], [["zebra"], ["zebra"], ["zebra"]]);
  assert.equal(entry.senses[0].definition, "A striped horse.");
  assert.deepEqual(entry.senses[0].persian, []); // not in the offline dictionary
});

test("later sources aren't asked once one has the word", async () => {
  const mw = source("Merriam-Webster", { run: RUN });
  const wiki = source("Wiktionary", { run: RUN });
  await setup([mw, wiki]).lookup("run");
  assert.deepEqual(wiki.asked, []);
});

test("the offline dictionary is used when no online source has the word", async () => {
  const { lookup } = setup([source("A", {}), source("B", {}, { down: true })]);
  const entry = await lookup("bright");
  assert.equal(entry.senses[0].definition, "Emitting much light.");
  assert.deepEqual(entry.senses[0].persian, ["روشن"]);
});

test("a word nobody knows is reported, with the reason", async () => {
  await assert.rejects(setup([source("A", {})]).lookup("qwzx"), (err) => err instanceof LookupError && /wasn't found/.test(err.message));
  await assert.rejects(setup([source("A", {}, { down: true })]).lookup("qwzx"), /Couldn't reach/);
});

test("sources are in the requested order, Merriam-Webster only with a key", () => {
  assert.deepEqual(englishSources().map((s) => s.name), ["Free Dictionary", "Wiktionary"]);
  assert.deepEqual(englishSources({ merriamWebsterKey: "k" }).map((s) => s.name), ["Merriam-Webster", "Free Dictionary", "Wiktionary"]);
});

test("adds a recording to Claude's answers, from the offline data or the first source that has one", async () => {
  const db = openDb();
  db.importLexicon(OFFLINE, "test");
  const claude = async (word) => ({ word, phonetic: "", senses: [] });
  const sources = [source("A", {}, { down: true }), source("B", { run: RUN })];
  const lookup = withRecording(claude, { db, sources });
  assert.equal((await lookup("bright")).audio, "https://upload.wikimedia.org/bright.mp3");
  assert.equal((await lookup("run")).audio, RUN.audio);
  assert.equal((await lookup("qwzx")).audio, "");
});

test("offline Persian that matches no definition goes to senses still without Persian", () => {
  const offline = [
    { partOfSpeech: "verb", persian: ["دویدن"], definition: "To move swiftly on foot.", example: "" },
    { partOfSpeech: "verb", persian: ["اداره کردن"], definition: "To manage a business.", example: "" },
    { partOfSpeech: "verb", persian: ["جاری شدن"], definition: "Of a liquid, to flow.", example: "" },
  ];
  const senses = [
    { partOfSpeech: "verb", persian: [], definition: "to go faster than a walk", example: "" },
    { partOfSpeech: "verb", persian: [], definition: "to move swiftly", example: "" },
    { partOfSpeech: "noun", persian: [], definition: "an act of running", example: "" },
  ];
  // The second sense matches "دویدن"; the first gets the first unused verb meaning.
  // Nouns have no offline Persian, so they stay empty.
  assert.deepEqual(addPersian(senses, offline).map((s) => s.persian), [["اداره کردن"], ["دویدن"], []]);
});
