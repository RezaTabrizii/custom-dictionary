import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

// Persian meanings are stored without vowel marks, with Persian letter forms,
// so the same word isn't listed twice and search finds it however it's typed.

// Half-spaces the offline lexicon lost ("خواهش میکنم" -> "خواهش می‌کنم"):
// one word per line, as it was stored and as it's spelled.
const HALFSPACE_FILE = new URL("../lexicon/halfspace.tsv", import.meta.url);
const halfspaceText = existsSync(HALFSPACE_FILE) ? readFileSync(HALFSPACE_FILE, "utf8") : "";
const HALFSPACE = new Map(halfspaceText.split("\n")
  .filter((l) => l.trim() && !l.startsWith("#"))
  .map((l) => l.split("\t").map((x) => x.trim())));

// Bump the number when cleanPersian changes, so stored data is cleaned again;
// a change to the half-space file does the same.
export const CLEANUP_VERSION = `2:${createHash("sha256").update(halfspaceText).digest("hex").slice(0, 16)}`;

const MARKS = /[ً-ٰٟۖ-ۭـ]/g; // harakat, superscript alef, Quranic marks, tatweel

export function cleanPersianWord(word) {
  return word
    .replace(MARKS, "")
    .replace(/ي/g, "ی") // Arabic yeh -> Persian yeh
    .replace(/ك/g, "ک") // Arabic kaf -> Persian keheh
    .replace(/ٱ/g, "ا") // alef wasla -> alef
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((w) => HALFSPACE.get(w) ?? w)
    .join(" ");
}

export function cleanPersian(words) {
  return [...new Set(words.map(cleanPersianWord).filter(Boolean))];
}

export function cleanSenses(senses) {
  return senses.map((s) => ({ ...s, persian: cleanPersian(s.persian) }));
}
