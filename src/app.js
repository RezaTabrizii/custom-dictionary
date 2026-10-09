import express from "express";
import { fileURLToPath } from "node:url";
import {
  createLimiter, hashPassword, newToken, PASSWORD_MAX, PASSWORD_MIN, sameSecret,
  tokenHash, USERNAME, verifyAgainstNothing, verifyPassword,
} from "./auth.js";
import { InvalidMove } from "./db.js";
import { LookupError, PARTS_OF_SPEECH } from "./lookup.js";

const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));
const MAX_WORD = 60;
const MAX_SENTENCE = 400;
const MAX_SENSES = 30;
const MAX_PERSIAN = 12; // meanings per sense
const MAX_MEANING = 80;
const MAX_GROUP_NAME = 60;

const COOKIE = "vazhe_session";
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;

// Page rules: only this site's own scripts, styles and fonts; recordings may come
// from the dictionaries' sites; nothing may frame the app.
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", "font-src 'self'",
  "img-src 'self' data:", "media-src 'self' https:", "connect-src 'self'",
  "manifest-src 'self'", "worker-src 'self'", "object-src 'none'", "base-uri 'none'",
  "form-action 'self'", "frame-ancestors 'none'",
].join("; ");

class TooManyLookups extends Error {}

// signupCode: the invite code new accounts need. Without one, only the first
// account can be created. trustProxy: Express's "trust proxy" setting, for
// running behind an https proxy (so cookies are marked Secure).
export function createApp({ db, lookup, signupCode = "", trustProxy = false }) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", trustProxy);

  app.use((req, res, next) => {
    res.set({
      "Content-Security-Policy": CSP,
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Permissions-Policy": "camera=(), geolocation=(), microphone=(self)",
    });
    if (req.secure) res.set("Strict-Transport-Security", "max-age=31536000");
    next();
  });
  // For Docker's health check and uptime monitors.
  app.get("/healthz", (req, res) => res.set("Cache-Control", "no-store").type("text").send("ok"));
  app.use(express.json({ limit: "16kb" }));
  app.use(express.static(PUBLIC_DIR));

  const api = express.Router();
  api.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  // Changes must come from this app's own pages: browsers mark requests from
  // other sites, and a JSON body can't be sent cross-site without permission.
  api.use((req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const site = req.get("sec-fetch-site");
    const origin = req.get("origin");
    let sameOrigin = !site || site === "same-origin" || site === "none";
    if (origin) {
      try {
        sameOrigin &&= new URL(origin).host === req.get("host");
      } catch {
        sameOrigin = false;
      }
    }
    if (!sameOrigin) return res.status(403).json({ error: "Requests from other sites aren't allowed." });
    if (!(req.get("content-type") ?? "").startsWith("application/json")) {
      return res.status(415).json({ error: "Send JSON." });
    }
    next();
  });

  /* ---------- Sessions ---------- */

  const setCookie = (req, res, value, maxAgeMs) => {
    const parts = [`${COOKIE}=${value}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
    if (req.secure) parts.push("Secure");
    res.append("Set-Cookie", parts.join("; "));
  };

  const startSession = (req, res, userId) => {
    if (req.sessionHash) db.deleteSession(req.sessionHash);
    const token = newToken();
    db.createSession(tokenHash(token), userId, Date.now() + SESSION_MS);
    setCookie(req, res, token, SESSION_MS);
  };

  // Finds the signed-in user from the session cookie, and keeps an active
  // session from expiring.
  api.use((req, res, next) => {
    const token = cookie(req, COOKIE);
    if (!token) return next();
    const hash = tokenHash(token);
    const session = db.session(hash);
    if (!session) return next();
    req.sessionHash = hash;
    req.user = { id: session.userId, username: session.username };
    if (session.expiresAt - Date.now() < SESSION_MS / 2) {
      db.extendSession(hash, Date.now() + SESSION_MS);
      setCookie(req, res, token, SESSION_MS);
    }
    next();
  });

  /* ---------- Accounts ---------- */

  const limits = {
    loginIp: createLimiter({ max: 20, windowMs: 15 * MINUTE }), // failed sign-ins per address
    loginUser: createLimiter({ max: 10, windowMs: 15 * MINUTE }), // failed sign-ins per username
    signupIp: createLimiter({ max: 5, windowMs: 60 * MINUTE }), // sign-up attempts per address
    password: createLimiter({ max: 10, windowMs: 15 * MINUTE }), // wrong current passwords per user
    lookups: createLimiter({ max: 150, windowMs: 60 * MINUTE }), // dictionary lookups per user
  };
  const tooMany = (res, seconds) => {
    res.set("Retry-After", String(seconds));
    res.status(429).json({ error: `Too many attempts. Try again in ${Math.ceil(seconds / 60)} minute(s).` });
  };

  const signupMode = () => (signupCode ? "code" : db.userCount() === 0 ? "open" : "closed");

  const checkNewPassword = (password, username) => {
    if (typeof password !== "string" || password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
      return `Use a password of at least ${PASSWORD_MIN} characters.`;
    }
    if (password.toLowerCase() === username.toLowerCase()) return "Your password can't be your username.";
    return null;
  };

  api.get("/auth/status", (req, res) => {
    res.json({ user: req.user ? { username: req.user.username } : null, signup: signupMode() });
  });

  api.post("/auth/signup", async (req, res) => {
    const wait = limits.signupIp.wait(req.ip);
    if (wait) return tooMany(res, wait);
    limits.signupIp.hit(req.ip);

    const mode = signupMode();
    if (mode === "closed") return res.status(403).json({ error: "Sign-up is closed. Ask the owner for an invite code." });
    if (mode === "code" && !sameSecret(req.body?.code ?? "", signupCode)) {
      return res.status(403).json({ error: "That invite code isn't right." });
    }
    const username = clean(req.body?.username);
    if (!USERNAME.test(username)) {
      return res.status(400).json({ error: "Use 3 to 32 letters, numbers, dots, dashes or underscores for your username." });
    }
    const problem = checkNewPassword(req.body?.password, username);
    if (problem) return res.status(400).json({ error: problem });
    if (db.userByName(username)) return res.status(409).json({ error: "That username is taken." });

    const hash = await hashPassword(req.body.password);
    let id;
    try {
      id = db.createUser(username, hash);
    } catch {
      return res.status(409).json({ error: "That username is taken." });
    }
    startSession(req, res, id);
    res.status(201).json({ user: { username } });
  });

  api.post("/auth/login", async (req, res) => {
    const username = clean(req.body?.username).toLowerCase();
    const password = typeof req.body?.password === "string" ? req.body.password.slice(0, PASSWORD_MAX) : "";
    const wait = Math.max(limits.loginIp.wait(req.ip), limits.loginUser.wait(username));
    if (wait) return tooMany(res, wait);

    const user = USERNAME.test(username) ? db.userByName(username) : null;
    const ok = user ? await verifyPassword(password, user.password_hash) : await verifyAgainstNothing(password);
    if (!ok) {
      limits.loginIp.hit(req.ip);
      limits.loginUser.hit(username);
      return res.status(401).json({ error: "Wrong username or password." });
    }
    limits.loginUser.reset(username);
    startSession(req, res, user.id);
    res.json({ user: { username: user.username } });
  });

  api.post("/auth/logout", (req, res) => {
    if (req.sessionHash) db.deleteSession(req.sessionHash);
    setCookie(req, res, "", 0);
    res.status(204).end();
  });

  // Everything below needs a signed-in user, and works on their own dictionary.
  api.use((req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Sign in to continue." });
    req.store = db.forUser(req.user.id);
    next();
  });

  // Changes the password and signs out every other session.
  api.post("/auth/password", async (req, res) => {
    const key = String(req.user.id);
    const wait = limits.password.wait(key);
    if (wait) return tooMany(res, wait);
    const user = db.userById(req.user.id);
    const current = typeof req.body?.current === "string" ? req.body.current.slice(0, PASSWORD_MAX) : "";
    if (!(await verifyPassword(current, user.password_hash))) {
      limits.password.hit(key);
      return res.status(403).json({ error: "Your current password isn't right." });
    }
    const problem = checkNewPassword(req.body?.password, user.username);
    if (problem) return res.status(400).json({ error: problem });
    db.setPassword(user.id, await hashPassword(req.body.password));
    db.deleteSessions(user.id, req.sessionHash);
    res.status(204).end();
  });

  // Each lookup may cost money (Claude) or lean on free services, so each
  // person has an hourly allowance.
  const lookupFor = (req) => async (word) => {
    const key = String(req.user.id);
    if (limits.lookups.wait(key)) throw new TooManyLookups();
    limits.lookups.hit(key);
    return lookup(word);
  };

  /* ---------- Words ---------- */

  api.get("/words", (req, res) => {
    res.json(req.store.listWords());
  });

  api.post("/words", async (req, res) => {
    const input = clean(req.body?.word).toLowerCase();
    if (!input || input.length > MAX_WORD) {
      return res.status(400).json({ error: "Enter a word up to 60 letters long." });
    }
    const store = req.store;
    const known = store.findWord(input);
    if (known) return res.json({ ...known, existing: true });

    try {
      const entry = await lookupFor(req)(input);
      const existing = store.findWord(entry.word);
      if (existing) return res.json({ ...existing, existing: true });
      const word = store.addWord(entry);
      // Other forms of the word (quick -> quickly, quickness): the client then
      // asks POST /words/:id/family to add the missing ones and group them.
      res.status(201).json({ ...word, ...familyOf(store, word.word) });
    } catch (err) {
      if (err instanceof LookupError) return res.status(422).json({ error: err.message });
      if (err instanceof TooManyLookups) {
        return res.status(429).json({ error: "You've looked up a lot of words in the last hour. Try again later." });
      }
      console.error("Lookup failed:", err);
      res.status(502).json({ error: "Couldn't reach the dictionary service. Try again." });
    }
  });

  // A word's family: whether it has one, the relatives to add, and those
  // skipped because the person deleted them before.
  const familyOf = (store, word) => {
    const { members } = db.wordFamily(word);
    const missing = members.filter((m) => !store.findWord(m));
    return {
      hasFamily: members.length > 0,
      related: missing.filter((m) => !store.isDismissed(m)),
      skipped: missing.filter((m) => store.isDismissed(m)),
    };
  };

  // Adds the missing other forms of a word and groups the family. Words the
  // user deleted are skipped unless listed in `include`.
  api.post("/words/:id/family", async (req, res) => {
    const store = req.store;
    const word = store.getWord(Number(req.params.id));
    if (!word) return notFound(res);
    const { name, members } = db.wordFamily(word.word);
    const include = new Set(Array.isArray(req.body?.include) ? req.body.include : []);

    const added = [];
    const failed = [];
    for (const m of members.filter((x) => !store.findWord(x) && (include.has(x) || !store.isDismissed(x)))) {
      try {
        const entry = await lookupFor(req)(m);
        // A lookup can answer with a word that's already saved (its base form).
        if (!store.findWord(entry.word)) added.push(store.addWord(entry));
      } catch (err) {
        console.error(`Couldn't add "${m}": ${err.message}`);
        failed.push(m);
      }
    }

    const saved = [word.word, ...members].map((m) => store.findWord(m)).filter(Boolean);
    const groupId = saved.length >= 2 ? store.groupFamily(saved.map((w) => w.id), name) : null;
    res.json({
      added: added.map((w) => store.getWord(w.id)),
      failed,
      skipped: familyOf(store, word.word).skipped,
      groupId,
      ...store.tree(),
    });
  });

  api.delete("/words/:id", (req, res) => {
    req.store.deleteWord(Number(req.params.id)) ? res.status(204).end() : notFound(res);
  });

  api.post("/words/:id/examples", (req, res) => {
    const id = Number(req.params.id);
    const text = clean(req.body?.text);
    if (!text || text.length > MAX_SENTENCE) {
      return res.status(400).json({ error: "Enter a sentence up to 400 characters long." });
    }
    const word = req.store.addExample(id, text);
    word ? res.status(201).json(word) : notFound(res);
  });

  // Saves the user's edits: their own Persian meanings, word types, definitions
  // and examples. The client sends the word's whole list of meanings.
  api.put("/words/:id/senses", (req, res) => {
    const senses = parseSenses(req.body?.senses);
    if (!senses) return res.status(400).json({ error: "Each meaning needs a Persian meaning or a definition." });
    const word = req.store.updateSenses(Number(req.params.id), senses);
    word ? res.json(word) : notFound(res);
  });

  /* ---------- Groups ---------- */

  // Every change to the groups answers with the whole tree: the groups, and
  // which group each word is in.
  const changeTree = (req, res, change) => {
    try {
      const result = change(req.store);
      res.json({ ...req.store.tree(), ...result });
    } catch (err) {
      if (!(err instanceof InvalidMove)) throw err;
      res.status(400).json({ error: err.message });
    }
  };

  api.get("/tree", (req, res) => {
    res.json(req.store.tree());
  });

  // Makes a group from a word or group dropped onto a word.
  api.post("/groups", (req, res) => {
    const name = clean(req.body?.name) || "New group";
    const parentId = groupRef(req.body?.parentId);
    const items = Array.isArray(req.body?.items) ? req.body.items.map(itemRef) : [];
    if (name.length > MAX_GROUP_NAME || parentId === undefined || items.length < 1 || items.includes(null)) {
      return res.status(400).json({ error: "Couldn't make that group." });
    }
    changeTree(req, res, (store) => ({ created: store.createGroup(name, parentId, items) }));
  });

  // Renames a group, or moves it into another group (parentId, null for the top level).
  api.patch("/groups/:id", (req, res) => {
    const id = Number(req.params.id);
    const body = req.body ?? {};
    changeTree(req, res, (store) => {
      if ("name" in body) {
        const name = clean(body.name);
        if (!name || name.length > MAX_GROUP_NAME) throw new InvalidMove("Give the group a name up to 60 letters long.");
        store.renameGroup(id, name);
      }
      if ("parentId" in body) {
        const parentId = groupRef(body.parentId);
        if (parentId === undefined) throw new InvalidMove("That group doesn't exist.");
        store.move({ kind: "group", id }, parentId);
      }
    });
  });

  // Removes a group but keeps what's in it, one level up.
  api.delete("/groups/:id", (req, res) => {
    changeTree(req, res, (store) => store.ungroup(Number(req.params.id)));
  });

  api.put("/words/:id/group", (req, res) => {
    const groupId = groupRef(req.body?.groupId);
    if (groupId === undefined) return res.status(400).json({ error: "That group doesn't exist." });
    changeTree(req, res, (store) => store.move({ kind: "word", id: Number(req.params.id) }, groupId));
  });

  api.delete("/examples/:id", (req, res) => {
    req.store.deleteExample(Number(req.params.id)) ? res.status(204).end() : notFound(res);
  });

  app.use("/api", api);

  // Errors are logged here, never sent to the browser with their details.
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status ?? err.statusCode ?? 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? "Something went wrong. Try again." : "That request isn't valid." });
  });
  return app;
}

