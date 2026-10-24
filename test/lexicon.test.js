import { test } from "node:test";
import assert from "node:assert/strict";
import { createReadStream, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { openDb } from "../src/db.js";
import { buildLexicon, loadLexicon, parseExtra, readLines } from "../src/lexicon.js";

const FIXTURE = new URL("./fixtures/kaikki-sample.jsonl", import.meta.url);
const NO_EXTRA = join(tmpdir(), "missing-extra.tsv");
const NO_COMMON = join(tmpdir(), "missing-common.txt.gz");

async function build() {
  const out = [];
  for await (const r of buildLexicon(readLines(createReadStream(FIXTURE), false))) out.push(r);
  return out;
}

test("keeps only English words with Persian, one record per word", async () => {
  const records = await build();
  assert.deepEqual(records.map((r) => r.word), ["run", "bright"]);
});

test("matches Persian translations to the right sense", async () => {
  const [run] = await build();
  assert.equal(run.phonetic, "/ɹʌn/");
  assert.equal(run.audio, "https://upload.wikimedia.org/run-us.mp3");
  assert.deepEqual(run.forms, ["runs", "running", "ran"]);
  assert.deepEqual(run.senses, [
    { partOfSpeech: "verb", persian: ["دویدن"], definition: "To move swiftly on foot.", example: "She runs every morning." },
    { partOfSpeech: "verb", persian: ["اداره کردن", "گرداندن"], definition: "To manage or be in charge of something.", example: "My uncle runs a bakery." },
    { partOfSpeech: "noun", persian: ["دو"], definition: "An act of running.", example: "I went for a run." },
  ]);
});

test("uses translations stored on the sense itself, and drops senses without Persian", async () => {
  const [, bright] = await build();
  assert.equal(bright.phonetic, "/bɹaɪt/");
  assert.deepEqual(bright.senses, [
    { partOfSpeech: "adjective", persian: ["روشن", "درخشان"], definition: "Emitting much light.", example: "" },
  ]);
});

test("fills the database once and finds words offline, including inflected forms", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vazhe-"));
  const file = join(dir, "en-fa.jsonl.gz");
  writeFileSync(file, gzipSync((await build()).map((r) => JSON.stringify(r)).join("\n")));

  const db = openDb();
  db.createUser("reza", "not-a-real-hash");
  db.forUser(1).addWord({ word: "mine", phonetic: "", senses: [] });
  assert.equal(await loadLexicon(db, file, NO_COMMON, NO_EXTRA), 2);
  const version = db.lexiconVersion();
  assert.equal(await loadLexicon(db, file, NO_COMMON, NO_EXTRA), 2); // a restart doesn't re-import
  assert.equal(db.lexiconVersion(), version);

  assert.equal(db.findInLexicon("run").senses.length, 3);
  assert.equal(db.findInLexicon("RAN").word, "run");
  assert.equal(db.findInLexicon("run").audio, "https://upload.wikimedia.org/run-us.mp3");
  assert.equal(db.findInLexicon("bright").senses[0].persian[0], "روشن");
  assert.equal(db.findInLexicon("zyzzyva"), undefined);

  // A changed file replaces the offline data and keeps the user's words.
  writeFileSync(file, gzipSync(JSON.stringify((await build())[1])));
  assert.equal(await loadLexicon(db, file, NO_COMMON, NO_EXTRA), 1);
  assert.equal(db.findInLexicon("run"), undefined);
  assert.equal(db.forUser(1).listWords().length, 1);
});

test("an absent lexicon file leaves the table empty", async () => {
  const db = openDb();
  assert.equal(await loadLexicon(db, join(tmpdir(), "missing.jsonl.gz")), 0);
});

