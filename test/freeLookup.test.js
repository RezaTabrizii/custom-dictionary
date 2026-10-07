import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { createFreeLookup } from "../src/freeLookup.js";
import { LookupError } from "../src/lookup.js";

// Offline lexicon records, as built from kaikki.org data.
const OFFLINE = [
  {
    word: "run", phonetic: "/ɹʌn/", forms: ["ran", "runs"], senses: [
      { partOfSpeech: "verb", persian: ["دویدن"], definition: "To move swiftly on foot.", example: "" },
      { partOfSpeech: "verb", persian: ["اداره کردن"], definition: "To manage or be in charge of something.", example: "" },
      { partOfSpeech: "noun", persian: ["دو"], definition: "An act of running.", example: "" },
    ],
  },
  {
    word: "bright", phonetic: "/bɹaɪt/", forms: [], senses: [
      { partOfSpeech: "adjective", persian: ["روشن"], definition: "Emitting much light.", example: "" },
    ],
  },
];

// Free Dictionary API response shape.
const FREE_DICT = {
  run: [{
    word: "run",
    phonetic: "/ɹʌn/",
    phonetics: [{ text: "/ɹʌn/", audio: "" }],
    meanings: [
      { partOfSpeech: "verb", definitions: [
        { definition: "To move swiftly on foot so that both feet leave the ground.", example: "I run every day." },
        { definition: "To be in charge of; to manage.", example: "She runs a shop." },
      ] },
      { partOfSpeech: "noun", definitions: [{ definition: "Act or instance of running." }] },
    ],
  }],
  zebra: [{
    word: "zebra",
    phonetics: [{ text: "/ˈzɛbɹə/" }],
    meanings: [{ partOfSpeech: "noun", definitions: [{ definition: "An African wild horse with black and white stripes." }] }],
  }],
};

function setup({ down = false } = {}) {
  const db = openDb();
  db.importLexicon(OFFLINE, "test");
  const asked = [];
  const fetchImpl = async (url) => {
    const word = decodeURIComponent(url.split("/").pop());
    asked.push(word);
    if (down) throw new TypeError("fetch failed");
    const body = FREE_DICT[word];
    return body
      ? { ok: true, status: 200, json: async () => body }
      : { ok: false, status: 404, json: async () => ({ title: "No Definitions Found" }) };
  };
  return { lookup: createFreeLookup({ db, fetchImpl }), asked };
}

test("English from Free Dictionary, Persian from the offline dictionary", async () => {
  const { lookup, asked } = setup();
  const entry = await lookup("ran");
  assert.deepEqual(asked, ["run"]); // an inflected form is looked up by its base word
  assert.equal(entry.word, "run");
  assert.equal(entry.phonetic, "/ɹʌn/");
  assert.deepEqual(entry.senses, [
    { partOfSpeech: "verb", persian: ["دویدن"], definition: "To move swiftly on foot so that both feet leave the ground.", example: "I run every day." },
    { partOfSpeech: "verb", persian: ["اداره کردن"], definition: "To be in charge of; to manage.", example: "She runs a shop." },
    { partOfSpeech: "noun", persian: ["دو"], definition: "Act or instance of running.", example: "" },
  ]);
});

test("a word missing from the offline dictionary is saved with English only", async () => {
  const { lookup } = setup();
  const entry = await lookup("zebra");
  assert.equal(entry.phonetic, "/ˈzɛbɹə/");
  assert.deepEqual(entry.senses[0].persian, []);
});

test("falls back to the offline dictionary when Free Dictionary has no entry", async () => {
  const { lookup } = setup();
  const entry = await lookup("bright");
  assert.equal(entry.senses[0].definition, "Emitting much light.");
  assert.deepEqual(entry.senses[0].persian, ["روشن"]);
});

test("falls back to the offline dictionary when Free Dictionary is unreachable", async () => {
  const { lookup } = setup({ down: true });
  assert.equal((await lookup("run")).senses.length, 3);
  await assert.rejects(lookup("zebra"), /Couldn't reach/);
});

test("reports a word neither source knows", async () => {
  const { lookup } = setup();
  await assert.rejects(lookup("qwzx"), LookupError);
});
