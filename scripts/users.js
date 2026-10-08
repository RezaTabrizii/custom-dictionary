// Manages accounts from the command line, for example when someone forgets
// their password (there's no email to reset it with).
//
//   npm run users                         lists the accounts
//   npm run users -- add <name>           creates an account
//   npm run users -- password <name>      sets a new password (signs them out everywhere)
//   npm run users -- delete <name>        deletes an account and its words

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { hashPassword, PASSWORD_MAX, PASSWORD_MIN, USERNAME } from "../src/auth.js";
import { openDb } from "../src/db.js";

const dataDir = process.env.DATA_DIR ?? "data";
mkdirSync(dataDir, { recursive: true });
const db = openDb(join(dataDir, "dictionary.db"));
const [command = "list", name = ""] = process.argv.slice(2);

// Asks a question; a password isn't shown while it's typed.
function ask(question, hidden = false) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = (s) => s.startsWith(question) && process.stdout.write(question);
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer);
    });
  });
}

async function askPassword() {
  const password = await ask("New password: ", true);
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    throw new Error(`Use a password of at least ${PASSWORD_MIN} characters.`);
  }
  if (password !== (await ask("Repeat it: ", true))) throw new Error("The passwords don't match.");
  return hashPassword(password);
}

function existing() {
  const user = db.userByName(name);
  if (!user) throw new Error(`There's no account called "${name}".`);
  return user;
}

try {
  if (command === "list") {
    const users = db.listUsers();
    if (!users.length) console.log("No accounts yet. Open the app to create the first one.");
    for (const u of users) console.log(`${u.username.padEnd(24)} ${String(u.words).padStart(5)} words   since ${u.created_at}`);
  } else if (command === "add") {
    if (!USERNAME.test(name)) throw new Error("Use 3 to 32 letters, numbers, dots, dashes or underscores.");
    if (db.userByName(name)) throw new Error(`"${name}" already exists.`);
    db.createUser(name, await askPassword());
    console.log(`Created "${name}".`);
  } else if (command === "password") {
    const user = existing();
    db.setPassword(user.id, await askPassword());
    db.deleteSessions(user.id);
    console.log(`Changed the password of "${user.username}" and signed them out everywhere.`);
  } else if (command === "delete") {
    const user = existing();
    if ((await ask(`Delete "${user.username}" and all their words? Type the name to confirm: `)) !== user.username) {
      throw new Error("Not deleted.");
    }
    db.deleteUser(user.id);
    console.log(`Deleted "${user.username}".`);
  } else {
    throw new Error(`Unknown command "${command}". Use list, add, password or delete.`);
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
