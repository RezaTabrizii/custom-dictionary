import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { download } from "../scripts/download.js";

const BODY = Buffer.from(Array.from({ length: 2000 }, (_, i) => `{"word":"w${i}","text":"دویدن"}\n`).join(""));

// Serves BODY with Range support, but drops the first connection halfway.
function flakyServer({ ranges = true } = {}) {
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    const m = ranges && /bytes=(\d+)-/.exec(req.headers.range ?? "");
    const start = m ? Number(m[1]) : 0;
    const chunk = BODY.subarray(start);
    res.writeHead(m ? 206 : 200, {
      "content-length": chunk.length,
      ...(m ? { "content-range": `bytes ${start}-${BODY.length - 1}/${BODY.length}` } : {}),
    });
    if (requests === 1) {
      res.write(chunk.subarray(0, 25_000));
      setTimeout(() => res.socket.destroy(), 20);
    } else {
      res.end(chunk);
    }
  });
  return new Promise((r) => server.listen(0, () => r({ server, url: `http://localhost:${server.address().port}/f`, count: () => requests })));
}

for (const ranges of [true, false]) {
  test(`a dropped connection ${ranges ? "resumes" : "restarts"} and the file arrives whole`, async () => {
    const { server, url, count } = await flakyServer({ ranges });
    const dest = join(mkdtempSync(join(tmpdir(), "dl-")), "f.jsonl");
    try {
      await download(url, dest, { retryDelayMs: 10, log: () => {} });
      assert.ok(readFileSync(dest).equals(BODY));
      assert.equal(count(), 2);
    } finally {
      server.close();
    }
  });
}

test("a truncated line is skipped, not fatal", async () => {
  const { buildLexicon } = await import("../src/lexicon.js");
  const stats = {};
  const out = [];
  for await (const r of buildLexicon(['{"word":"x","lang_code":"en","pos":"noun"}', '{"word":"run","sen'], stats)) out.push(r);
  assert.equal(stats.badLines, 1);
});
