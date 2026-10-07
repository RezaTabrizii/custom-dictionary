import { DatabaseSync } from "node:sqlite";

// One SQLite file holds the whole dictionary. Senses come from the lookup and
// are stored as JSON; the user's own sentences live in their own table.
export function openDb(file = ":memory:") {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS words (
      id         INTEGER PRIMARY KEY,
      word       TEXT NOT NULL UNIQUE COLLATE NOCASE,
      phonetic   TEXT NOT NULL DEFAULT '',
      senses     TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS examples (
      id         INTEGER PRIMARY KEY,
      word_id    INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
      text       TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- The free offline dictionary, filled once from lexicon/en-fa.jsonl.gz.
    CREATE TABLE IF NOT EXISTS lexicon (
      word     TEXT PRIMARY KEY COLLATE NOCASE,
      phonetic TEXT NOT NULL,
      senses   TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS lexicon_forms (
      form TEXT PRIMARY KEY COLLATE NOCASE,
      word TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const q = {
    all: db.prepare("SELECT * FROM words ORDER BY id DESC"),
    allExamples: db.prepare("SELECT * FROM examples ORDER BY id"),
    byId: db.prepare("SELECT * FROM words WHERE id = ?"),
    byWord: db.prepare("SELECT * FROM words WHERE word = ?"),
    examplesOf: db.prepare("SELECT * FROM examples WHERE word_id = ? ORDER BY id"),
    insert: db.prepare("INSERT INTO words (word, phonetic, senses) VALUES (?, ?, ?)"),
    remove: db.prepare("DELETE FROM words WHERE id = ?"),
    insertExample: db.prepare("INSERT INTO examples (word_id, text) VALUES (?, ?)"),
    removeExample: db.prepare("DELETE FROM examples WHERE id = ?"),
    lexiconSize: db.prepare("SELECT count(*) AS n FROM lexicon"),
    metaGet: db.prepare("SELECT value FROM meta WHERE key = ?"),
    metaSet: db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)"),
    lexiconInsert: db.prepare("INSERT OR IGNORE INTO lexicon (word, phonetic, senses) VALUES (?, ?, ?)"),
    formInsert: db.prepare("INSERT OR IGNORE INTO lexicon_forms (form, word) VALUES (?, ?)"),
    lexiconGet: db.prepare(`
      SELECT word, phonetic, senses FROM lexicon WHERE word = ?1
      UNION ALL
      SELECT l.word, l.phonetic, l.senses FROM lexicon_forms f JOIN lexicon l ON l.word = f.word WHERE f.form = ?1
      LIMIT 1`),
  };

  const shape = (row, examples) => ({
    id: row.id,
    word: row.word,
    phonetic: row.phonetic,
    senses: JSON.parse(row.senses),
    examples: examples.map(({ id, text }) => ({ id, text })),
    createdAt: row.created_at,
  });

  return {
    listWords() {
      const byWord = Map.groupBy(q.allExamples.all(), (e) => e.word_id);
      return q.all.all().map((row) => shape(row, byWord.get(row.id) ?? []));
    },
    getWord(id) {
      const row = q.byId.get(id);
      return row ? shape(row, q.examplesOf.all(id)) : null;
    },
    findWord(word) {
      const row = q.byWord.get(word);
      return row ? shape(row, q.examplesOf.all(row.id)) : null;
    },
    addWord({ word, phonetic, senses }) {
      const { lastInsertRowid } = q.insert.run(word, phonetic, JSON.stringify(senses));
      return this.getWord(Number(lastInsertRowid));
    },
    deleteWord(id) {
      return q.remove.run(id).changes > 0;
    },
    addExample(wordId, text) {
      q.insertExample.run(wordId, text);
      return this.getWord(wordId);
    },
    deleteExample(id) {
      return q.removeExample.run(id).changes > 0;
    },
    lexiconSize() {
      return q.lexiconSize.get().n;
    },
    lexiconVersion() {
      return q.metaGet.get("lexicon")?.value ?? "";
    },
    // Replaces the offline dictionary; the user's own words are untouched.
    importLexicon(records, version) {
      db.exec("BEGIN");
      try {
        db.exec("DELETE FROM lexicon; DELETE FROM lexicon_forms;");
        q.metaSet.run("lexicon", version);
        for (const r of records) {
          q.lexiconInsert.run(r.word, r.phonetic, JSON.stringify(r.senses));
          for (const form of r.forms) q.formInsert.run(form, r.word);
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    findInLexicon(word) {
      const row = q.lexiconGet.get(word);
      return row && { word: row.word, phonetic: row.phonetic, senses: JSON.parse(row.senses) };
    },
  };
}
