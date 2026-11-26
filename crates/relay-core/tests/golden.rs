//! Cross-language golden files (plan Phase 1 (b)). `scripts/parity/golden.ts` writes the files in
//! `tests/golden/` from the TS; these tests open them. `write_golden` (ignored) writes Rust's own
//! into `tests/golden/out/` for `golden.ts --verify` to open with the TS:
//!
//! ```text
//! node --import tsx scripts/parity/golden.ts
//! cargo test -p relay-core -- --ignored write_golden
//! node --import tsx scripts/parity/golden.ts --verify crates/relay-core/tests/golden/out
//! ```
//!
//! `state/state.json` and `backup.relaybackup` are checked at the byte level and through the Rust
//! Store and backup ports; `write_golden` writes the TS registry as the Rust Store rewrites it and
//! a backup made and sealed by Rust.

use std::fs;
use std::path::{Path, PathBuf};

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use relay_core::backup::{
    BackupContext, BackupHost, BackupSource, ClaudeCodeSignIns, ScryptParams, collect_backup,
    open_backup, read_backup_header, seal_backup,
};
use relay_core::desktop_files::{json_bytes, read_bytes, write_bytes};
use relay_core::process_lock::{LockBy, LockDeps, LockInfo, ProcessLock};
use relay_core::profile_lock::{ProfileLockHolder, ProfileLockKind, acquire_profile_lock};
use relay_core::shared::proxy_types::default_proxy_config;
use relay_core::shared::types::{AccountKind, AccountProvider, CreateAccount};
use relay_core::store::{STATE_SCHEMA, Store, StoreOptions};
use relay_core::vault_crypto::Sealer;
use relay_core::vault_migration::{VaultState, mark_vault_format, vault_state};
use serde_json::{Map, Value, json};

fn golden() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden")
}

fn sealer() -> Sealer {
    let text = fs::read_to_string(golden().join("vault-key.b64")).unwrap();
    let key = STANDARD.decode(text.trim()).unwrap();
    assert_eq!(key, [0x11u8; 32]);
    Sealer::new(&key).unwrap()
}

fn vault_texts() -> Map<String, Value> {
    serde_json::from_slice(&fs::read(golden().join("vault-texts.json")).unwrap()).unwrap()
}

const LOCK_KIND: &str = "golden";
const LOCK_STARTED_AT: &str = "2026-11-26T00:00:00.000Z";
const PROFILE_ACCOUNT: &str = "33333333-3333-4333-8333-333333333333";

#[test]
fn a_file_sealed_by_ts_opens_in_rust() {
    let sealed = fs::read(golden().join("sealed.bin")).unwrap();
    let text = fs::read_to_string(golden().join("sealed.txt")).unwrap();
    assert_eq!(sealer().unseal(&sealed).unwrap(), text);
}

#[test]
fn a_ts_v2_vault_folder_is_ready_and_every_file_opens() {
    let vault = golden().join("desktop-vault");
    assert_eq!(vault_state(&vault).unwrap(), VaultState::Ready);
    assert_eq!(
        read_bytes(&vault, "format.json").unwrap().unwrap(),
        json_bytes(&json!({ "version": 2 }))
    );
    let sealer = sealer();
    for (relative, text) in vault_texts() {
        let data = read_bytes(&vault, &relative).unwrap().unwrap();
        assert_eq!(sealer.unseal(&data).unwrap(), text.as_str().unwrap());
    }
}

#[test]
fn a_ts_process_lock_file_parses_and_reserializes_byte_for_byte() {
    let file = golden().join("locks/state.lock");
    let raw = fs::read_to_string(&file).unwrap();
    let info: LockInfo = serde_json::from_str(&raw).unwrap();
    assert_eq!(info.by, LockBy::App);
    assert_eq!(info.kind, LOCK_KIND);
    assert_eq!(info.started_at, LOCK_STARTED_AT);
    assert!(uuid::Uuid::parse_str(&info.token).is_ok());
    assert_eq!(serde_json::to_string(&info).unwrap(), raw);
}

fn profile_lock_file(locks: &Path) -> PathBuf {
    let dir = locks.join(PROFILE_ACCOUNT);
    let mut names: Vec<_> = fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    assert_eq!(names.len(), 1, "one profile lock file");
    names.pop().unwrap()
}

