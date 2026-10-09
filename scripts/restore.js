// Puts a backup back as the dictionary database. Stop the server first.
//
//   npm run restore -- <backup file>

import { copyFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const [backup] = process.argv.slice(2);
if (!backup || !existsSync(backup)) {
  console.error(backup ? `There's no file at ${backup}.` : "Name the backup file to restore.");
  process.exit(1);
}
// Make sure it's a database this app can open before replacing anything.
try {
  const db = new DatabaseSync(backup, { readOnly: true });
  db.prepare("SELECT count(*) FROM words").get();
  db.close();
} catch {
  console.error(`${backup} isn't a Vazhe database.`);
  process.exit(1);
}
const target = join(process.env.DATA_DIR ?? "data", "dictionary.db");
// Leftover write-ahead files belong to the old database and would corrupt the restored one.
for (const extra of ["-wal", "-shm"]) if (existsSync(target + extra)) unlinkSync(target + extra);
copyFileSync(backup, target);
console.log(`Restored ${backup}. Start the app again.`);
