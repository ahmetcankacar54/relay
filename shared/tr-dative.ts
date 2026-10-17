const APOSTROPHE = "’";
const BACK = "aıou";
const FRONT = "eiöü";
const VOWELS = BACK + FRONT;

/** How Turkish says a digit, reduced to what the dative needs. */
const DIGIT: Record<string, { vowel: string; endsInVowel: boolean }> = {
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
    const digit = DIGIT[char];
    const letter = /\p{L}/u.test(char);
    if (!digit && !letter) continue;
    last ??= i;
    const found = digit
      ? digit.vowel
      : VOWELS.includes(char)
        ? char
        : undefined;
    if (!found) continue;
    vowel = found;
    // A buffer "y" only matters when the word ends right in this vowel.
    endsInVowel = digit ? digit.endsInVowel && i === last : i === last;
    break;
  }
  const suffix = vowel && BACK.includes(vowel) ? "a" : "e";
  return `${name}${APOSTROPHE}${endsInVowel ? "y" : ""}${suffix}`;
}
