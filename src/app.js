import express from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { LookupError } from "./lookup.js";

const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));
const MAX_WORD = 60;
const MAX_SENTENCE = 400;

const digest = (s) => createHash("sha256").update(s).digest();

export function createApp({ db, lookup, password = "" }) {
  const app = express();
  app.use(express.json({ limit: "16kb" }));
  app.use(express.static(PUBLIC_DIR));

  const api = express.Router();

  // Optional shared password, so a public deployment can't be used by strangers.
  api.use((req, res, next) => {
    if (!password) return next();
    const given = req.get("x-app-password") ?? "";
    if (timingSafeEqual(digest(given), digest(password))) return next();
    res.status(401).json({ error: "Wrong password." });
  });

  api.get("/words", (req, res) => {
    res.json(db.listWords());
  });

  api.post("/words", async (req, res) => {
    const input = clean(req.body?.word).toLowerCase();
    if (!input || input.length > MAX_WORD) {
      return res.status(400).json({ error: "Enter a word up to 60 letters long." });
    }
    const known = db.findWord(input);
    if (known) return res.json({ ...known, existing: true });

    try {
      const entry = await lookup(input);
      const existing = db.findWord(entry.word);
      if (existing) return res.json({ ...existing, existing: true });
      res.status(201).json(db.addWord(entry));
    } catch (err) {
      if (err instanceof LookupError) return res.status(422).json({ error: err.message });
      console.error("Lookup failed:", err);
      res.status(502).json({ error: "Couldn't reach the dictionary service. Try again." });
    }
  });

  api.delete("/words/:id", (req, res) => {
    db.deleteWord(Number(req.params.id)) ? res.status(204).end() : notFound(res);
  });

  api.post("/words/:id/examples", (req, res) => {
    const id = Number(req.params.id);
    const text = clean(req.body?.text);
    if (!text || text.length > MAX_SENTENCE) {
      return res.status(400).json({ error: "Enter a sentence up to 400 characters long." });
    }
    if (!db.getWord(id)) return notFound(res);
    res.status(201).json(db.addExample(id, text));
  });

  api.delete("/examples/:id", (req, res) => {
    db.deleteExample(Number(req.params.id)) ? res.status(204).end() : notFound(res);
  });

  app.use("/api", api);
  return app;
}

function clean(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function notFound(res) {
  res.status(404).json({ error: "Not found." });
}
