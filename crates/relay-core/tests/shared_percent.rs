//! Port of the `shared/percent` cases of tests/percent.test.ts. "the meter module hands out the
//! same helpers" checks `src/lib/meter` re-exports (UI module) and is skipped.

use relay_core::shared::percent::{format_percent, format_used, percent_used, used_word};
use relay_i18n::Locale::{De, En, Tr};

#[test]
fn a_percentage_reads_6_in_turkish_and_6_in_english_rounded_and_a_dash_when_unknown() {
    assert_eq!(format_percent(Some(6.0), Tr), "%6");
    assert_eq!(format_percent(Some(6.0), En), "6%");
    assert_eq!(format_percent(Some(5.6), Tr), "%6");
    assert_eq!(format_percent(Some(5.4), En), "5%");
    assert_eq!(format_percent(None, Tr), "\u{2014}");
    assert_eq!(format_percent(Some(f64::NAN), En), "\u{2014}");
    assert_eq!(format_percent(Some(94.0), De), "94\u{a0}%");
}

#[test]
fn the_percent_used_is_rounded_down_and_kept_between_0_and_100() {
    assert_eq!(percent_used(Some(94.0)), Some(94.0));
    assert_eq!(percent_used(Some(0.0)), Some(0.0));
    assert_eq!(percent_used(Some(100.0)), Some(100.0));
    // Only a full window reads 100: 99.9 used shows 99.
    assert_eq!(percent_used(Some(93.5)), Some(93.0));
    assert_eq!(percent_used(Some(99.9)), Some(99.0));
    assert_eq!(percent_used(Some(0.2)), Some(0.0));
    assert_eq!(percent_used(Some(150.0)), Some(100.0));
    assert_eq!(percent_used(Some(-5.0)), Some(0.0));
    assert_eq!(percent_used(None), None);
    assert_eq!(percent_used(Some(f64::NAN)), None);
    assert_eq!(percent_used(Some(f64::INFINITY)), None);
}

#[test]
fn a_limit_percentage_always_carries_its_word_94_kullanildi_94_used() {
    assert_eq!(format_used(Some(94.0), Tr), "%94 kullan\u{131}ld\u{131}");
    assert_eq!(format_used(Some(94.0), En), "94% used");
    assert_eq!(format_used(Some(93.5), Tr), "%93 kullan\u{131}ld\u{131}");
    assert_eq!(format_used(Some(99.9), Tr), "%99 kullan\u{131}ld\u{131}");
    assert_eq!(format_used(Some(99.9), En), "99% used");
    assert_eq!(format_used(Some(100.0), Tr), "%100 kullan\u{131}ld\u{131}");
    assert_eq!(format_used(Some(100.0), En), "100% used");
    assert_eq!(format_used(Some(-5.0), Tr), "%0 kullan\u{131}ld\u{131}");
    assert_eq!(format_used(Some(0.0), En), "0% used");
    assert_eq!(format_used(Some(150.0), Tr), "%100 kullan\u{131}ld\u{131}");
    assert_eq!(format_used(None, Tr), "\u{2014}");
    assert_eq!(format_used(Some(f64::NAN), En), "\u{2014}");
    assert_eq!(used_word(Tr), "kullan\u{131}ld\u{131}");
    assert_eq!(used_word(En), "used");
}
