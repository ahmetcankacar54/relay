const APOSTROPHE = "’";
const BACK = "aıou";
const FRONT = "eiöü";
const VOWELS = BACK + FRONT;

type Reading = { vowel: string; endsInVowel: boolean };

/** How Turkish says a digit, reduced to what the dative needs. */
const DIGIT: Record<string, Reading> = {
  "0": { vowel: "ı", endsInVowel: false }, // sıfır
  "1": { vowel: "i", endsInVowel: false }, // bir
  "2": { vowel: "i", endsInVowel: true }, // iki
  "3": { vowel: "ü", endsInVowel: false }, // üç
  "4": { vowel: "ö", endsInVowel: false }, // dört
  "5": { vowel: "e", endsInVowel: false }, // beş
  "6": { vowel: "ı", endsInVowel: true }, // altı
  "7": { vowel: "i", endsInVowel: true }, // yedi
  "8": { vowel: "i", endsInVowel: false }, // sekiz
  "9": { vowel: "u", endsInVowel: false }, // dokuz
};

/** The tens a round number ends in, read as the Turkish word. */
const TENS: Record<string, Reading> = {
  "1": { vowel: "o", endsInVowel: false }, // on
  "2": { vowel: "i", endsInVowel: true }, // yirmi
  "3": { vowel: "u", endsInVowel: false }, // otuz
  "4": { vowel: "ı", endsInVowel: false }, // kırk
  "5": { vowel: "i", endsInVowel: true }, // elli
  "6": { vowel: "ı", endsInVowel: false }, // altmış
  "7": { vowel: "i", endsInVowel: false }, // yetmiş
  "8": { vowel: "e", endsInVowel: false }, // seksen
  "9": { vowel: "a", endsInVowel: false }, // doksan
};
const THOUSAND: Reading = { vowel: "i", endsInVowel: false }; // bin
const HUNDRED: Reading = { vowel: "ü", endsInVowel: false }; // yüz

/** How Turkish ends a whole number: "20" is yirmi, "100" yüz, "1000" bin. */
function readNumber(digits: string): Reading {
  if (digits.endsWith("000")) return THOUSAND;
  if (digits.endsWith("00")) return HUNDRED;
  const last = digits.at(-1)!;
  const tens = digits.at(-2);
  if (last === "0" && tens && tens !== "0") return TENS[tens];
  return DIGIT[last];
}

/** Dotted "İ" and dotless "I" first, so the default lowercasing cannot mix them up. */
function lower(char: string) {
  if (char === "İ") return "i";
  if (char === "I") return "ı";
  return char.toLowerCase();
}

/**
 * A name with the Turkish dative, for "Kişisel’e geç". The last vowel picks
 * the suffix by harmony (a ı o u → a, e i ö ü → e) and a name ending in a
 * vowel gets a buffer "y". A digit is read the way it is spoken, and trailing
 * symbols are skipped. A name with no vowel at all takes "e".
 */
export function withDative(name: string): string {
  const chars = [...name];
  let last: number | undefined;
  let vowel: string | undefined;
  let endsInVowel = false;
  for (let i = chars.length - 1; i >= 0; i--) {
    const char = lower(chars[i]);
    const isDigit = Object.hasOwn(DIGIT, char);
    if (!isDigit && !/\p{L}/u.test(char)) continue;
    last ??= i;
    const end = i;
    let reading: Reading | undefined;
    if (isDigit) {
      // The whole number is read at once, so "20" is yirmi, not iki sıfır.
      let from = i;
      while (from > 0 && Object.hasOwn(DIGIT, chars[from - 1])) from--;
      reading = readNumber(chars.slice(from, i + 1).join(""));
      i = from;
    } else if (VOWELS.includes(char)) {
      reading = { vowel: char, endsInVowel: true };
    }
    if (!reading) continue;
    vowel = reading.vowel;
    // A buffer "y" only matters when the word ends right in this vowel.
    endsInVowel = reading.endsInVowel && end === last;
    break;
  }
  const suffix = vowel && BACK.includes(vowel) ? "a" : "e";
  return `${name}${APOSTROPHE}${endsInVowel ? "y" : ""}${suffix}`;
}
