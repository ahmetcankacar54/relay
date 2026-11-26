//! Port of `shared/tr-dative.ts`: the Turkish dative of a name and the locative of a clock.

const APOSTROPHE: char = '’';
const BACK: &str = "aıou";
const FRONT: &str = "eiöü";

fn is_vowel(c: char) -> bool {
    BACK.contains(c) || FRONT.contains(c)
}

#[derive(Clone, Copy)]
struct Reading {
    vowel: char,
    ends_in_vowel: bool,
}

const fn reading(vowel: char, ends_in_vowel: bool) -> Reading {
    Reading {
        vowel,
        ends_in_vowel,
    }
}

/// How Turkish says a digit, reduced to what the dative needs.
fn digit(c: char) -> Option<Reading> {
    Some(match c {
        '0' => reading('ı', false), // sıfır
        '1' => reading('i', false), // bir
        '2' => reading('i', true),  // iki
        '3' => reading('ü', false), // üç
        '4' => reading('ö', false), // dört
        '5' => reading('e', false), // beş
        '6' => reading('ı', true),  // altı
        '7' => reading('i', true),  // yedi
        '8' => reading('i', false), // sekiz
        '9' => reading('u', false), // dokuz
        _ => return None,
    })
}

/// The tens a round number ends in, read as the Turkish word.
fn tens(c: char) -> Option<Reading> {
    Some(match c {
        '1' => reading('o', false), // on
        '2' => reading('i', true),  // yirmi
        '3' => reading('u', false), // otuz
        '4' => reading('ı', false), // kırk
        '5' => reading('i', true),  // elli
        '6' => reading('ı', false), // altmış
        '7' => reading('i', false), // yetmiş
        '8' => reading('e', false), // seksen
        '9' => reading('a', false), // doksan
        _ => return None,
    })
}

const THOUSAND: Reading = reading('i', false); // bin
const HUNDRED: Reading = reading('ü', false); // yüz

/// How Turkish ends a whole number: "20" is yirmi, "100" yüz, "1000" bin.
fn read_number(digits: &[char]) -> Reading {
    let text: String = digits.iter().collect();
    if text.ends_with("000") {
        return THOUSAND;
    }
    if text.ends_with("00") {
        return HUNDRED;
    }
    let last = digits[digits.len() - 1];
    let ten = digits.len().checked_sub(2).map(|i| digits[i]);
    if let Some(ten) = ten.filter(|t| last == '0' && *t != '0') {
        return tens(ten).expect("a digit");
    }
    digit(last).expect("a digit")
}

/// Dotted "İ" and dotless "I" first, so the default lowercasing cannot mix them up. Returns the
/// lowercase as JavaScript's `toLowerCase` would, which may be more than one character.
fn lower(c: char) -> String {
    match c {
        'İ' => "i".into(),
        'I' => "ı".into(),
        _ => c.to_lowercase().collect(),
    }
}

/// `\p{L}` tested on a (lowercased) string: true when any of it is a letter.
fn is_letter(text: &str) -> bool {
    text.chars()
        .any(|c| c.is_alphabetic() && !is_alphabetic_non_letter(c))
}
fn is_alphabetic_non_letter(c: char) -> bool {
    // Nl (letter numbers) and the alphabetic combining marks (Mn/Mc with Other_Alphabetic).
    matches!(c, '\u{16EE}'..='\u{16F0}' | '\u{2160}'..='\u{2188}' | '\u{3007}' | '\u{3021}'..='\u{3029}' | '\u{3038}'..='\u{303A}' | '\u{A6E6}'..='\u{A6EF}')
        || unicode_normalization::char::is_combining_mark(c)
}

/// A name with the Turkish dative, for "Kişisel’e geç". The last vowel picks the suffix by
/// harmony and a name ending in a vowel gets a buffer "y". A digit is read the way it is spoken,
/// and trailing symbols are skipped. A name with no vowel at all takes "e".
pub fn with_dative(name: &str) -> String {
    let chars: Vec<char> = name.chars().collect();
    let mut last: Option<usize> = None;
    let mut vowel: Option<char> = None;
    let mut ends_in_vowel = false;
    let mut i = chars.len();
    while i > 0 {
        i -= 1;
        let lowered = lower(chars[i]);
        let single = {
            let mut it = lowered.chars();
            match (it.next(), it.next()) {
                (Some(c), None) => Some(c),
                _ => None,
            }
        };
        let is_digit = single.and_then(digit).is_some();
        if !is_digit && !is_letter(&lowered) {
            continue;
        }
        if last.is_none() {
            last = Some(i);
        }
        let end = i;
        let mut found: Option<Reading> = None;
        if is_digit {
            // The whole number is read at once, so "20" is yirmi, not iki sıfır.
            let mut from = i;
            while from > 0 && digit(chars[from - 1]).is_some() {
                from -= 1;
            }
            found = Some(read_number(&chars[from..=i]));
            i = from;
        } else if let Some(c) = single.filter(|c| is_vowel(*c)) {
            found = Some(reading(c, true));
        }
        let Some(found) = found else { continue };
        vowel = Some(found.vowel);
        // A buffer "y" only matters when the word ends right in this vowel.
        ends_in_vowel = found.ends_in_vowel && Some(end) == last;
        break;
    }
    let suffix = if vowel.is_some_and(|v| BACK.contains(v)) {
        'a'
    } else {
        'e'
    };
    let buffer = if ends_in_vowel { "y" } else { "" };
    format!("{name}{APOSTROPHE}{buffer}{suffix}")
}

/// How Turkish says 0–59 on a clock, as far as the suffix needs: the last word.
const ONES: [&str; 10] = [
    "sıfır", "bir", "iki", "üç", "dört", "beş", "altı", "yedi", "sekiz", "dokuz",
];
const TEN_WORDS: [&str; 6] = ["", "on", "yirmi", "otuz", "kırk", "elli"];

fn last_word(n: u32) -> Option<&'static str> {
    if n % 10 == 0 && n > 0 {
        TEN_WORDS.get((n / 10) as usize).copied()
    } else {
        Some(ONES[(n % 10) as usize])
    }
}

/// A clock with the Turkish locative, for "14:00’te açılır". The clock is read as it is spoken:
/// the hour when the minutes are zero, else the minutes. Anything that is not a clock comes back
/// unchanged.
pub fn clock_locative(clock: &str) -> String {
    let Some((hour, minutes)) = parse_clock(clock) else {
        return clock.to_string();
    };
    let word = match last_word(if minutes == 0 { hour } else { minutes }) {
        Some(word) if !word.is_empty() => word,
        _ => return clock.to_string(),
    };
    let vowel = word.chars().rev().find(|c| is_vowel(*c)).unwrap_or('e');
    let hard = word.chars().last().is_some_and(|c| "çfhkpsşt".contains(c));
    let first = if hard { 't' } else { 'd' };
    let second = if BACK.contains(vowel) { 'a' } else { 'e' };
    format!("{clock}{APOSTROPHE}{first}{second}")
}

/// `/^(\d{1,2})[:.](\d{2})$/`.
fn parse_clock(clock: &str) -> Option<(u32, u32)> {
    let b = clock.as_bytes();
    let sep = b.iter().position(|c| *c == b':' || *c == b'.')?;
    let (h, m) = (&b[..sep], &b[sep + 1..]);
    if !(1..=2).contains(&h.len()) || m.len() != 2 || !h.iter().chain(m).all(u8::is_ascii_digit) {
        return None;
    }
    let num = |d: &[u8]| d.iter().fold(0u32, |n, c| n * 10 + u32::from(c - b'0'));
    Some((num(h), num(m)))
}
