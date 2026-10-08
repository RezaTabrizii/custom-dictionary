import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

// Passwords are stored as scrypt hashes with a random salt per password:
// "scrypt$N$r$p$salt$hash" (base64). Stronger settings later still verify old hashes.
const scryptAsync = promisify(scrypt);
const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const maxmem = (n, r) => 256 * n * r; // twice what scrypt needs

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200; // hashing very long input would be slow on purpose
export const USERNAME = /^[a-z0-9][a-z0-9_.-]{2,31}$/i;

const derive = (password, salt, n, r, p) =>
  scryptAsync(password.normalize("NFKC"), salt, KEY_LENGTH, { N: n, r, p, maxmem: maxmem(n, r) });

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await derive(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password, stored) {
  const [kind, n, r, p, salt, hash] = String(stored).split("$");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = await derive(password, Buffer.from(salt, "base64"), Number(n), Number(r), Number(p));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Checked against when the username doesn't exist, so a wrong username takes
// as long as a wrong password and doesn't reveal which accounts exist.
let dummyHash = null;
export async function verifyAgainstNothing(password) {
  dummyHash ??= await hashPassword(randomBytes(16).toString("hex"));
  await verifyPassword(password, dummyHash);
  return false;
}

// Session tokens: 256 random bits for the cookie; only their SHA-256 is stored.
export const newToken = () => randomBytes(32).toString("base64url");
export const tokenHash = (token) => createHash("sha256").update(token).digest("hex");

// Compares two secrets in constant time, whatever their lengths.
export function sameSecret(a, b) {
  const digest = (s) => createHash("sha256").update(String(s)).digest();
  return timingSafeEqual(digest(a), digest(b));
}

// Counts attempts per key (an IP address, a username) in a time window.
// wait() is 0 while under the limit, otherwise the seconds until it resets.
export function createLimiter({ max, windowMs }) {
  const hits = new Map();
  const current = (key) => {
    const entry = hits.get(key);
    return entry && entry.reset > Date.now() ? entry : null;
  };
  return {
    wait(key) {
      const entry = current(key);
      return entry && entry.count >= max ? Math.ceil((entry.reset - Date.now()) / 1000) : 0;
    },
    hit(key) {
      if (hits.size > 10_000) {
        for (const [k, v] of hits) if (v.reset <= Date.now()) hits.delete(k);
      }
      const entry = current(key) ?? { count: 0, reset: Date.now() + windowMs };
      entry.count++;
      hits.set(key, entry);
    },
    reset(key) {
      hits.delete(key);
    },
  };
}
