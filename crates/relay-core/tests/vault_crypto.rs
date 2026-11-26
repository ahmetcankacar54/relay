//! Port of `tests/vault-crypto.test.ts`. The TS ↔ Rust cross-check is in `golden.rs`.

use relay_core::legacy_unseal::LegacyUnsealError;
use relay_core::vault_crypto::{Sealer, UnsealError, VaultFormatError, is_sealed_v2};

fn random_key() -> [u8; 32] {
    let mut key = [0u8; 32];
    getrandom::fill(&mut key).unwrap();
    key
}

fn format_error(result: Result<String, UnsealError>) -> VaultFormatError {
    match result {
        Err(UnsealError::Format(error)) => error,
        other => panic!("expected a format error, got {other:?}"),
    }
}

#[test]
fn format_2_round_trips_uses_a_fresh_nonce_and_starts_with_rly2() {
    let s = Sealer::new(&random_key()).unwrap();
    let a = s.seal("hello");
    let b = s.seal("hello");
    assert_eq!(&a[..4], b"RLY2");
    assert_ne!(a, b);
    assert_eq!(a.len(), 4 + 12 + 5 + 16);
    assert_eq!(s.unseal(&a).unwrap(), "hello");
    assert!(is_sealed_v2(&a));
    assert_eq!(s.unseal(&s.seal("ğüşİ — ✓")).unwrap(), "ğüşİ — ✓");
}

#[test]
fn a_tampered_or_truncated_file_is_invalid_never_partly_read() {
    let s = Sealer::new(&random_key()).unwrap();
    let mut sealed = s.seal("secret");
    sealed[20] ^= 1;
    assert_eq!(format_error(s.unseal(&sealed)), VaultFormatError::Invalid);
    assert_eq!(
        format_error(s.unseal(b"RLY2short")),
        VaultFormatError::Invalid
    );
}

#[test]
fn a_format_1_buffer_goes_to_the_legacy_unseal_or_is_refused_without_one() {
    let key = random_key();
    let v10 = format!("v10{}", "x".repeat(29)).into_bytes();
    assert_eq!(
        format_error(Sealer::new(&key).unwrap().unseal(&v10)),
        VaultFormatError::Legacy
    );
    let with_legacy =
        Sealer::with_legacy(&key, std::sync::Arc::new(|_| Ok("old".to_owned()))).unwrap();
    assert_eq!(with_legacy.unseal(&v10).unwrap(), "old");
    assert!(!is_sealed_v2(&v10));
}

#[test]
fn another_key_cannot_open_it() {
    let sealed = Sealer::new(&random_key()).unwrap().seal("x");
    assert_eq!(
        format_error(Sealer::new(&random_key()).unwrap().unseal(&sealed)),
        VaultFormatError::Invalid
    );
}

#[test]
fn only_a_32_byte_key_is_accepted() {
    let error = Sealer::new(&[0u8; 16]).err().unwrap();
    assert_eq!(error.to_string(), "The vault key must be 32 bytes.");
    assert!(Sealer::new(&[0u8; 33]).is_err());
}

#[test]
fn errors_keep_the_ts_messages() {
    assert_eq!(
        VaultFormatError::Legacy.to_string(),
        "This vault file is in the old format. Update Relay.app to 0.12 or later and open it once."
    );
    assert_eq!(
        VaultFormatError::Invalid.to_string(),
        "A vault file is damaged or was sealed with another key."
    );
}

#[test]
fn a_legacy_unseal_failure_passes_through() {
    let sealer = Sealer::with_legacy(
        &random_key(),
        std::sync::Arc::new(|_| Err(LegacyUnsealError::Decrypt)),
    )
    .unwrap();
    assert!(matches!(
        sealer.unseal(b"v10abc"),
        Err(UnsealError::Legacy(LegacyUnsealError::Decrypt))
    ));
}
