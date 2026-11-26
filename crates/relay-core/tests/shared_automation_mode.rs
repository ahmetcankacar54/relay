//! Port of the `shared/tr-dative` (`withDative`) cases of tests/automation-mode.test.ts. The
//! `shared/automation-mode` cases belong to that module's port.

use relay_core::shared::tr_dative::with_dative;

#[test]
fn turkish_dative_follows_vowel_harmony_buffer_y_and_digit_readings() {
    let cases = [
        ("Ki\u{15f}isel", "Ki\u{15f}isel\u{2019}e"),
        ("Alto", "Alto\u{2019}ya"),
        (
            "Ki\u{15f}isel \u{b7} \u{130}kinci",
            "Ki\u{15f}isel \u{b7} \u{130}kinci\u{2019}ye",
        ),
        ("Studio", "Studio\u{2019}ya"),
        (
            "Dan\u{131}\u{15f}manl\u{131}k",
            "Dan\u{131}\u{15f}manl\u{131}k\u{2019}a",
        ),
        ("Vertex", "Vertex\u{2019}e"),
        ("Max", "Max\u{2019}a"),
        ("Team 2", "Team 2\u{2019}ye"),
        ("Pro 6", "Pro 6\u{2019}ya"),
        ("Max 5\u{d7}", "Max 5\u{d7}\u{2019}e"),
        ("XYZ", "XYZ\u{2019}e"),
    ];
    for (name, dative) in cases {
        assert_eq!(with_dative(name), dative, "{name}");
    }
}

#[test]
fn the_dative_reads_the_other_digits_the_turkish_capitals_and_trailing_marks() {
    let cases = [
        ("Hat 0", "Hat 0\u{2019}a"),                         // sıfır
        ("Hat 1", "Hat 1\u{2019}e"),                         // bir
        ("Hat 3", "Hat 3\u{2019}e"),                         // üç
        ("Hat 4", "Hat 4\u{2019}e"),                         // dört
        ("Hat 7", "Hat 7\u{2019}ye"),                        // yedi
        ("Hat 8", "Hat 8\u{2019}e"),                         // sekiz
        ("Hat 9", "Hat 9\u{2019}a"),                         // dokuz
        ("Max 20\u{d7}", "Max 20\u{d7}\u{2019}ye"),          // yirmi
        ("Pro 50", "Pro 50\u{2019}ye"),                      // elli
        ("Pro 100", "Pro 100\u{2019}e"),                     // yüz
        ("Pro 80", "Pro 80\u{2019}e"),                       // seksen
        ("Pro 30", "Pro 30\u{2019}a"),                       // otuz
        ("Team 0", "Team 0\u{2019}a"),                       // sıfır, a lone zero
        ("Pro 10", "Pro 10\u{2019}a"),                       // on
        ("Pro 40", "Pro 40\u{2019}a"),                       // kırk
        ("Pro 60", "Pro 60\u{2019}a"),                       // altmış
        ("Pro 70", "Pro 70\u{2019}e"),                       // yetmiş
        ("Pro 90", "Pro 90\u{2019}a"),                       // doksan
        ("Pro 110", "Pro 110\u{2019}a"),                     // on, the tens digit decides
        ("Pro 200", "Pro 200\u{2019}e"),                     // yüz
        ("Pro 1000", "Pro 1000\u{2019}e"),                   // bin
        ("Pro 2000", "Pro 2000\u{2019}e"),                   // bin
        ("Pro 12", "Pro 12\u{2019}ye"),                      // the last digit decides: iki
        ("Team 20 X", "Team 20 X\u{2019}e"), // a consonant after a round number: yirmi, no buffer y
        ("ISIK", "ISIK\u{2019}a"),           // I is dotless: ı
        ("\u{130}ZM\u{130}R", "\u{130}ZM\u{130}R\u{2019}e"), // İ is dotted: i
        ("Okul \u{b7}", "Okul \u{b7}\u{2019}a"), // the mark is skipped; the suffix still ends the name
        ("Alto (Eski)", "Alto (Eski)\u{2019}ye"),
        ("\u{b7}\u{b7}\u{b7}", "\u{b7}\u{b7}\u{b7}\u{2019}e"),
        ("", "\u{2019}e"),
    ];
    for (name, dative) in cases {
        assert_eq!(with_dative(name), dative, "{name:?}");
    }
}
