import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "./app.js";
import { openDb } from "./db.js";
import { createLookup } from "./lookup.js";

const dataDir = process.env.DATA_DIR ?? "data";
mkdirSync(dataDir, { recursive: true });

const app = createApp({
  db: openDb(join(dataDir, "dictionary.db")),
  lookup: createLookup(),
  password: process.env.APP_PASSWORD ?? "",
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`Vazhe is running on http://localhost:${port}`));