test("adds the extra meanings: new words, missing word types and forms", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vazhe-"));
  const file = join(dir, "en-fa.jsonl.gz");
  const extra = join(dir, "extra.tsv");
  writeFileSync(file, gzipSync((await build()).map((r) => JSON.stringify(r)).join("\n")));
  writeFileSync(extra, [
    "# a comment",
    "keep\tverb\tنگه داشتن، ادامه دادن\tkeeps,kept",
    "keep\tnoun\tخرجی",
    "run\tverb\tچیز دیگری",
    "run\tadjective\tذوب‌شده",
    "running\t=run",
    "ghost\t=nothing",
    "",
  ].join("\n"));

  const db = openDb();
  assert.equal(await loadLexicon(db, file, NO_COMMON, extra), 3);
  assert.deepEqual(db.findInLexicon("kept").senses.map((s) => [s.partOfSpeech, s.persian]),
    [["verb", ["نگه داشتن", "ادامه دادن"]], ["noun", ["خرجی"]]]);
  // A word type the lexicon has already keeps its own meanings.
  const run = db.findInLexicon("running");
  assert.equal(run.word, "run");
  assert.equal(run.senses.filter((s) => s.persian.includes("چیز دیگری")).length, 0);
  assert.equal(run.senses.at(-1).partOfSpeech, "adjective");
  assert.equal(db.findInLexicon("ghost"), undefined);

  // Changing the extra file loads the lexicon again.
  writeFileSync(extra, "keep\tverb\tنگه داشتن\n");
  await loadLexicon(db, file, NO_COMMON, extra);
  assert.equal(db.findInLexicon("kept"), undefined);
  assert.deepEqual(db.findInLexicon("keep").senses[0].persian, ["نگه داشتن"]);
});

test("the bundled extra meanings use known word types and forms of real words", async () => {
  const { records, forms } = parseExtra(readFileSync(new URL("../lexicon/claude-fa.tsv", import.meta.url), "utf8"));
  const types = new Set(["noun", "verb", "adjective", "adverb", "pronoun", "preposition", "conjunction",
    "interjection", "determiner", "phrasal verb", "idiom", "other"]);
  for (const [word, r] of records) {
    for (const s of r.senses) assert.ok(types.has(s.partOfSpeech), `${word}: ${s.partOfSpeech}`);
  }
  assert.ok(records.size > 500);
  assert.ok(forms.every(([form, word]) => form && word));
});

test("the extra file corrects the lexicon: removals, replaced word types and appended meanings", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vazhe-"));
  const file = join(dir, "en-fa.jsonl.gz");
  const extra = join(dir, "extra.tsv");
  writeFileSync(file, gzipSync((await build()).map((r) => JSON.stringify(r)).join("\n")));
  writeFileSync(extra, [
    "*\t-\tگرداندن",
    "run\t-\tدویدن",
    "run\t+verb\tدو کردن",
    "bright\t!adjective\tروشن، تابناک",
    "bright\t!adjective\tباهوش",
  ].join("\n"));

  const db = openDb();
  await loadLexicon(db, file, NO_COMMON, extra);
  const run = db.findInLexicon("run").senses.map((s) => s.persian);
  assert.ok(!run.flat().includes("دویدن") && !run.flat().includes("گرداندن"));
  assert.ok(run.flat().includes("اداره کردن"));
  assert.deepEqual(run.at(-1), ["دو کردن"]);
  assert.deepEqual(db.findInLexicon("bright").senses.map((s) => s.persian), [["روشن", "تابناک"], ["باهوش"]]);
});

test("saved words get the same corrections once, and keep what the person wrote", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vazhe-"));
  const file = join(dir, "en-fa.jsonl.gz");
  const extra = join(dir, "extra.tsv");
  writeFileSync(file, gzipSync((await build()).map((r) => JSON.stringify(r)).join("\n")));
  writeFileSync(extra, "run\t-\tدویدن\nbright\t!adjective\tروشن، تابناک\n");

  const db = openDb();
  const words = db.forUser(db.createUser("reza", "not-a-real-hash"));
  const sense = (partOfSpeech, persian) => ({ partOfSpeech, persian, definition: "", example: "" });
  words.addWord({ word: "run", phonetic: "", senses: [sense("verb", ["دویدن", "تاختن"]), sense("noun", ["دو"])] });
  words.addWord({ word: "bright", phonetic: "", senses: [sense("adjective", ["درخشان"]), sense("adjective", ["زرنگ"])] });
  await loadLexicon(db, file, NO_COMMON, extra);

  const saved = new Map(words.listWords().map((w) => [w.word, w.senses.map((s) => s.persian)]));
  assert.deepEqual(saved.get("run"), [["تاختن"], ["دو"]]);
  // The replaced meaning makes way for the correction; the person's own one stays.
  assert.deepEqual(saved.get("bright"), [["روشن", "تابناک"], ["زرنگ"]]);

  // Once per version of the file: a meaning the person adds back stays.
  words.addWord({ word: "walk", phonetic: "", senses: [sense("verb", ["دویدن"])] });
  writeFileSync(file, gzipSync((await build()).map((r) => JSON.stringify(r)).join("\n") + "\n"));
  await loadLexicon(db, file, NO_COMMON, extra);
  assert.deepEqual(words.listWords().find((w) => w.word === "walk").senses[0].persian, ["دویدن"]);
});
