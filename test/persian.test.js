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
  const w = db.forUser(db.createUser("reza", "not-a-real-hash")).addWord({ word: "book", phonetic: "", senses: [{ partOfSpeech: "noun", persian: ["کِتَاب", "کتاب"], definition: "", example: "" }] });
  assert.deepEqual(w.senses[0].persian, ["کتاب"]);
});

test("puts back the half-spaces the offline lexicon lost", () => {
  assert.deepEqual(cleanPersian(["خواهش میکنم", "رئیسجمهور", "بینٱلمللی"]), ["خواهش می‌کنم", "رئیس‌جمهور", "بین‌المللی"]);
  // Words that only look like they need one are left alone.
  assert.deepEqual(cleanPersian(["میز", "میهمان", "تنها"]), ["میز", "میهمان", "تنها"]);
});
