//! Port of the `overflow-keys` case of tests/gateway-overflow.test.ts; every other case is the
//! gateway's (crates/relay-gateway/tests/gateway_overflow.rs).

use std::fs;
use std::sync::Arc;

use relay_core::overflow_keys::OverflowKeys;
use relay_core::shared::overflow::key_hint;
use relay_core::terminal_identity::{SealFn, UnsealFn};
use relay_core::vault_crypto::Sealer;

const KEY: &str = "sk-test-overflow-key-0000-alto";

fn keys(dir: &std::path::Path) -> OverflowKeys {
    let sealer = Arc::new(Sealer::new(&[7u8; 32]).unwrap());
    let seal_with = sealer.clone();
    let seal: SealFn = Arc::new(move |text: &str| Ok(seal_with.seal(text)));
    let unseal: UnsealFn =
        Arc::new(move |data: &[u8]| sealer.unseal(data).map_err(|e| e.to_string()));
    OverflowKeys::new(dir, seal, unseal)
}

#[test]
fn keys_are_sealed_in_the_vault_and_the_page_only_gets_a_masked_hint() {
    let dir = tempfile::Builder::new()
        .prefix("relay-overflow-vault-")
        .tempdir()
        .unwrap();
    let dir = dir.path();
    let first = keys(dir);
    assert!(
        first.hints().is_empty(),
        "nothing before the keys were read"
    );
    first.set("one", KEY).unwrap();
    let raw = fs::read(dir.join("api-keys").join("overflow.bin")).unwrap();
    assert!(
        !raw.windows(KEY.len()).any(|w| w == KEY.as_bytes()),
        "the file holds no key in the clear"
    );
    let fresh = keys(dir);
    assert_eq!(fresh.get("one").unwrap().as_deref(), Some(KEY));
    let hints = fresh.hints();
    assert_eq!(hints.len(), 1);
    assert_eq!(hints.get("one").map(String::as_str), Some("sk-…alto"));
    assert!(
        !serde_json::to_string(&hints)
            .unwrap()
            .contains("overflow-key")
    );
    fresh.remove("one").unwrap();
    assert!(!dir.join("api-keys").join("overflow.bin").exists());
    assert_eq!(key_hint("short"), "…");
}
