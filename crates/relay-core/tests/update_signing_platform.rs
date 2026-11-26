//! Port of the app-side parts of tests/update-signing.test.ts: `signed_by`, `parse_checksums`
//! and the embedded key. The release scripts (`scripts/update-signing.mjs`,
//! `homebrew-cask.mjs`, `stable-signing.mjs`) stay JavaScript: their own assertions, and the
//! cases "the signing key comes from the environment…", "sums cover the release files only…",
//! "the Homebrew cask points at the DMGs…" and "the cask in packaging/homebrew…", are not
//! ported. The sums are formatted here as `formatSums` does (`<hex>  <name>` lines).

#[path = "common/signing.rs"]
mod signing;

use base64::Engine;
use relay_core::app_update::parse_checksums;
use relay_core::update_signing_key::UPDATE_SIGNING_PUBLIC_KEY;
use relay_core::win_linux_update::signed_by;
use signing::{RSA_PUBLIC_KEY, TestKey, sha256_hex};

#[test]
fn the_sums_a_release_script_signs_are_the_sums_the_app_accepts_and_nothing_else() {
    let key = TestKey::new(3);
    let public_key = key.public_key();
    let text = format!(
        "{}  Relay-Setup-1.2.3-x64.exe\n{}  latest.yml\n",
        sha256_hex(b"exe"),
        sha256_hex(b"yml")
    );
    let signature = key.sign(&text);
    assert!(signed_by(&text, &signature, &public_key));
    // The app reads back what the script listed.
    let sums = parse_checksums(&text);
    assert_eq!(
        sums.get("Relay-Setup-1.2.3-x64.exe"),
        Some(&sha256_hex(b"exe"))
    );
    assert_eq!(sums.len(), 2);
    // One changed character in the sums, another key, or a garbled signature: refused.
    let first = text.chars().next().unwrap();
    let tampered = format!("{}{}", if first == '0' { '1' } else { '0' }, &text[1..]);
    let other = TestKey::new(4).public_key();
    for (sums, sig, public) in [
        (tampered.as_str(), signature.as_str(), public_key.as_str()),
        (&text, &signature, &other),
        (&text, "AAAA", &public_key),
        (&text, &signature, "not a key"),
    ] {
        assert!(!signed_by(sums, sig, public));
    }
    // A key of another kind is never the update key.
    assert!(!signed_by(&text, &signature, RSA_PUBLIC_KEY));
    // A signature file ends with a newline; it is trimmed.
    assert!(signed_by(&text, &format!("{signature}\n"), &public_key));
}

#[test]
fn the_app_embeds_a_well_formed_ed25519_public_key_the_one_the_scripts_check_against() {
    // 12-byte Ed25519 SPKI header and a 32-byte key.
    let der = base64::engine::general_purpose::STANDARD
        .decode(UPDATE_SIGNING_PUBLIC_KEY)
        .unwrap();
    assert_eq!(der.len(), 44);
    // The fingerprint the key's doc comment and scripts/update-signing.mjs name.
    assert_eq!(
        format!("sha256:{}", sha256_hex(&der)),
        "sha256:13fd553596797877597e1b4bfe7c5d8020bfc45e1ca11ee3675a62183273b4b4"
    );
    assert!(!signed_by("x", "AAAA", UPDATE_SIGNING_PUBLIC_KEY));
}
