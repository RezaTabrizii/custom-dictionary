import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { openDb } from "../src/db.js";
import { LookupError } from "../src/lookup.js";

const ENTRY = {
  word: "run",
  phonetic: "/rʌn/",
  senses: [
    { partOfSpeech: "verb", persian: ["دویدن"], definition: "To move fast on foot.", example: "I run every morning." },
    { partOfSpeech: "noun", persian: ["دو"], definition: "An act of running.", example: "She went for a run." },
  ],
};

let server, base, lookups;

before(async () => {
  lookups = [];
  const lookup = async (word) => {
    lookups.push(word);
    if (word === "runn") return ENTRY; // speech mishearing, corrected by the lookup
    if (word === "run") return ENTRY;
    throw new LookupError(`"${word}" doesn't look like an English word.`);
  };
  const app = createApp({ db: openDb(), lookup, password: "secret" });
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://localhost:${server.address().port}/api`;
});

after(() => server.close());

const call = (path, { method = "GET", body, password = "secret" } = {}) =>
  fetch(base + path, {
    method,
    headers: { "content-type": "application/json", "x-app-password": password },
    body: body && JSON.stringify(body),
  });

test("rejects a wrong password", async () => {
  const res = await call("/words", { password: "nope" });
  assert.equal(res.status, 401);
});

test("adds, lists, annotates and deletes a word", async () => {
  let res = await call("/words", { method: "POST", body: { word: "  Run " } });
  assert.equal(res.status, 201);
  const word = await res.json();
  assert.equal(word.word, "run");
  assert.equal(word.senses.length, 2);
  assert.deepEqual(lookups, ["run"]);

  // Same word again, or a mishearing that corrects to it, is not looked up twice into a duplicate.
  res = await call("/words", { method: "POST", body: { word: "RUN" } });
  assert.equal((await res.json()).existing, true);
  res = await call("/words", { method: "POST", body: { word: "runn" } });
  assert.equal((await res.json()).id, word.id);

  res = await call(`/words/${word.id}/examples`, { method: "POST", body: { text: "We ran home." } });
  assert.equal(res.status, 201);
  const withExample = await res.json();
  assert.deepEqual(withExample.examples.map((e) => e.text), ["We ran home."]);

  const list = await (await call("/words")).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].examples.length, 1);

  res = await call(`/examples/${withExample.examples[0].id}`, { method: "DELETE" });
  assert.equal(res.status, 204);
  res = await call(`/words/${word.id}`, { method: "DELETE" });
  assert.equal(res.status, 204);
  assert.deepEqual(await (await call("/words")).json(), []);
});

test("reports words the dictionary does not know", async () => {
  const res = await call("/words", { method: "POST", body: { word: "qwzx" } });
  assert.equal(res.status, 422);
  assert.match((await res.json()).error, /doesn't look like/);
});

test("validates input", async () => {
  assert.equal((await call("/words", { method: "POST", body: { word: "" } })).status, 400);
  assert.equal((await call("/words/999/examples", { method: "POST", body: { text: "Hi." } })).status, 404);
});
