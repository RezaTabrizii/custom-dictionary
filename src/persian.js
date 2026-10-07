// Persian meanings are stored without vowel marks, with Persian letter forms,
// so the same word isn't listed twice and search finds it however it's typed.
// Bump CLEANUP_VERSION when cleanPersian changes, so stored data is cleaned again.
export const CLEANUP_VERSION = "1";

const MARKS = /[ً-ٰٟۖ-ۭـ]/g; // harakat, superscript alef, Quranic marks, tatweel

export function cleanPersianWord(word) {
  return word
    .replace(MARKS, "")
    .replace(/ي/g, "ی") // Arabic yeh -> Persian yeh
    .replace(/ك/g, "ک") // Arabic kaf -> Persian keheh
    .replace(/\s+/g, " ")
    .trim();
}

export function cleanPersian(words) {
  return [...new Set(words.map(cleanPersianWord).filter(Boolean))];
}

export function cleanSenses(senses) {
  return senses.map((s) => ({ ...s, persian: cleanPersian(s.persian) }));
}
