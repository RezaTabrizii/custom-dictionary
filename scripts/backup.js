// Saves a copy of the dictionary database, safe to run while the server is running.
//
//   npm run backup                 writes data/backups/dictionary-<date>.db
//   npm run backup -- <file>       writes to that file

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { openDb } from "../src/db.js";

const dataDir = process.env.DATA_DIR ?? "data";
const source = join(dataDir, "dictionary.db");
if (!existsSync(source)) {
  console.error(`There's no database at ${source} yet.`);
  process.exit(1);
}
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
const target = process.argv[2] ?? join(dataDir, "backups", `dictionary-${stamp}.db`);
if (existsSync(target)) {
  console.error(`${target} already exists.`);
  process.exit(1);
}
mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
const db = openDb(source);
db.backup(target);
db.close();
console.log(`Saved a backup to ${target}`);
