import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashPassword, verifyPassword } from "../src/auth.js";
import { openDb } from "../src/db.js";
import { startApp } from "./helpers.js";

const lookup = async (word) => ({ word, phonetic: "", senses: [{ partOfSpeech: "noun", persian: [], definition: `${word}.`, example: "" }] });
const PASSWORD = "correct horse battery";

async function setup(options = {}) {
  const db = openDb();
  const app = await startApp({ db, lookup, ...options });
  return { db, ...app };
}

test("passwords are stored as salted scrypt hashes", async (t) => {
  const { db, request, close } = await setup();
  t.after(close);
  await request("/auth/signup", { method: "POST", body: { username: "reza", password: PASSWORD } });
  const stored = db.userByName("reza").password_hash;
  assert.match(stored, /^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.ok(!stored.includes(PASSWORD));
  assert.ok(await verifyPassword(PASSWORD, stored));
  assert.ok(!(await verifyPassword("correct horse batterY", stored)));
  // The same password gets a different salt, so equal passwords don't look equal.
  assert.notEqual(await hashPassword(PASSWORD), await hashPassword(PASSWORD));
});

test("the session cookie is HttpOnly and SameSite, and only its hash is stored", async (t) => {
  const { db, request, close } = await setup();
  t.after(close);
  const res = await request("/auth/signup", { method: "POST", body: { username: "reza", password: PASSWORD } });
  const cookie = res.headers.get("set-cookie");
  assert.match(cookie, /^vazhe_session=[A-Za-z0-9_-]{43};/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  const token = cookie.split(";")[0].split("=")[1];
  assert.equal(db.session(token), null); // the raw token isn't a key in the database
});

test("the first account is open, later ones need the invite code", async (t) => {
  const { request, close } = await setup();
  t.after(close);
  assert.equal((await request("/auth/status")).body.signup, "open");
  assert.equal((await request("/auth/signup", { method: "POST", body: { username: "reza", password: PASSWORD } })).status, 201);
  assert.equal((await request("/auth/status")).body.signup, "closed");
  const res = await request("/auth/signup", { method: "POST", body: { username: "sara", password: PASSWORD } });
  assert.equal(res.status, 403);
});

test("with an invite code, every account needs it", async (t) => {
  const { request, close } = await setup({ signupCode: "friends-2026" });
  t.after(close);
  assert.equal((await request("/auth/status")).body.signup, "code");
  const signup = (code, username = "sara") => request("/auth/signup", { method: "POST", body: { username, password: PASSWORD, code } });
  assert.equal((await signup("wrong")).status, 403);
  assert.equal((await signup(undefined)).status, 403);
  assert.equal((await signup("friends-2026")).status, 201);
  assert.equal((await signup("friends-2026", "SARA")).status, 409); // usernames ignore case
});

test("usernames and passwords are checked", async (t) => {
  const { request, close } = await setup();
  t.after(close);
  const signup = (username, password) => request("/auth/signup", { method: "POST", body: { username, password } });
  assert.equal((await signup("ab", PASSWORD)).status, 400);
  assert.equal((await signup("<script>", PASSWORD)).status, 400);
  assert.equal((await signup("reza", "short")).status, 400);
  assert.equal((await signup("rezareza", "rezareza")).status, 400); // password = username
  assert.equal((await signup("reza", "x".repeat(201))).status, 400);
});

test("signing in, a wrong password, and signing out", async (t) => {
  const { request, close } = await setup();
  t.after(close);
  await request("/auth/signup", { method: "POST", body: { username: "reza", password: PASSWORD } });
  const login = (username, password) => request("/auth/login", { method: "POST", body: { username, password } });

  const wrong = await login("reza", "nope nope nope");
  const unknown = await login("nobody", PASSWORD);
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.equal(wrong.body.error, unknown.body.error); // doesn't say which part was wrong

  const ok = await login("REZA", PASSWORD);
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get("set-cookie").split(";")[0];
  assert.equal((await request("/auth/status", { cookie })).body.user.username, "reza");
  assert.equal((await request("/words", { cookie })).status, 200);

  assert.equal((await request("/auth/logout", { method: "POST", cookie })).status, 204);
  assert.equal((await request("/words", { cookie })).status, 401); // the old cookie no longer works
});

test("too many wrong passwords are slowed down", async (t) => {
  const { request, close } = await setup();
  t.after(close);
  await request("/auth/signup", { method: "POST", body: { username: "reza", password: PASSWORD } });
  const login = (password) => request("/auth/login", { method: "POST", body: { username: "reza", password } });
  for (let i = 0; i < 10; i++) assert.equal((await login(`guess ${i} guess`)).status, 401);
  const blocked = await login(PASSWORD); // even the right password waits now
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get("retry-after")) > 0);
});