#[test]
fn a_ts_profile_lock_file_parses_and_reserializes_byte_for_byte() {
    let file = profile_lock_file(&golden().join("locks/profile"));
    let raw = fs::read_to_string(&file).unwrap();
    let holder: ProfileLockHolder = serde_json::from_str(&raw).unwrap();
    assert_eq!(holder.kind, ProfileLockKind::Shared);
    let name = file.file_name().unwrap().to_str().unwrap();
    assert!(name.starts_with(&format!("{}-", holder.pid)));
    assert!(name.ends_with(".json"));
    assert_eq!(serde_json::to_string(&holder).unwrap(), raw);
}

#[test]
fn a_ts_state_json_is_schema_8_pretty_json() {
    let raw = fs::read_to_string(golden().join("state/state.json")).unwrap();
    let value: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(value["schema"], json!(8));
    let names: Vec<_> = value["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["name"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(names, ["Personal", "Work", "Codex"]);
    assert_eq!(serde_json::to_string_pretty(&value).unwrap(), raw);
}

/// `electron/core/backup.ts` `openBackup`, by hand: `RLYB`, format, scrypt params, salt, nonce;
/// AES-256-GCM with the header as AAD; the key scrypt of the NFC passphrase.
#[test]
fn a_ts_backup_opens_with_its_passphrase() {
    let expected: Value =
        serde_json::from_slice(&fs::read(golden().join("backup-expected.json")).unwrap()).unwrap();
    let file = fs::read(golden().join("backup.relaybackup")).unwrap();
    assert_eq!(&file[..4], b"RLYB");
    assert_eq!(file[4], 1);
    let (log_n, r, p) = (file[5], file[6], file[7]);
    assert_eq!(json!({ "logN": log_n, "r": r, "p": p }), expected["scrypt"]);
    let (header, rest) = file.split_at(36);
    let mut key = [0u8; 32];
    scrypt::scrypt(
        expected["passphrase"].as_str().unwrap().as_bytes(),
        &header[8..24],
        &scrypt::Params::new(log_n, u32::from(r), u32::from(p)).unwrap(),
        &mut key,
    )
    .unwrap();
    let plain = Aes256Gcm::new_from_slice(&key)
        .unwrap()
        .decrypt(
            &Nonce::try_from(&header[24..36]).unwrap(),
            Payload {
                msg: rest,
                aad: header,
            },
        )
        .unwrap();
    let payload: Value = serde_json::from_slice(&plain).unwrap();
    assert_eq!(payload["kind"], "relay-backup");
    let names: Vec<_> = payload["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["name"].clone())
        .collect();
    assert_eq!(Value::Array(names), expected["accounts"]);
}

/// The plan's spot check: the TS backup opens through the Rust port with its passphrase and
/// holds the same accounts.
#[test]
fn backup_golden() {
    let expected: Value =
        serde_json::from_slice(&fs::read(golden().join("backup-expected.json")).unwrap()).unwrap();
    let file = fs::read(golden().join("backup.relaybackup")).unwrap();
    let header = read_backup_header(&file).unwrap();
    assert_eq!(
        serde_json::to_value(header.params).unwrap(),
        expected["scrypt"]
    );
    let opened = open_backup(&file, expected["passphrase"].as_str().unwrap()).unwrap();
    let names: Vec<Value> = opened
        .payload
        .accounts
        .iter()
        .map(|a| Value::from(a.name.clone()))
        .collect();
    assert_eq!(Value::Array(names), expected["accounts"]);
    assert_eq!(opened.payload.relay_version, "0.29.0");
    assert_eq!(opened.payload.sessions, None);
}

/// The TS registry opens in the Rust Store as schema 8 with its accounts, and a Rust write of it
/// reads back through the same schema (golden.ts `--verify` opens it with the TS Store).
#[test]
fn a_ts_state_json_opens_in_the_rust_store_and_its_rust_rewrite_reads_back() {
    let root = tempfile::tempdir().unwrap();
    fs::copy(
        golden().join("state/state.json"),
        root.path().join("state.json"),
    )
    .unwrap();
    let store = Store::open(root.path(), StoreOptions::cli()).unwrap();
    assert_eq!(store.file_schema(), STATE_SCHEMA);
    let names: Vec<String> = store.state().accounts.into_iter().map(|a| a.name).collect();
    assert_eq!(names, ["Personal", "Work", "Codex"]);
    let before = store.state();
    store.update(|_| {}).unwrap();
    let raw = fs::read_to_string(root.path().join("state.json")).unwrap();
    let value: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(serde_json::to_string_pretty(&value).unwrap(), raw);
    let reopened = Store::open(root.path(), StoreOptions::cli())
        .unwrap()
        .state();
    assert_eq!(reopened.accounts, before.accounts);
    assert_eq!(reopened.settings, before.settings);
    assert_eq!(reopened.schema, Some(STATE_SCHEMA));
}

/// Writes Rust's side into `tests/golden/out/` for `golden.ts --verify`.
#[test]
#[ignore]
fn write_golden() {
    let out = golden().join("out");
    let _ = fs::remove_dir_all(&out);
    fs::create_dir_all(&out).unwrap();
    let sealer = sealer();

    let text = fs::read_to_string(golden().join("sealed.txt")).unwrap();
    fs::write(out.join("sealed.bin"), sealer.seal(&text)).unwrap();

    let vault = out.join("desktop-vault");
    for (relative, text) in vault_texts() {
        write_bytes(
            &vault,
            &relative,
            Some(&sealer.seal(text.as_str().unwrap())),
        )
        .unwrap();
    }
    mark_vault_format(&vault).unwrap();

    let work = tempfile::tempdir().unwrap();
    let lock = ProcessLock::with_deps(
        work.path().join("state.lock"),
        LockBy::App,
        LockDeps {
            now: Some(Box::new(|| {
                relay_core::fs_util::parse_iso_ms(LOCK_STARTED_AT).unwrap()
            })),
            ..LockDeps::default()
        },
    );
    lock.try_acquire(LOCK_KIND).unwrap();
    fs::create_dir_all(out.join("locks")).unwrap();
    fs::copy(lock.file(), out.join("locks/state.lock")).unwrap();
    lock.release();

    let locks = work.path().join("profile-locks");
    let mut guard = acquire_profile_lock(&locks, PROFILE_ACCOUNT, ProfileLockKind::Shared).unwrap();
    let file = profile_lock_file(&locks);
    let target = out.join("locks/profile").join(PROFILE_ACCOUNT);
    fs::create_dir_all(&target).unwrap();
    fs::copy(&file, target.join(file.file_name().unwrap())).unwrap();
    guard.release();

    // The TS registry, read by the Rust Store and written back by it.
    let store_dir = tempfile::tempdir().unwrap();
    fs::copy(
        golden().join("state/state.json"),
        store_dir.path().join("state.json"),
    )
    .unwrap();
    let store = Store::open(store_dir.path(), StoreOptions::cli()).unwrap();
    store.update(|_| {}).unwrap();
    fs::create_dir_all(out.join("state")).unwrap();
    fs::copy(&store.file, out.join("state/state.json")).unwrap();

    // A backup of the golden accounts, made and sealed by Rust.
    let expected: Value =
        serde_json::from_slice(&fs::read(golden().join("backup-expected.json")).unwrap()).unwrap();
    let params: ScryptParams = serde_json::from_value(expected["scrypt"].clone()).unwrap();
    let data = tempfile::tempdir().unwrap();
    let fresh = Store::open(
        data.path(),
        StoreOptions {
            backup_on_open: false,
            ..StoreOptions::default()
        },
    )
    .unwrap();
    for (name, kind, group, provider) in [
        ("Personal", AccountKind::Personal, None, None),
        ("Work", AccountKind::Work, Some("Acme"), None),
        (
            "Codex",
            AccountKind::Personal,
            None,
            Some(AccountProvider::Codex),
        ),
    ] {
        fresh
            .create(&CreateAccount {
                name: name.into(),
                kind,
                group: group.map(str::to_string),
                provider,
            })
            .unwrap();
    }
    let state = fresh.state();
    let gateway = default_proxy_config();
    let no_keychain = NoKeychain;
    let now = || relay_core::fs_util::parse_iso_ms("2026-11-26T00:00:00.000Z").unwrap();
    let payload = collect_backup(
        &BackupSource {
            settings: &state.settings,
            accounts: &state.accounts,
            gateway: &gateway,
        },
        false,
        &BackupContext {
            host: BackupHost {
                data: data.path(),
                sealer: &sealer,
                claude_code: &no_keychain,
            },
            relay_version: "0.29.0".into(),
            platform: "darwin".into(),
            now: &now,
        },
    )
    .unwrap();
    let passphrase = expected["passphrase"].as_str().unwrap();
    fs::write(
        out.join("backup.relaybackup"),
        seal_backup(&payload, passphrase, params).unwrap(),
    )
    .unwrap();
}

/// A computer without Claude Code sign-ins.
struct NoKeychain;

impl ClaudeCodeSignIns for NoKeychain {
    fn read(&self, _: &Path) -> Result<Option<String>, String> {
        Ok(None)
    }
    fn write(&self, _: &Path, _: &str) -> Result<(), String> {
        Ok(())
    }
}
