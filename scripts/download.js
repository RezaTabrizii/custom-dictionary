import { createWriteStream, existsSync, renameSync, statSync } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const MB = 1024 * 1024;

// Downloads a large file to `dest`, resuming where it stopped when the
// connection drops, and checks that the whole file arrived.
export async function download(url, dest, { attempts = 8, retryDelayMs = 2000, log = console.log } = {}) {
  if (existsSync(dest)) {
    log(`Using the already downloaded ${dest}`);
    return;
  }
  const part = `${dest}.part`;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let start = existsSync(part) ? statSync(part).size : 0;
    try {
      const res = await fetch(url, {
        headers: { "accept-encoding": "identity", ...(start ? { range: `bytes=${start}-` } : {}) },
      });
      if (res.status === 416) break; // the partial file is already complete
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (start && res.status !== 206) start = 0; // the server can't resume; start over

      const total = res.status === 206
        ? Number(res.headers.get("content-range")?.split("/")[1]) || 0
        : Number(res.headers.get("content-length")) || 0;
      log(start
        ? `Resuming at ${Math.round(start / MB)} MB of ${Math.round(total / MB)} MB`
        : `Downloading ${url}${total ? ` (${Math.round(total / MB)} MB)` : ""}`);

      let received = start;
      let nextReport = received + 200 * MB;
      const progress = new Transform({
        transform(chunk, _enc, done) {
          received += chunk.length;
          if (received >= nextReport) {
            log(`  ${Math.round(received / MB)} MB${total ? ` of ${Math.round(total / MB)} MB` : ""}`);
            nextReport += 200 * MB;
          }
          done(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(res.body), progress, createWriteStream(part, { flags: start ? "a" : "w" }));

      const size = statSync(part).size;
      if (total && size < total) throw new Error(`stopped at ${Math.round(size / MB)} MB`);
      break;
    } catch (err) {
      if (attempt === attempts) throw new Error(`Download failed after ${attempts} attempts: ${err.message}`);
      log(`  Connection problem (${err.message}); retrying...`);
      await new Promise((r) => setTimeout(r, retryDelayMs * attempt));
    }
  }
  renameSync(part, dest);
}