// One cookie's value from the request.
function cookie(req, name) {
  for (const part of (req.get("cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return "";
}

function clean(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

// A group id, null for the top level, or undefined when it isn't valid.
function groupRef(value) {
  if (value === null || value === undefined) return null;
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

// { kind, id } of a word or group from the request, or null.
function itemRef(value) {
  return ["word", "group"].includes(value?.kind) && Number.isInteger(value?.id) ? { kind: value.kind, id: value.id } : null;
}

// A valid list of senses from the request, or null.
function parseSenses(input) {
  if (!Array.isArray(input) || input.length > MAX_SENSES) return null;
  const senses = input.map((s) => ({
    partOfSpeech: PARTS_OF_SPEECH.includes(s?.partOfSpeech) ? s.partOfSpeech : "other",
    persian: Array.isArray(s?.persian) ? s.persian.map(clean).filter(Boolean) : [],
    definition: clean(s?.definition),
    example: clean(s?.example),
  }));
  const valid = senses.every((s) =>
    (s.persian.length || s.definition) &&
    s.persian.length <= MAX_PERSIAN &&
    s.persian.every((p) => p.length <= MAX_MEANING) &&
    s.definition.length <= MAX_SENTENCE &&
    s.example.length <= MAX_SENTENCE);
  return valid ? senses : null;
}

function notFound(res) {
  res.status(404).json({ error: "Not found." });
}
