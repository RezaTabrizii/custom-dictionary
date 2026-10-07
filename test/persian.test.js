import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { cleanPersian } from "../src/persian.js";

test("removes vowel marks and the duplicates they hid", () => {
  assert.deepEqual(cleanPersian(["نَامَه", "کِتَاب", "کِتاب", "نامِه"]), ["نامه", "کتاب"]);
  assert.deepEqual(cleanPersian(["اِدارِه کَرْدَن"]), ["اداره کردن"]);
});

test("uses Persian letter forms", () => {
  assert.deepEqual(cleanPersian(["كتاب", "علي"]), ["کتاب", "علی"]);
});

test("saved words are cleaned too", () => {
  const db = openDb();
  const w = db.addWord({ word: "book", phonetic: "", senses: [{ partOfSpeech: "noun", persian: ["کِتَاب", "کتاب"], definition: "", example: "" }] });
  assert.deepEqual(w.senses[0].persian, ["کتاب"]);
});
