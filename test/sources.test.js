import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createFreeDictionary, createMerriamWebster, createWiktionary, mwText, partOfSpeech } from "../src/sources.js";

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

// A fetch that answers every request with the given status and body, and records the URLs.
function fakeFetch(status, body) {
  const urls = [];
  const fetchImpl = async (url, opts) => {
    urls.push({ url, opts });
    return { ok: status >= 200 && status < 300, status, text: async () => body };
  };
  return { fetchImpl, urls };
}

test("Merriam-Webster: definitions, examples, word types, IPA and audio", async () => {
  const { fetchImpl, urls } = fakeFetch(200, fixture("merriam-webster-run.json"));
  const entry = await createMerriamWebster({ key: "k3y", fetchImpl })("run");
  assert.equal(urls[0].url, "https://www.dictionaryapi.com/api/v3/references/learners/json/run?key=k3y");
  assert.equal(entry.word, "run");
  assert.equal(entry.phonetic, "/ˈrʌn/");
  assert.equal(entry.audio, "https://media.merriam-webster.com/audio/prons/en/us/mp3/r/run00001.mp3");
  assert.deepEqual(entry.senses, [
    { partOfSpeech: "verb", persian: [], definition: "to move with your legs at a speed that is faster than walking", example: "Can your little sister run yet?" },
    { partOfSpeech: "verb", persian: [], definition: "to direct the business or activities of (someone or something): manage", example: "She runs a small bakery." },
    { partOfSpeech: "verb", persian: [], definition: "used to say that a machine is working", example: "" },
    { partOfSpeech: "verb", persian: [], definition: "to go somewhere quickly", example: "" },
    { partOfSpeech: "noun", persian: [], definition: "an act of running", example: "I go for a run every morning." },
  ]);
});

test("Merriam-Webster: an inflected form finds its base entry", async () => {
  const { fetchImpl } = fakeFetch(200, fixture("merriam-webster-run.json"));
  const entry = await createMerriamWebster({ key: "k", fetchImpl })("ran");
  assert.equal(entry.word, "run");
  assert.equal(entry.senses.length, 5);
});

test("Merriam-Webster: a run-on word (\"quickly\" under \"quick\") is left to the next source", async () => {
  const quick = [{ meta: { id: "quick", stems: ["quick", "quicker", "quickly", "quickness"] }, fl: "adjective",
    uros: [{ ure: "quick*ly", fl: "adverb" }, { ure: "quick*ness", fl: "noun" }],
    def: [{ sseq: [[["sense", { dt: [["text", "{bc}fast"]] }]]] }] }];
  const { fetchImpl } = fakeFetch(200, JSON.stringify(quick));
  const mw = createMerriamWebster({ key: "k", fetchImpl });
  assert.equal(await mw("quickly"), null);
  assert.equal((await mw("quicker")).word, "quick"); // an inflection still finds its base
});

test("Merriam-Webster: an unknown word (spelling suggestions) is not found", async () => {
  const { fetchImpl } = fakeFetch(200, '["rum","ruin","rune"]');
  assert.equal(await createMerriamWebster({ key: "k", fetchImpl })("runx"), null);
  const empty = fakeFetch(200, "[]");
  assert.equal(await createMerriamWebster({ key: "k", fetchImpl: empty.fetchImpl })("qwzx"), null);
});

test("Merriam-Webster: a wrong key is reported as an error", async () => {
  const { fetchImpl } = fakeFetch(200, "Invalid API key. Not subscribed for this reference.");
  await assert.rejects(createMerriamWebster({ key: "bad", fetchImpl })("run"), /Invalid API key/);
});

test("Merriam-Webster markup becomes plain text", () => {
  assert.equal(mwText("{bc}a {it}word{/it} {ldquo}here{rdquo} {a_link|link} {d_link|other|other:1}"), "a word “here” link other");
});

test("Merriam-Webster audio folders follow its rules", async () => {
  for (const [file, dir] of [["bixabc01", "bix"], ["ggabc01", "gg"], ["3d000001", "number"], ["_abc01", "number"], ["apple001", "a"]]) {
    const body = JSON.stringify([{ meta: { id: "x", stems: ["x"] }, hwi: { prs: [{ ipa: "x", sound: { audio: file } }] }, fl: "noun", shortdef: ["x"] }]);
    const { fetchImpl } = fakeFetch(200, body);
    const entry = await createMerriamWebster({ key: "k", fetchImpl })("x");
    assert.equal(entry.audio, `https://media.merriam-webster.com/audio/prons/en/us/mp3/${dir}/${file}.mp3`);
  }
});

test("Wiktionary: English definitions without HTML, with examples", async () => {
  const { fetchImpl, urls } = fakeFetch(200, fixture("wiktionary-run.json"));
  const entry = await createWiktionary({ fetchImpl })("run");
  assert.equal(urls[0].url, "https://en.wiktionary.org/api/rest_v1/page/definition/run");
  assert.match(urls[0].opts.headers["user-agent"], /Vazhe/);
  assert.deepEqual(entry.senses, [
    { partOfSpeech: "verb", persian: [], definition: "To move swiftly on foot & fast.", example: "I ran home." },
    { partOfSpeech: "noun", persian: [], definition: "Act or instance of running.", example: "" },
  ]);
});

test("Wiktionary: a missing page or no English section is not found", async () => {
  assert.equal(await createWiktionary({ fetchImpl: fakeFetch(404, "").fetchImpl })("qwzx"), null);
  assert.equal(await createWiktionary({ fetchImpl: fakeFetch(200, '{"fr":[]}').fetchImpl })("rhum"), null);
});

test("Free Dictionary: server errors are reported, 404 is not found", async () => {
  await assert.rejects(createFreeDictionary({ fetchImpl: fakeFetch(500, "").fetchImpl })("run"), /HTTP 500/);
  assert.equal(await createFreeDictionary({ fetchImpl: fakeFetch(404, "").fetchImpl })("qwzx"), null);
});

test("word types are recognised, including the ones that contain another", () => {
  assert.equal(partOfSpeech("adverb"), "adverb");
  assert.equal(partOfSpeech("pronoun"), "pronoun");
  assert.equal(partOfSpeech("Verb"), "verb");
  assert.equal(partOfSpeech("phrasal verb"), "phrasal verb");
  assert.equal(partOfSpeech("noun, plural"), "noun");
  assert.equal(partOfSpeech("abbreviation"), "other");
});

test("at most 4 meanings per word type", async () => {
  const defs = Array.from({ length: 7 }, (_, i) => ({ definition: `meaning ${i}` }));
  const body = JSON.stringify([{ word: "set", meanings: [{ partOfSpeech: "verb", definitions: defs }, { partOfSpeech: "noun", definitions: defs }] }]);
  const entry = await createFreeDictionary({ fetchImpl: fakeFetch(200, body).fetchImpl })("set");
  assert.equal(entry.senses.filter((s) => s.partOfSpeech === "verb").length, 4);
  assert.equal(entry.senses.filter((s) => s.partOfSpeech === "noun").length, 4);
});
