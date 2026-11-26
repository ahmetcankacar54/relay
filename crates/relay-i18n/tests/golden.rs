//! Every message in every language, formatted by Rust, against what the real
//! `shared/i18n/translate.ts` printed (`tests/golden/formatted.json`, written by
//! `node --import tsx scripts/i18n/export-catalogs.ts`).

use relay_i18n::{Args, Locale, catalog, format_message, translate};
use serde_json::Value;

fn golden() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/golden/formatted.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("golden file")).expect("golden JSON")
}

fn report(mismatches: &[String]) {
    assert!(
        mismatches.is_empty(),
        "{} mismatches (rerun scripts/i18n/export-catalogs.ts if the catalogs changed):\n{}",
        mismatches.len(),
        mismatches
            .iter()
            .take(40)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}

#[test]
fn every_locale_and_message_formats_like_translate_ts() {
    let golden = golden();
    let ids: Vec<&str> = golden["ids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    let cases = golden["cases"].as_array().unwrap();
    let mut mismatches = Vec::new();
    let mut checked = 0;
    for locale in Locale::ALL {
        let mut own: Vec<&str> = catalog(locale).keys().map(String::as_str).collect();
        own.sort_unstable();
        assert_eq!(
            own, ids,
            "{locale}: the golden covers exactly the catalog ids"
        );
        let formatted = golden["formatted"][locale.as_str()].as_array().unwrap();
        for (i, id) in ids.iter().enumerate() {
            let expected: Vec<String> = match &formatted[i] {
                Value::Null => vec![catalog(locale)[*id].clone()],
                outs => outs
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_str().unwrap().to_string())
                    .collect(),
            };
            for (case, want) in cases[i].as_array().unwrap().iter().zip(&expected) {
                checked += 1;
                let got = translate(locale, id, &Args::from_json(case));
                if got != *want {
                    mismatches.push(format!("{locale} {id} {case}: got {got:?}, want {want:?}"));
                }
            }
        }
    }
    assert!(checked > 41_000, "only {checked} cases checked");
    report(&mismatches);
}

#[test]
fn probes_format_like_intl_messageformat() {
    let golden = golden();
    let mut mismatches = Vec::new();
    for probe in golden["probes"].as_array().unwrap() {
        let message = probe["message"].as_str().unwrap();
        for locale in Locale::ALL {
            let outs = probe["out"][locale.as_str()].as_array().unwrap();
            for (args, want) in probe["args"].as_array().unwrap().iter().zip(outs) {
                let got = format_message(message, locale, &Args::from_json(args)).ok();
                if got.as_deref() != want.as_str() {
                    mismatches.push(format!(
                        "{locale} {message:?} {args}: got {got:?}, want {want}"
                    ));
                }
            }
        }
    }
    report(&mismatches);
}
