//! Port of tests/tr-locative.test.ts.

use relay_core::shared::tr_dative::clock_locative;

#[test]
fn a_clock_takes_the_locative_its_spoken_form_asks_for() {
    let cases = [
        ("14:00", "14:00\u{2019}te"), // on dört
        ("13:00", "13:00\u{2019}te"), // on üç
        ("15:00", "15:00\u{2019}te"), // on beş
        ("16:00", "16:00\u{2019}da"), // on altı
        ("17:00", "17:00\u{2019}de"), // on yedi
        ("18:00", "18:00\u{2019}de"), // on sekiz
        ("09:00", "09:00\u{2019}da"), // dokuz
        ("10:00", "10:00\u{2019}da"), // on
        ("12:00", "12:00\u{2019}de"), // on iki
        ("20:00", "20:00\u{2019}de"), // yirmi
        ("00:00", "00:00\u{2019}da"), // sıfır
        ("14:30", "14:30\u{2019}da"), // otuz
        ("14:40", "14:40\u{2019}ta"), // kırk
        ("14:50", "14:50\u{2019}de"), // elli
        ("14:05", "14:05\u{2019}te"), // beş
        ("14:10", "14:10\u{2019}da"), // on
        ("14:21", "14:21\u{2019}de"), // yirmi bir
    ];
    for (clock, expected) in cases {
        assert_eq!(clock_locative(clock), expected, "{clock}");
    }
}

#[test]
fn what_is_not_a_clock_is_left_as_it_is() {
    assert_eq!(clock_locative("\u{2014}"), "\u{2014}");
    assert_eq!(clock_locative(""), "");
}
