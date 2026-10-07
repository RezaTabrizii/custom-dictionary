import { test } from "node:test";
import assert from "node:assert/strict";
import { createReadStream, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { openDb } from "../src/db.js";
import { buildLexicon, createOfflineLookup, loadLexicon, readLines } from "../src/lexicon.js";
import { LookupError } from "../src/lookup.js";

const FIXTURE = new URL("./fixtures/kaikki-sample.jsonl", import.meta.url);

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

test("fills the database once and looks words up offline, including inflected forms", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vazhe-"));
  const file = join(dir, "en-fa.jsonl.gz");
  writeFileSync(file, gzipSync((await build()).map((r) => JSON.stringify(r)).join("\n")));

  const db = openDb();
  db.addWord({ word: "mine", phonetic: "", senses: [] });
  assert.equal(await loadLexicon(db, file), 2);
  const version = db.lexiconVersion();
  assert.equal(await loadLexicon(db, file), 2); // a restart doesn't re-import
  assert.equal(db.lexiconVersion(), version);

  const lookup = createOfflineLookup(db);
  assert.equal((await lookup("run")).senses.length, 3);
  assert.equal((await lookup("RAN")).word, "run");
  assert.equal((await lookup("bright")).senses[0].persian[0], "روشن");
  await assert.rejects(lookup("zyzzyva"), LookupError);

  // A changed file replaces the offline data and keeps the user's words.
  writeFileSync(file, gzipSync(JSON.stringify((await build())[1])));
  assert.equal(await loadLexicon(db, file), 1);
  await assert.rejects(lookup("run"), LookupError);
  assert.equal(db.listWords().length, 1);
});

test("an absent lexicon file leaves the table empty", async () => {
  const db = openDb();
  assert.equal(await loadLexicon(db, join(tmpdir(), "missing.jsonl.gz")), 0);
});
