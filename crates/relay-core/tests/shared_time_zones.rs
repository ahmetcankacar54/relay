//! Port of the `shared/time-zones` cases of tests/time-zones.test.ts. The closed TimeZonePicker
//! markup case is React UI and is skipped.

use std::collections::HashSet;

use relay_core::shared::time_zones::{
    COMMON_TIME_ZONES, build_time_zone_catalog, filter_time_zones, fold_time_zone_search,
    time_zone_city, time_zone_offset, time_zone_options, valid_time_zone,
};
use relay_core::shared::types::js::date_parse;

fn winter() -> f64 {
    date_parse("2026-01-15T12:00:00Z")
}
fn summer() -> f64 {
    date_parse("2026-07-15T12:00:00Z")
}
fn strings(zones: &[&str]) -> Vec<String> {
    zones.iter().map(|z| z.to_string()).collect()
}

#[test]
fn catalog_pins_common_zones_and_locally_falls_back_without_supported_values_of() {
    let fallback = build_time_zone_catalog(None);
    assert_eq!(fallback[..8], COMMON_TIME_ZONES.map(String::from));
    assert_eq!(
        fallback.iter().collect::<HashSet<_>>().len(),
        fallback.len()
    );
    assert!(fallback.iter().any(|z| z == "Asia/Kathmandu"));
    assert!(fallback.iter().any(|z| z == "Australia/Adelaide"));
    let supplied = build_time_zone_catalog(Some(&["Europe/Paris", "invalid/zone", "UTC"]));
    assert!(supplied.iter().any(|z| z == "Europe/Paris"));
    assert!(!supplied.iter().any(|z| z == "invalid/zone"));
}

#[test]
fn offsets_are_date_aware_and_support_fractional_hour_zones_and_malformed_inputs() {
    assert_eq!(time_zone_offset("Europe/London", winter()), "UTC+00:00");
    assert_eq!(time_zone_offset("Europe/London", summer()), "UTC+01:00");
    assert_eq!(time_zone_offset("America/New_York", winter()), "UTC-05:00");
    assert_eq!(time_zone_offset("America/New_York", summer()), "UTC-04:00");
    assert_eq!(time_zone_offset("Asia/Kathmandu", summer()), "UTC+05:45");
    assert_eq!(time_zone_offset("Europe/Istanbul", winter()), "UTC+03:00");
    assert_eq!(time_zone_offset("not-a-zone", winter()), "\u{2014}");
    assert_eq!(time_zone_offset("UTC", f64::NAN), "\u{2014}");
    assert_eq!(time_zone_offset("UTC", 1e30), "\u{2014}");
    assert_eq!(time_zone_city("not-a-zone"), "\u{2014}");
}

#[test]
fn search_treats_turkish_i_forms_and_accented_underscored_city_names_consistently() {
    assert_eq!(fold_time_zone_search("\u{130}STANBUL"), "istanbul");
    assert_eq!(fold_time_zone_search("\u{131}stanbul"), "istanbul");
    assert_eq!(fold_time_zone_search("S\u{e3}o_Paulo"), "sao paulo");
    let catalog = strings(&["Europe/Istanbul", "America/Sao_Paulo", "Asia/Kathmandu"]);
    let options = time_zone_options("Europe/Istanbul", summer(), Some(&catalog));
    assert_eq!(
        filter_time_zones(&options, "\u{130}STANBUL", summer())[0].zone,
        "Europe/Istanbul"
    );
    assert_eq!(
        filter_time_zones(&options, "sao paulo", summer())[0].zone,
        "America/Sao_Paulo"
    );
    assert_eq!(
        filter_time_zones(&options, "GMT+3", summer())[0].zone,
        "Europe/Istanbul"
    );
    assert_eq!(
        filter_time_zones(&options, "+05:45", summer())[0].zone,
        "Asia/Kathmandu"
    );
}

#[test]
fn valid_persisted_and_exact_searched_iana_aliases_remain_explicitly_selectable() {
    let catalog = strings(&["UTC", "Europe/Istanbul"]);
    let options = time_zone_options("US/Eastern", winter(), Some(&catalog));
    assert_eq!(options[0].zone, "US/Eastern");
    assert_eq!(options[0].offset, "UTC-05:00");
    assert_eq!(
        filter_time_zones(&options, "Asia/Calcutta", winter())[0].zone,
        "Asia/Calcutta"
    );
    assert_eq!(filter_time_zones(&options, "Asia/Calcut", winter()), []);
    assert!(!valid_time_zone(" Europe/London "));
    assert!(!valid_time_zone("+05:45"));
    assert!(!valid_time_zone("Asia/DefinitelyNotAZone"));
    let all = time_zone_options("UTC", winter(), None);
    assert_eq!(
        all.iter().map(|o| &o.zone).collect::<HashSet<_>>().len(),
        all.len()
    );
}