test("each person sees and changes only their own dictionary", async (t) => {
  const { person, close } = await setup({ signupCode: "code" });
  t.after(close);
  const reza = await person("reza");
  const sara = await person("sara");
  const word = await reza("/words", "POST", { word: "run" });
  const group = await reza("/groups", "POST", { items: [{ kind: "word", id: word.id }] });

  assert.deepEqual(await sara("/words"), []);
  assert.deepEqual((await sara("/tree")).groups, []);
  // Sara can't reach Reza's word or group by its id.
  for (const [path, method, body] of [
    [`/words/${word.id}`, "DELETE"],
    [`/words/${word.id}/examples`, "POST", { text: "Hi." }],
    [`/words/${word.id}/senses`, "PUT", { senses: [{ partOfSpeech: "noun", persian: ["x"], definition: "", example: "" }] }],
    [`/words/${word.id}/family`, "POST", {}],
    [`/words/${word.id}/group`, "PUT", { groupId: null }],
  ]) {
    assert.ok([400, 404].includes((await sara.raw(path, { method, body })).status), `${method} ${path}`);
  }
  assert.equal((await sara.raw(`/groups/${group.created}`, { method: "PATCH", body: { name: "Mine" } })).status, 400);
  assert.equal((await sara.raw(`/groups/${group.created}`, { method: "DELETE" })).status, 400);
  // Nor put her word into his group.
  const hers = await sara("/words", "POST", { word: "walk" });
  assert.equal((await sara.raw(`/words/${hers.id}/group`, { method: "PUT", body: { groupId: group.created } })).status, 400);

  const his = await reza("/words");
  assert.equal(his.length, 1);
  assert.equal(his[0].groupId, group.created);
  assert.deepEqual(his[0].examples, []);
  // The same word can be in both dictionaries.
  assert.equal((await sara.raw("/words", { method: "POST", body: { word: "run" } })).status, 201);
});

test("changing the password signs out the other sessions", async (t) => {
  const { request, person, close } = await setup();
  t.after(close);
  const phone = await person("reza");
  const laptop = await person("reza"); // signs in again
  assert.equal((await laptop.raw("/auth/password", { method: "POST", body: { current: "wrong password", password: "a new long password" } })).status, 403);
  assert.equal((await laptop.raw("/auth/password", { method: "POST", body: { current: PASSWORD, password: "a new long password" } })).status, 204);
  assert.equal((await laptop.raw("/words")).status, 200);
  assert.equal((await phone.raw("/words")).status, 401);
  const login = (password) => request("/auth/login", { method: "POST", body: { username: "reza", password } });
  assert.equal((await login(PASSWORD)).status, 401);
  assert.equal((await login("a new long password")).status, 200);
});

test("changes from other sites are refused", async (t) => {
  const { person, close } = await setup();
  t.after(close);
  const reza = await person("reza");
  const post = (headers) => reza.raw("/words", { method: "POST", body: { word: "run" }, headers });
  assert.equal((await post({ origin: "https://evil.example" })).status, 403);
  assert.equal((await post({ "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await post({ "content-type": "text/plain" })).status, 415); // what a plain HTML form can send
  assert.equal((await post({ "sec-fetch-site": "same-origin" })).status, 201);
});

test("errors don't reveal details", async (t) => {
  const { base, close } = await setup();
  t.after(close);
  const res = await fetch(`${base}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
  assert.equal(res.status, 400);
  const text = await res.text();
  assert.deepEqual(JSON.parse(text), { error: "That request isn't valid." });
  assert.ok(!/\s at |node_modules|SyntaxError/.test(text));
});

test("pages are sent with security headers", async (t) => {
  const { request, close } = await setup();
  t.after(close);
  const { headers } = await request("/auth/status");
  assert.match(headers.get("content-security-policy"), /script-src 'self'/);
  assert.match(headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(headers.get("x-content-type-options"), "nosniff");
  assert.equal(headers.get("cache-control"), "no-store");
  assert.equal(headers.get("x-powered-by"), null);
});

test("a dictionary from before accounts becomes the first account's", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "vazhe-")), "old.db");
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE words (id INTEGER PRIMARY KEY, word TEXT NOT NULL UNIQUE COLLATE NOCASE, phonetic TEXT NOT NULL DEFAULT '',
      senses TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), audio TEXT NOT NULL DEFAULT '', group_id INTEGER);
    CREATE TABLE groups (id INTEGER PRIMARY KEY, name TEXT NOT NULL, parent_id INTEGER);
    CREATE TABLE examples (id INTEGER PRIMARY KEY, word_id INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
      text TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE dismissed (word TEXT PRIMARY KEY COLLATE NOCASE);
    INSERT INTO groups (id, name) VALUES (1, 'Moving');
    INSERT INTO words (id, word, senses, group_id) VALUES (1, 'run', '[]', 1), (2, 'walk', '[]', 1);
    INSERT INTO examples (word_id, text) VALUES (1, 'I run.');
    INSERT INTO dismissed (word) VALUES ('ran');
  `);
  old.close();

  const db = openDb(file);
  const reza = db.forUser(db.createUser("reza", "not-a-real-hash"));
  assert.deepEqual(reza.listWords().map((w) => [w.word, w.groupId, w.examples.length]), [["walk", 1, 0], ["run", 1, 1]]);
  assert.deepEqual(reza.tree().groups, [{ id: 1, name: "Moving", parentId: null }]);
  assert.ok(reza.isDismissed("ran"));
  // A second account starts empty.
  assert.deepEqual(db.forUser(db.createUser("sara", "not-a-real-hash")).listWords(), []);
  // Deleting a word still deletes its sentences.
  reza.deleteWord(1);
  assert.equal(new DatabaseSync(file).prepare("SELECT count(*) AS n FROM examples").get().n, 0);
});

test("the health check answers without signing in", async (t) => {
  const { base, close } = await setup();
  t.after(close);
  const res = await fetch(base.replace(/\/api$/, "/healthz"));
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "ok");
});

test("a backup is a full copy of the database", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vazhe-"));
  const db = openDb(join(dir, "dictionary.db"));
  db.forUser(db.createUser("reza", "not-a-real-hash")).addWord({ word: "run", phonetic: "", senses: [] });
  db.backup(join(dir, "copy.db"));
  db.close();
  const copy = openDb(join(dir, "copy.db"));
  assert.deepEqual(copy.forUser(copy.userByName("reza").id).listWords().map((w) => w.word), ["run"]);
});
