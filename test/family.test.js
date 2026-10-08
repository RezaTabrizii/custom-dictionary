import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { openDb } from "../src/db.js";
import { buildLexicon, derivesFrom } from "../src/lexicon.js";

// Minimal kaikki.org entries: "quick" has Persian; its relatives may not.
const sense = (gloss, extra = {}) => ({ glosses: [gloss], ...extra });
const fa = (word) => [{ lang: "Persian", code: "fa", word, sense: "" }];
const ENTRIES = [
  { word: "quick", pos: "adj", senses: [sense("Moving fast.")], translations: fa("تند"),
    derived: [{ word: "quickly" }, { word: "quickness" }, { word: "quicksand" }, { word: "quickie" }, { word: "quick-witted" }] },
  { word: "quickly", pos: "adv", senses: [sense("Rapidly.")], translations: fa("به سرعت"),
    etymology_templates: [{ name: "surf", args: { 1: "en", 2: "quick", 3: "-ly" } }] },
  { word: "quickness", pos: "noun", senses: [sense("The quality of being quick.")] },
  { word: "quicken", pos: "verb", senses: [sense("To make quicker.")],
    etymology_templates: [{ name: "suffix", args: { 1: "en", 2: "quick", 3: "en" } }] },
  { word: "quicker", pos: "adj", senses: [sense("comparative of quick", { tags: ["form-of"] })] },
  { word: "quicksand", pos: "noun", senses: [sense("Wet sand.")] },
  { word: "quickie", pos: "noun", senses: [sense("Something done quickly.", { tags: ["slang"] })] },
  { word: "quickish", pos: "adj", senses: [sense("Somewhat quick.")],
    etymology_templates: [{ name: "suffix", args: { 1: "en", 2: "quick", 3: "ish" } }] },
  { word: "unquick", pos: "adj", senses: [sense("Not quick.")],
    etymology_templates: [{ name: "prefix", args: { 1: "en", 2: "un", 3: "quick" } }] },
  // A family with no word that has Persian is left out.
  { word: "zorb", pos: "noun", senses: [sense("A ball.")], derived: [{ word: "zorbing" }] },
  { word: "zorbness", pos: "noun", senses: [sense("Zorb quality.")],
    etymology_templates: [{ name: "suffix", args: { 1: "en", 2: "zorb", 3: "ness" } }] },
].map((e) => JSON.stringify({ lang_code: "en", ...e }));

async function build() {
  const out = [];
  for await (const r of buildLexicon(ENTRIES)) out.push(r);
  return out;
}

test("suffix forms are recognised with their spelling changes", () => {
  assert.ok(derivesFrom("happiness", "happy"));
  assert.ok(derivesFrom("teacher", "teach"));
  assert.ok(derivesFrom("runner", "run"));
  assert.ok(derivesFrom("creation", "create"));
  assert.ok(derivesFrom("gently", "gentle"));
  assert.ok(!derivesFrom("quicksand", "quick")); // a compound
  assert.ok(!derivesFrom("unhappy", "happy")); // a prefix
  assert.ok(!derivesFrom("quickish", "quick")); // not a listed suffix
});

test("families come from etymologies and derived terms, without compounds, rare words or inflections", async () => {
  const records = await build();
  assert.deepEqual(records.filter((r) => r.word).map((r) => r.word), ["quick", "quickly"]);
  assert.deepEqual(records.filter((r) => r.base), [{ base: "quick", derived: ["quickly", "quickness", "quicken"] }]);
});

test("a family is found from any of its words, nearest first", async () => {
  const records = await build();
  const db = openDb();
  db.importLexicon(records.filter((r) => r.word), "test", records.filter((r) => r.base));
  assert.deepEqual(db.wordFamily("quick"), { name: "quick", members: ["quicken", "quickly", "quickness"] });
  assert.deepEqual(db.wordFamily("Quickly"), { name: "quick", members: ["quick", "quicken", "quickness"] });
  assert.deepEqual(db.wordFamily("zorb"), { name: "zorb", members: [] });
});

async function setup() {
  const db = openDb();
  db.importLexicon([], "test", [{ base: "quick", derived: ["quickly", "quickness"] }]);
  const lookups = [];
  const lookup = async (word) => {
    lookups.push(word);
    if (word === "quickness") throw new Error("not found"); // one relative can't be looked up
    return { word, phonetic: "", senses: [{ partOfSpeech: "adverb", persian: [], definition: `${word}.`, example: "" }] };
  };
  const server = createApp({ db, lookup }).listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://localhost:${server.address().port}/api`;
  const call = async (path, method = "GET", body) => {
    const res = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) });
    return res.status === 204 ? null : res.json();
  };
  return { db, call, lookups, close: () => server.close() };
}

test("adding a word adds its other forms and groups them", async (t) => {
  const { call, lookups, close } = await setup();
  t.after(close);
  const quickly = await call("/words", "POST", { word: "quickly" });
  assert.deepEqual(quickly.related, ["quick", "quickness"]);

  const result = await call(`/words/${quickly.id}/family`, "POST");
  assert.deepEqual(result.added.map((w) => w.word), ["quick"]);
  assert.deepEqual(lookups, ["quickly", "quick", "quickness"]);
  assert.deepEqual(result.groups, [{ id: result.groupId, name: "quick", parentId: null }]);
  assert.ok(result.words.every((w) => w.groupId === result.groupId));
});

test("a family word the user deleted isn't added back", async (t) => {
  const { call, lookups, close } = await setup();
  t.after(close);
  const quick = await call("/words", "POST", { word: "quick" });
  await call(`/words/${quick.id}/family`, "POST");
  const quickly = (await call("/words")).find((w) => w.word === "quickly");
  await call(`/words/${quickly.id}`, "DELETE");
  await call(`/words/${quick.id}`, "DELETE");

  const again = await call("/words", "POST", { word: "quick" });
  assert.deepEqual(again.related, ["quickness"]); // quickly was deleted by the user
  // Adding it by hand brings it back as normal.
  assert.equal((await call("/words", "POST", { word: "quickly" })).word, "quickly");
  assert.ok(lookups.filter((w) => w === "quickly").length === 2);
});

test("family words join a group the family already has, and others stay where the user put them", () => {
  const db = openDb();
  const [quick, quickly, quickness, other] = ["quick", "quickly", "quickness", "slow"]
    .map((word) => db.addWord({ word, phonetic: "", senses: [] }).id);
  const speed = db.createGroup("Speed", null, [{ kind: "word", id: quickly }, { kind: "word", id: other }]);

  // quickly sits in "Speed" with an unrelated word, so a "quick" group is made inside it.
  const family = db.groupFamily([quick, quickly], "quick");
  const groups = db.tree().groups;
  assert.deepEqual(groups.find((g) => g.id === family), { id: family, name: "quick", parentId: speed });

  // The family group (renamed by the user) is reused; quickness joins it.
  db.renameGroup(family, "سریع");
  assert.equal(db.groupFamily([quickness, quick, quickly], "quick"), family);
  const placed = new Map(db.tree().words.map((w) => [w.id, w.groupId]));
  assert.deepEqual([quick, quickly, quickness, other].map((id) => placed.get(id)), [family, family, family, speed]);
});
