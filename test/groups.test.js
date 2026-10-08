import { test } from "node:test";
import assert from "node:assert/strict";
import { startApp } from "./helpers.js";
import { openDb } from "../src/db.js";

async function setup() {
  const db = openDb();
  const app = await startApp({ db, lookup: async () => { throw new Error("no lookups"); } });
  const person = await app.person("reza");
  const ids = {};
  for (const word of ["run", "walk", "jump", "swim"]) {
    ids[word] = db.forUser(db.userByName("reza").id).addWord({ word, phonetic: "", senses: [] }).id;
  }
  const call = async (path, method = "GET", body) => {
    const { status, body: json } = await person.raw(path, { method, body });
    return { status, body: json };
  };
  return { ids, call, close: app.close };
}

const groupOf = (tree, wordId) => tree.words.find((w) => w.id === wordId).groupId;
const word = (id) => ({ kind: "word", id });
const group = (id) => ({ kind: "group", id });

test("dropping a word on a word makes a named group of both", async (t) => {
  const { ids, call, close } = await setup();
  t.after(close);
  let { status, body } = await call("/groups", "POST", { parentId: null, items: [word(ids.run), word(ids.walk)] });
  assert.equal(status, 200);
  const id = body.created;
  assert.deepEqual(body.groups, [{ id, name: "New group", parentId: null }]);
  assert.equal(groupOf(body, ids.run), id);
  assert.equal(groupOf(body, ids.walk), id);
  assert.equal(groupOf(body, ids.jump), null);

  ({ body } = await call(`/groups/${id}`, "PATCH", { name: "  Moving  " }));
  assert.equal(body.groups[0].name, "Moving");
  assert.equal((await call(`/groups/${id}`, "PATCH", { name: " " })).status, 400);

  // Words list their group too.
  const words = (await call("/words")).body;
  assert.equal(words.find((w) => w.id === ids.run).groupId, id);
});

test("groups nest, can't go inside themselves, and ungrouping keeps their contents", async (t) => {
  const { ids, call, close } = await setup();
  t.after(close);
  const outer = (await call("/groups", "POST", { parentId: null, items: [word(ids.run), word(ids.walk)] })).body.created;
  // A word dropped on a word inside a group makes the new group inside it.
  const inner = (await call("/groups", "POST", { parentId: outer, items: [word(ids.jump), word(ids.walk)] })).body.created;
  let { body } = await call("/tree");
  assert.equal(body.groups.find((g) => g.id === inner).parentId, outer);
  assert.equal(groupOf(body, ids.jump), inner);

  assert.equal((await call(`/groups/${outer}`, "PATCH", { parentId: inner })).status, 400);
  assert.equal((await call(`/groups/${outer}`, "PATCH", { parentId: outer })).status, 400);
  assert.equal((await call("/groups", "POST", { parentId: inner, items: [group(outer), word(ids.walk)] })).status, 400);
  assert.equal((await call(`/words/${ids.swim}/group`, "PUT", { groupId: 999 })).status, 400);

  ({ body } = await call(`/groups/${outer}`, "DELETE"));
  assert.deepEqual(body.groups.map((g) => [g.id, g.parentId]), [[inner, null]]);
  assert.equal(groupOf(body, ids.run), null);
  assert.equal(groupOf(body, ids.jump), inner);
});

test("a group that loses its last word goes away", async (t) => {
  const { ids, call, close } = await setup();
  t.after(close);
  const outer = (await call("/groups", "POST", { parentId: null, items: [word(ids.run), word(ids.walk)] })).body.created;
  await call("/groups", "POST", { parentId: outer, items: [word(ids.run), word(ids.walk)] });
  // Both words moved into the inner group; the outer group still holds it.
  assert.equal((await call("/tree")).body.groups.length, 2);

  await call(`/words/${ids.run}/group`, "PUT", { groupId: null });
  await call(`/words/${ids.walk}`, "DELETE");
  assert.deepEqual((await call("/tree")).body.groups, []); // inner emptied, then outer emptied
});
