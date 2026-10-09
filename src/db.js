import { DatabaseSync } from "node:sqlite";
import { cleanSenses, CLEANUP_VERSION } from "./persian.js";

// A move that would put a group inside itself, or refers to something missing.
export class InvalidMove extends Error {}

// One SQLite file holds every account and its dictionary, plus the shared
// offline data. Senses come from the lookup and are stored as JSON.
//
// Everything that belongs to a person is reached through forUser(id), whose
// queries all include that person's id, so one account can never read or
// change another's words.
export function openDb(file = ":memory:") {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA foreign_keys = ON;
    -- Lets the users and backup scripts work while the server is running.
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY,
      username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- Only a hash of each session token is kept, so the database alone can't sign anyone in.
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS words (
      id         INTEGER PRIMARY KEY,
      user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
      word       TEXT NOT NULL COLLATE NOCASE,
      phonetic   TEXT NOT NULL DEFAULT '',
      senses     TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      audio      TEXT NOT NULL DEFAULT '',
      group_id   INTEGER REFERENCES groups(id),
      UNIQUE (user_id, word)
    );
    -- Groups of words; a group can sit inside another group.
    CREATE TABLE IF NOT EXISTS groups (
      id        INTEGER PRIMARY KEY,
      user_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
      name      TEXT NOT NULL,
      parent_id INTEGER REFERENCES groups(id)
    );
    CREATE TABLE IF NOT EXISTS examples (
      id         INTEGER PRIMARY KEY,
      word_id    INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
      text       TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- Words a person deleted, so they aren't added back as part of a family.
    CREATE TABLE IF NOT EXISTS dismissed (
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      word    TEXT NOT NULL COLLATE NOCASE,
      PRIMARY KEY (user_id, word)
    );
    -- The free offline dictionary, filled once from lexicon/en-fa.jsonl.gz.
    CREATE TABLE IF NOT EXISTS lexicon (
      word     TEXT PRIMARY KEY COLLATE NOCASE,
      phonetic TEXT NOT NULL,
      senses   TEXT NOT NULL,
      audio    TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS lexicon_forms (
      form TEXT PRIMARY KEY COLLATE NOCASE,
      word TEXT NOT NULL
    );
    -- Word families from the offline data: each word made from a base word by a suffix.
    CREATE TABLE IF NOT EXISTS lexicon_family (
      word TEXT NOT NULL COLLATE NOCASE,
      base TEXT NOT NULL COLLATE NOCASE,
      PRIMARY KEY (word, base)
    );
    CREATE INDEX IF NOT EXISTS lexicon_family_base ON lexicon_family (base);
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  migrate(db);
  db.exec(`
    CREATE INDEX IF NOT EXISTS words_user ON words (user_id);
    CREATE INDEX IF NOT EXISTS groups_user ON groups (user_id);
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);
  `);

  const q = {
    lexiconSize: db.prepare("SELECT count(*) AS n FROM lexicon"),
    metaGet: db.prepare("SELECT value FROM meta WHERE key = ?"),
    metaSet: db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)"),
    lexiconInsert: db.prepare("INSERT OR IGNORE INTO lexicon (word, phonetic, audio, senses) VALUES (?, ?, ?, ?)"),
    formInsert: db.prepare("INSERT OR IGNORE INTO lexicon_forms (form, word) VALUES (?, ?)"),
    familyInsert: db.prepare("INSERT OR IGNORE INTO lexicon_family (word, base) VALUES (?, ?)"),
    familyOf: db.prepare("SELECT base AS w FROM lexicon_family WHERE word = ?1 UNION SELECT word FROM lexicon_family WHERE base = ?1"),
    lexiconGet: db.prepare(`
      SELECT word, phonetic, audio, senses FROM lexicon WHERE word = ?1
      UNION ALL
      SELECT l.word, l.phonetic, l.audio, l.senses FROM lexicon_forms f JOIN lexicon l ON l.word = f.word WHERE f.form = ?1
      LIMIT 1`),

    userCount: db.prepare("SELECT count(*) AS n FROM users"),
    userByName: db.prepare("SELECT id, username, password_hash FROM users WHERE username = ?"),
    userById: db.prepare("SELECT id, username, password_hash FROM users WHERE id = ?"),
    insertUser: db.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)"),
    setPassword: db.prepare("UPDATE users SET password_hash = ? WHERE id = ?"),
    listUsers: db.prepare(`
      SELECT u.id, u.username, u.created_at, (SELECT count(*) FROM words w WHERE w.user_id = u.id) AS words
      FROM users u ORDER BY u.id`),
    claimWords: db.prepare("UPDATE words SET user_id = ? WHERE user_id IS NULL"),
    claimGroups: db.prepare("UPDATE groups SET user_id = ? WHERE user_id IS NULL"),
    claimDismissed: db.prepare("UPDATE OR IGNORE dismissed SET user_id = ? WHERE user_id IS NULL"),
    insertSession: db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)"),
    session: db.prepare(`
      SELECT s.user_id, s.expires_at, u.username FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?`),
    extendSession: db.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ?"),
    deleteSession: db.prepare("DELETE FROM sessions WHERE token_hash = ?"),
    deleteOtherSessions: db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?"),
    deleteUserSessions: db.prepare("DELETE FROM sessions WHERE user_id = ?"),
    deleteExpiredSessions: db.prepare("DELETE FROM sessions WHERE expires_at <= ?"),
  };

  // Saved words get the same Persian cleanup as new ones, once per cleanup version.
  if (q.metaGet.get("persian_cleanup")?.value !== CLEANUP_VERSION) {
    const update = db.prepare("UPDATE words SET senses = ? WHERE id = ?");
    db.exec("BEGIN");
    for (const row of db.prepare("SELECT id, senses FROM words").all()) {
      update.run(JSON.stringify(cleanSenses(JSON.parse(row.senses))), row.id);
    }
    q.metaSet.run("persian_cleanup", CLEANUP_VERSION);
    db.exec("COMMIT");
  }

  const stores = new Map();

  return {
    // Writes a consistent copy of the whole database to file, even while it's in use.
    backup(file) {
      db.prepare("VACUUM INTO ?").run(file);
    },
    close() {
      db.close();
    },

    /* ---------- Accounts and sessions ---------- */

    userCount() {
      return q.userCount.get().n;
    },
    userByName(username) {
      return q.userByName.get(username) ?? null;
    },
    userById(id) {
      return q.userById.get(id) ?? null;
    },
    // The first account also takes over the words saved before accounts existed.
    createUser(username, passwordHash) {
      db.exec("BEGIN");
      try {
        const id = Number(q.insertUser.run(username, passwordHash).lastInsertRowid);
        if (q.userCount.get().n === 1) {
          q.claimWords.run(id);
          q.claimGroups.run(id);
          q.claimDismissed.run(id);
        }
        db.exec("COMMIT");
        return id;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    setPassword(userId, passwordHash) {
      q.setPassword.run(passwordHash, userId);
    },
    listUsers() {
      return q.listUsers.all();
    },
    // Deletes an account with its words, sentences, groups and sessions.
    deleteUser(userId) {
      db.exec("BEGIN");
      try {
        db.prepare("DELETE FROM examples WHERE word_id IN (SELECT id FROM words WHERE user_id = ?)").run(userId);
        db.prepare("DELETE FROM words WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM dismissed WHERE user_id = ?").run(userId);
        db.prepare("UPDATE groups SET parent_id = NULL WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM groups WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM users WHERE id = ?").run(userId);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    createSession(tokenHash, userId, expiresAt) {
      q.deleteExpiredSessions.run(Date.now());
      q.insertSession.run(tokenHash, userId, expiresAt);
    },
    // The signed-in user for a session, or null when it's unknown or expired.
    session(tokenHash) {
      const row = q.session.get(tokenHash, Date.now());
      return row ? { userId: row.user_id, username: row.username, expiresAt: row.expires_at } : null;
    },
    extendSession(tokenHash, expiresAt) {
      q.extendSession.run(expiresAt, tokenHash);
    },
    deleteSession(tokenHash) {
      q.deleteSession.run(tokenHash);
    },
    // Signs a user out everywhere, except the session given (if any).
    deleteSessions(userId, exceptTokenHash = null) {
      if (exceptTokenHash) q.deleteOtherSessions.run(userId, exceptTokenHash);
      else q.deleteUserSessions.run(userId);
    },

    /* ---------- One person's dictionary ---------- */

    forUser(userId) {
      if (!stores.has(userId)) stores.set(userId, userStore(db, userId));
      return stores.get(userId);
    },

    /* ---------- Shared offline data ---------- */

    // The other words of a word's family, nearest first (quickly -> quick, then
    // quickness), at most `max` of them, and the family's name: its shortest word.
    wordFamily(word, max = 8) {
      const start = word.toLowerCase();
      const seen = new Set([start]);
      let layer = [start];
      const members = [];
      while (layer.length) {
        const next = [];
        for (const w of layer) {
          for (const { w: other } of q.familyOf.all(w)) {
            const o = other.toLowerCase();
            if (!seen.has(o)) {
              seen.add(o);
              next.push(o);
            }
          }
        }
        next.sort((a, b) => a.length - b.length || a.localeCompare(b));
        members.push(...next);
        layer = next;
      }
      const name = [...seen].sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
      return { name, members: members.slice(0, max) };
    },
    lexiconSize() {
      return q.lexiconSize.get().n;
    },
    lexiconVersion() {
      return q.metaGet.get("lexicon")?.value ?? "";
    },
    // Replaces the offline dictionary; people's own words are untouched.
    importLexicon(records, version, families = []) {
      db.exec("BEGIN");
      try {
        db.exec("DELETE FROM lexicon; DELETE FROM lexicon_forms; DELETE FROM lexicon_family;");
        q.metaSet.run("lexicon", version);
        for (const r of records) {
          q.lexiconInsert.run(r.word, r.phonetic, r.audio ?? "", JSON.stringify(r.senses));
          for (const form of r.forms) q.formInsert.run(form, r.word);
        }
        for (const f of families) {
          for (const word of f.derived) q.familyInsert.run(word, f.base);
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    findInLexicon(word) {
      const row = q.lexiconGet.get(word);
      return row && { word: row.word, phonetic: row.phonetic, audio: row.audio, senses: JSON.parse(row.senses) };
    },
  };
}

// Brings a database from before accounts up to date. Its words, groups and
// deleted-word list keep an empty owner until the first account claims them.
function migrate(db) {
  const columns = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

  // Columns added after the first release.
  if (!columns("lexicon").includes("audio")) db.exec("ALTER TABLE lexicon ADD COLUMN audio TEXT NOT NULL DEFAULT ''");
  if (!columns("words").includes("audio")) db.exec("ALTER TABLE words ADD COLUMN audio TEXT NOT NULL DEFAULT ''");
  if (!columns("words").includes("group_id")) db.exec("ALTER TABLE words ADD COLUMN group_id INTEGER REFERENCES groups(id)");
  if (!columns("groups").includes("user_id")) {
    db.exec("ALTER TABLE groups ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE");
  }
  if (columns("words").includes("user_id") && columns("dismissed").includes("user_id")) return;

  // A word was unique across the whole database; now it's unique per person,
  // which SQLite can only change by rebuilding the table.
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN");
  try {
    if (!columns("words").includes("user_id")) {
      db.exec(`
        CREATE TABLE words_new (
          id         INTEGER PRIMARY KEY,
          user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
          word       TEXT NOT NULL COLLATE NOCASE,
          phonetic   TEXT NOT NULL DEFAULT '',
          senses     TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          audio      TEXT NOT NULL DEFAULT '',
          group_id   INTEGER REFERENCES groups(id),
          UNIQUE (user_id, word)
        );
        INSERT INTO words_new (id, word, phonetic, senses, created_at, audio, group_id)
          SELECT id, word, phonetic, senses, created_at, audio, group_id FROM words;
        DROP TABLE words;
        ALTER TABLE words_new RENAME TO words;
      `);
    }
    if (!columns("dismissed").includes("user_id")) {
      db.exec(`
        CREATE TABLE dismissed_new (
          user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          word    TEXT NOT NULL COLLATE NOCASE,
          PRIMARY KEY (user_id, word)
        );
        INSERT INTO dismissed_new (word) SELECT word FROM dismissed;
        DROP TABLE dismissed;
        ALTER TABLE dismissed_new RENAME TO dismissed;
      `);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

// One person's words, sentences and groups. Every query is limited to their id.
function userStore(db, uid) {
  const q = {
    all: db.prepare("SELECT * FROM words WHERE user_id = ?1 ORDER BY id DESC"),
    allExamples: db.prepare(`
      SELECT e.* FROM examples e JOIN words w ON w.id = e.word_id WHERE w.user_id = ?1 ORDER BY e.id`),
    byId: db.prepare("SELECT * FROM words WHERE id = ?2 AND user_id = ?1"),
    byWord: db.prepare("SELECT * FROM words WHERE word = ?2 AND user_id = ?1"),
    examplesOf: db.prepare("SELECT * FROM examples WHERE word_id = ? ORDER BY id"),
    insert: db.prepare("INSERT INTO words (user_id, word, phonetic, audio, senses) VALUES (?1, ?2, ?3, ?4, ?5)"),
    updateSenses: db.prepare("UPDATE words SET senses = ?3 WHERE id = ?2 AND user_id = ?1"),
    remove: db.prepare("DELETE FROM words WHERE id = ?2 AND user_id = ?1"),
    insertExample: db.prepare("INSERT INTO examples (word_id, text) VALUES (?, ?)"),
    removeExample: db.prepare(`
      DELETE FROM examples WHERE id = ?2 AND word_id IN (SELECT id FROM words WHERE user_id = ?1)`),
    groups: db.prepare("SELECT id, name, parent_id FROM groups WHERE user_id = ?1 ORDER BY id"),
    placements: db.prepare("SELECT id, group_id FROM words WHERE user_id = ?1"),
    groupById: db.prepare("SELECT id, name, parent_id FROM groups WHERE id = ?2 AND user_id = ?1"),
    insertGroup: db.prepare("INSERT INTO groups (user_id, name, parent_id) VALUES (?1, ?2, ?3)"),
    renameGroup: db.prepare("UPDATE groups SET name = ?3 WHERE id = ?2 AND user_id = ?1"),
    setGroupParent: db.prepare("UPDATE groups SET parent_id = ?3 WHERE id = ?2 AND user_id = ?1"),
    setWordGroup: db.prepare("UPDATE words SET group_id = ?3 WHERE id = ?2 AND user_id = ?1"),
    liftWords: db.prepare("UPDATE words SET group_id = ?3 WHERE group_id = ?2 AND user_id = ?1"),
    liftGroups: db.prepare("UPDATE groups SET parent_id = ?3 WHERE parent_id = ?2 AND user_id = ?1"),
    removeGroup: db.prepare("DELETE FROM groups WHERE id = ?2 AND user_id = ?1"),
    removeEmptyGroups: db.prepare(`
      DELETE FROM groups WHERE user_id = ?1
        AND id NOT IN (SELECT group_id FROM words WHERE group_id IS NOT NULL)
        AND id NOT IN (SELECT parent_id FROM groups WHERE parent_id IS NOT NULL)`),
    groupWordIds: db.prepare("SELECT id FROM words WHERE group_id = ?2 AND user_id = ?1"),
    childGroupCount: db.prepare("SELECT count(*) AS n FROM groups WHERE parent_id = ?2 AND user_id = ?1"),
    dismiss: db.prepare("INSERT OR IGNORE INTO dismissed (user_id, word) VALUES (?1, ?2)"),
    undismiss: db.prepare("DELETE FROM dismissed WHERE word = ?2 AND user_id = ?1"),
    isDismissed: db.prepare("SELECT 1 FROM dismissed WHERE word = ?2 AND user_id = ?1"),
  };

  const shape = (row, examples) => ({
    id: row.id,
    word: row.word,
    phonetic: row.phonetic,
    audio: row.audio,
    senses: JSON.parse(row.senses),
    examples: examples.map(({ id, text }) => ({ id, text })),
    createdAt: row.created_at,
    groupId: row.group_id ?? null,
  });

  function transaction(fn) {
    db.exec("BEGIN");
    try {
      const result = fn();
      // A group that loses its last word or group goes away.
      while (q.removeEmptyGroups.run(uid).changes);
      db.exec("COMMIT");
      return result;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  // Checks that a group exists and is this person's (null is the top level).
  function existingGroup(id) {
    if (id === null) return null;
    const group = q.groupById.get(uid, id);
    if (!group) throw new InvalidMove("That group doesn't exist.");
    return group;
  }

  // Whether group `id` is `ancestor` or somewhere inside it.
  function isWithin(id, ancestor) {
    for (let g = id; g !== null; g = q.groupById.get(uid, g)?.parent_id ?? null) {
      if (g === ancestor) return true;
    }
    return false;
  }

  // Puts a word or a group into a group (null is the top level).
  function place({ kind, id }, groupId) {
    if (kind === "word") {
      if (!q.byId.get(uid, id)) throw new InvalidMove("That word doesn't exist.");
      q.setWordGroup.run(uid, id, groupId);
    } else {
      existingGroup(id);
      if (groupId !== null && isWithin(groupId, id)) throw new InvalidMove("A group can't go inside itself.");
      q.setGroupParent.run(uid, id, groupId);
    }
  }

  return {
    listWords() {
      const byWord = Map.groupBy(q.allExamples.all(uid), (e) => e.word_id);
      return q.all.all(uid).map((row) => shape(row, byWord.get(row.id) ?? []));
    },
    getWord(id) {
      const row = q.byId.get(uid, id);
      return row ? shape(row, q.examplesOf.all(id)) : null;
    },
    findWord(word) {
      const row = q.byWord.get(uid, word);
      return row ? shape(row, q.examplesOf.all(row.id)) : null;
    },
    addWord({ word, phonetic, audio = "", senses }) {
      q.undismiss.run(uid, word);
      const { lastInsertRowid } = q.insert.run(uid, word, phonetic, audio, JSON.stringify(cleanSenses(senses)));
      return this.getWord(Number(lastInsertRowid));
    },
    // Replaces a word's meanings with the person's edited ones.
    updateSenses(id, senses) {
      if (!q.updateSenses.run(uid, id, JSON.stringify(cleanSenses(senses))).changes) return null;
      return this.getWord(id);
    },
    deleteWord(id) {
      return transaction(() => {
        const row = q.byId.get(uid, id);
        if (row) q.dismiss.run(uid, row.word);
        return q.remove.run(uid, id).changes > 0;
      });
    },
    isDismissed(word) {
      return Boolean(q.isDismissed.get(uid, word));
    },
    addExample(wordId, text) {
      if (!q.byId.get(uid, wordId)) return null;
      q.insertExample.run(wordId, text);
      return this.getWord(wordId);
    },
    deleteExample(id) {
      return q.removeExample.run(uid, id).changes > 0;
    },

    // Puts a family's saved words in one group and returns its id. A group that
    // holds only family words is reused; otherwise a group named after the family
    // is made where the first word is (wordIds[0]). Words the person put in other
    // groups stay there.
    groupFamily(wordIds, name) {
      return transaction(() => {
        const family = new Set(wordIds);
        const rows = wordIds.map((id) => q.byId.get(uid, id)).filter(Boolean);
        const groupIds = [...new Set(rows.map((r) => r.group_id).filter((g) => g !== null))];
        let target = groupIds.find((g) => !q.childGroupCount.get(uid, g).n
          && q.groupWordIds.all(uid, g).every(({ id }) => family.has(id)));
        // A new group goes where the first grouped word is, taking the words there too.
        let home = null;
        if (target === undefined) {
          home = rows.find((r) => r.group_id !== null)?.group_id ?? null;
          target = Number(q.insertGroup.run(uid, name, home).lastInsertRowid);
        }
        for (const r of rows) {
          if (r.group_id === null || (home !== null && r.group_id === home)) q.setWordGroup.run(uid, r.id, target);
        }
        return target;
      });
    },

    // The groups, and which group each word is in.
    tree() {
      return {
        groups: q.groups.all(uid).map((g) => ({ id: g.id, name: g.name, parentId: g.parent_id ?? null })),
        words: q.placements.all(uid).map((w) => ({ id: w.id, groupId: w.group_id ?? null })),
      };
    },
    // Makes a group inside `parentId` holding `items` ({ kind: "word" | "group", id }).
    createGroup(name, parentId, items) {
      return transaction(() => {
        existingGroup(parentId);
        const id = Number(q.insertGroup.run(uid, name, parentId).lastInsertRowid);
        for (const item of items) place(item, id);
        return id;
      });
    },
    renameGroup(id, name) {
      existingGroup(id);
      q.renameGroup.run(uid, id, name);
    },
    // Moves a word or a group into a group, or to the top level with null.
    move(item, groupId) {
      transaction(() => {
        existingGroup(groupId);
        place(item, groupId);
      });
    },
    // Removes a group; what was in it moves up to the group's own parent.
    ungroup(id) {
      transaction(() => {
        const group = existingGroup(id);
        q.liftWords.run(uid, id, group.parent_id);
        q.liftGroups.run(uid, id, group.parent_id);
        q.removeGroup.run(uid, id);
      });
    },
  };
}
