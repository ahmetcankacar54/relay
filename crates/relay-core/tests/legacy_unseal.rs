//! The pre-v2 vault seal (Electron safeStorage). macOS is checked against real Electron bytes
//! (`scripts/parity/safe-storage-golden.cjs`, mock keychain, committed); Windows and Linux against
//! vectors built here in Chromium's OSCrypt layout, and in CI against a blob Electron writes in
//! the same job (`system_golden_from_env`), since their keys never leave the machine.

use std::cell::RefCell;
use std::path::Path;
use std::time::Duration;

use aes::Aes128;
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use cbc::cipher::block_padding::Pkcs7;
use cbc::cipher::{BlockModeEncrypt, KeyIvInit};
use relay_core::legacy_unseal::{
    LegacyKeySource, LegacyUnsealError, cbc_key, legacy_unseal, linux_kwallet, linux_v11_secret,
    windows_key_from_local_state,
};
use relay_core::vault_crypto::Sealer;
use relay_core::vault_key::ToolRun;

const GOLDEN: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/golden/legacy");

/// Chromium's CBC seal: prefix ‖ AES-128-CBC (PKCS#7, IV of 16 spaces).
fn cbc_seal(prefix: &[u8], key: &[u8; 16], plain: &[u8]) -> Vec<u8> {
    let mut buf = vec![0u8; plain.len() + 16];
    buf[..plain.len()].copy_from_slice(plain);
    let body = cbc::Encryptor::<Aes128>::new(key.into(), &[0x20u8; 16].into())
        .encrypt_padded::<Pkcs7>(&mut buf, plain.len())
        .unwrap()
        .to_vec();
    [prefix, &body].concat()
}

/// Chromium's Windows seal: `v10` ‖ nonce ‖ AES-256-GCM (ciphertext ‖ tag), no AAD.
fn gcm_seal(key: &[u8; 32], nonce: [u8; 12], plain: &[u8]) -> Vec<u8> {
    let sealed = Aes256Gcm::new_from_slice(key)
        .unwrap()
        .encrypt(&Nonce::from(nonce), plain)
        .unwrap();
    [b"v10".as_slice(), &nonce, &sealed].concat()
}

fn mac(password: &str) -> LegacyKeySource {
    LegacyKeySource::Mac {
        password: password.to_owned(),
    }
}

#[test]
fn macos_golden_from_electron_opens_with_its_safe_storage_password() {
    let meta: serde_json::Value =
        serde_json::from_slice(&std::fs::read(format!("{GOLDEN}/macos/golden.json")).unwrap())
            .unwrap();
    let blob = std::fs::read(format!("{GOLDEN}/macos/golden.bin")).unwrap();
    assert!(blob.starts_with(b"v10"));
    let source = mac(meta["password"].as_str().unwrap());
    assert_eq!(
        legacy_unseal(&blob, &source).unwrap(),
        meta["plain"].as_str().unwrap()
    );
    assert_eq!(
        legacy_unseal(&blob, &mac("another")),
        Err(LegacyUnsealError::Decrypt)
    );
}

/// A blob `safe-storage-golden.cjs` just wrote on this machine, opened with the system's own key
/// source: Windows' `Local State` through DPAPI, Linux's keyring (`v11`) or "peanuts" (`v10`).
/// `RELAY_SAFE_STORAGE_GOLDEN_DIR` is the script's folder, which is also its userData.
#[cfg(any(windows, target_os = "linux"))]
#[test]
#[ignore = "needs a blob Electron wrote on this machine (CI job safe-storage-golden)"]
fn system_golden_from_env() {
    use relay_core::legacy_unseal::SystemLegacySeal;
    let dir = std::path::PathBuf::from(
        std::env::var("RELAY_SAFE_STORAGE_GOLDEN_DIR").expect("RELAY_SAFE_STORAGE_GOLDEN_DIR"),
    );
    let meta: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.join("golden.json")).unwrap()).unwrap();
    let blob = std::fs::read(dir.join("golden.bin")).unwrap();
    let plain = meta["plain"].as_str().unwrap();
    #[cfg(windows)]
    let source = {
        assert!(blob.starts_with(b"v10"), "Windows blob prefix");
        LegacyKeySource::windows_from_local_state(&dir.join("Local State"))
    };
    #[cfg(target_os = "linux")]
    let source = {
        let source = LegacyKeySource::linux_from_keyring(&|name| std::env::var(name).ok());
        match meta["backend"].as_str() {
            Some("basic_text") => assert!(blob.starts_with(b"v10"), "basic_text blob prefix"),
            Some("gnome_libsecret") => {
                assert!(blob.starts_with(b"v11"), "libsecret blob prefix");
                assert!(
                    matches!(
                        &source,
                        LegacyKeySource::Linux {
                            v11_secret: Some(_)
                        }
                    ),
                    "the keyring holds no secret for application {}",
                    relay_core::legacy_unseal::LINUX_APP_NAME
                );
            }
            other => panic!("unexpected backend {other:?}"),
        }
        source
    };
    assert_eq!(legacy_unseal(&blob, &source).unwrap(), plain);
    // What vault migration uses: the same key source, read from the system on first use.
    let seal = SystemLegacySeal::new(&dir, None);
    assert_eq!(seal.unseal(&blob).unwrap(), plain);
    if cfg!(windows) || blob.starts_with(b"v11") {
        assert!(seal.available());
    }
}

#[test]
fn macos_uses_pbkdf2_sha1_1003_iterations() {
    let blob = cbc_seal(b"v10", &cbc_key("pw", 1003), "ğüş {\"a\":1}".as_bytes());
    assert_eq!(legacy_unseal(&blob, &mac("pw")).unwrap(), "ğüş {\"a\":1}");
    let one = cbc_seal(b"v10", &cbc_key("pw", 1), b"x");
    assert_eq!(
        legacy_unseal(&one, &mac("pw")),
        Err(LegacyUnsealError::Decrypt)
    );
}

#[test]
fn empty_is_empty_and_an_unprefixed_blob_is_old_clear_text() {
    let sources = [
        mac("pw"),
        LegacyKeySource::Linux { v11_secret: None },
        LegacyKeySource::Windows {
            key: None,
            dpapi: None,
        },
    ];
    for source in &sources {
        assert_eq!(legacy_unseal(b"", source).unwrap(), "");
    }
    assert_eq!(legacy_unseal(b"plain", &sources[0]).unwrap(), "plain");
    assert_eq!(legacy_unseal(b"plain", &sources[1]).unwrap(), "plain");
}

#[test]
fn a_truncated_cbc_body_is_a_decrypt_error() {
    let mut blob = cbc_seal(b"v10", &cbc_key("pw", 1003), b"secret");
    blob.pop();
    assert_eq!(
        legacy_unseal(&blob, &mac("pw")),
        Err(LegacyUnsealError::Decrypt)
    );
}

#[test]
fn linux_v10_uses_peanuts_and_v11_the_keyring_secret() {
    let none = LegacyKeySource::Linux { v11_secret: None };
    let v10 = cbc_seal(b"v10", &cbc_key("peanuts", 1), b"token");
    assert_eq!(legacy_unseal(&v10, &none).unwrap(), "token");
    let v11 = cbc_seal(b"v11", &cbc_key("s3cret", 1), b"token");
    let with = LegacyKeySource::Linux {
        v11_secret: Some("s3cret".to_owned()),
    };
    assert_eq!(legacy_unseal(&v11, &with).unwrap(), "token");
    assert_eq!(
        legacy_unseal(&v11, &none),
        Err(LegacyUnsealError::Unavailable)
    );
    let wrong = LegacyKeySource::Linux {
        v11_secret: Some("other".to_owned()),
    };
    assert_eq!(legacy_unseal(&v11, &wrong), Err(LegacyUnsealError::Decrypt));
}

#[test]
fn linux_falls_back_to_the_empty_password_as_chromium_does() {
    let v11 = cbc_seal(b"v11", &cbc_key("", 1), b"token");
    let source = LegacyKeySource::Linux {
        v11_secret: Some("s3cret".to_owned()),
    };
    assert_eq!(legacy_unseal(&v11, &source).unwrap(), "token");
}

/// A stand-in for DPAPI: XOR with 0x5a.
fn fake_dpapi(data: &[u8]) -> Option<Vec<u8>> {
    data.strip_prefix(b"DP:")
        .map(|rest| rest.iter().map(|b| b ^ 0x5a).collect())
}

fn fake_protect(data: &[u8]) -> Vec<u8> {
    [
        b"DP:".as_slice(),
        &data.iter().map(|b| b ^ 0x5a).collect::<Vec<_>>(),
    ]
    .concat()
}

#[test]
fn windows_key_comes_from_local_state_dpapi_prefixed() {
    let key = [9u8; 32];
    let wrapped = STANDARD.encode([b"DPAPI".as_slice(), &fake_protect(&key)].concat());
    let local_state = format!(r#"{{"os_crypt":{{"encrypted_key":"{wrapped}"}},"other":1}}"#);
    assert_eq!(
        windows_key_from_local_state(local_state.as_bytes(), fake_dpapi),
        Some(key)
    );
    let unprefixed = STANDARD.encode(fake_protect(&key));
    let bad = format!(r#"{{"os_crypt":{{"encrypted_key":"{unprefixed}"}}}}"#);
    assert_eq!(
        windows_key_from_local_state(bad.as_bytes(), fake_dpapi),
        None
    );
    assert_eq!(windows_key_from_local_state(b"{}", fake_dpapi), None);
    assert_eq!(windows_key_from_local_state(b"not json", fake_dpapi), None);
    let short = STANDARD.encode([b"DPAPI".as_slice(), &fake_protect(&[1u8; 16])].concat());
    let short = format!(r#"{{"os_crypt":{{"encrypted_key":"{short}"}}}}"#);
    assert_eq!(
        windows_key_from_local_state(short.as_bytes(), fake_dpapi),
        None
    );
}

#[test]
fn windows_v10_is_aes_256_gcm_and_older_blobs_are_dpapi_whole() {
    let key = [3u8; 32];
    let source = LegacyKeySource::Windows {
        key: Some(key),
        dpapi: Some(fake_dpapi),
    };
    let blob = gcm_seal(&key, [7u8; 12], "çalışma".as_bytes());
    assert_eq!(legacy_unseal(&blob, &source).unwrap(), "çalışma");
    let mut tampered = blob.clone();
    *tampered.last_mut().unwrap() ^= 1;
    assert_eq!(
        legacy_unseal(&tampered, &source),
        Err(LegacyUnsealError::Decrypt)
    );
    assert_eq!(
        legacy_unseal(b"v10short", &source),
        Err(LegacyUnsealError::Decrypt)
    );
    assert_eq!(
        legacy_unseal(&fake_protect(b"old"), &source).unwrap(),
        "old"
    );
    assert_eq!(
        legacy_unseal(b"garbage", &source),
        Err(LegacyUnsealError::Decrypt)
    );
    let keyless = LegacyKeySource::Windows {
        key: None,
        dpapi: None,
    };
    assert_eq!(
        legacy_unseal(&blob, &keyless),
        Err(LegacyUnsealError::Unavailable)
    );
    assert_eq!(
        legacy_unseal(b"garbage", &keyless),
        Err(LegacyUnsealError::Unavailable)
    );
}

#[test]
fn a_v2_sealer_hands_legacy_blobs_to_legacy_unseal() {
    let source = mac("pw");
    let sealer = Sealer::with_legacy(
        &[1u8; 32],
        std::sync::Arc::new(move |data| legacy_unseal(data, &source)),
    )
    .unwrap();
    let blob = cbc_seal(b"v10", &cbc_key("pw", 1003), b"old sign-in");
    assert_eq!(sealer.unseal(&blob).unwrap(), "old sign-in");
    assert_eq!(sealer.unseal(&sealer.seal("new")).unwrap(), "new");
}

#[test]
fn errors_keep_electrons_messages() {
    assert_eq!(
        LegacyUnsealError::Unavailable.to_string(),
        "System encryption is unavailable."
    );
    assert_eq!(
        LegacyUnsealError::Decrypt.to_string(),
        "Error while decrypting the ciphertext provided to safeStorage.decryptString."
    );
}

#[cfg(unix)]
mod keychain {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// A `security` stand-in serving one item for any service, logging argv.
    fn fake_security(dir: &Path, stdout: &str, exit: i32) -> std::path::PathBuf {
        let tool = dir.join("security");
        std::fs::write(
            &tool,
            format!(
                "#!/bin/sh\necho \"$*\" >> \"$(dirname \"$0\")/argv.log\"\nprintf '%s' '{stdout}'\nexit {exit}\n"
            ),
        )
        .unwrap();
        std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).unwrap();
        tool
    }

    #[test]
    fn mac_password_is_read_from_relay_safe_storage() {
        let dir = tempfile::tempdir().unwrap();
        let tool = fake_security(dir.path(), "abc+/def==\n", 0);
        let source = LegacyKeySource::mac_from_keychain(&tool).unwrap();
        assert!(matches!(&source, LegacyKeySource::Mac { password } if password == "abc+/def=="));
        let argv = std::fs::read_to_string(dir.path().join("argv.log")).unwrap();
        assert_eq!(argv, "find-generic-password -s Relay Safe Storage -w\n");
    }

    #[test]
    fn a_missing_or_refused_item_makes_the_old_seal_unavailable() {
        for exit in [44, 51] {
            let dir = tempfile::tempdir().unwrap();
            let tool = fake_security(dir.path(), "", exit);
            assert_eq!(
                LegacyKeySource::mac_from_keychain(&tool).err(),
                Some(LegacyUnsealError::Unavailable)
            );
        }
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            LegacyKeySource::mac_from_keychain(&dir.path().join("absent")).err(),
            Some(LegacyUnsealError::Unavailable)
        );
    }
}

fn env_of<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
    move |name| {
        pairs
            .iter()
            .find(|(k, _)| *k == name)
            .map(|(_, v)| (*v).to_owned())
    }
}

#[test]
fn kwallet_is_picked_for_kde_by_session_version() {
    assert_eq!(
        linux_kwallet(&env_of(&[("XDG_CURRENT_DESKTOP", "GNOME")])),
        None
    );
    assert_eq!(
        linux_kwallet(&env_of(&[
            ("XDG_CURRENT_DESKTOP", "ubuntu:KDE"),
            ("KDE_SESSION_VERSION", "6")
        ])),
        Some((
            "org.kde.kwalletd6".to_owned(),
            "/modules/kwalletd6".to_owned()
        ))
    );
    assert_eq!(
        linux_kwallet(&env_of(&[("DESKTOP_SESSION", "plasma")])),
        Some((
            "org.kde.kwalletd".to_owned(),
            "/modules/kwalletd".to_owned()
        ))
    );
    assert_eq!(linux_kwallet(&env_of(&[])), None);
}

fn exited(code: i32, stdout: &str) -> ToolRun {
    ToolRun::Exited {
        code,
        stdout: stdout.as_bytes().to_vec(),
        stderr: Vec::new(),
    }
}

#[test]
fn secret_service_is_read_with_secret_tool_lookup() {
    let calls = RefCell::new(Vec::new());
    let run = |file: &Path, args: &[&str], _: Duration| {
        calls
            .borrow_mut()
            .push(format!("{} {}", file.display(), args.join(" ")));
        if file == Path::new("/usr/bin/secret-tool") {
            ToolRun::SpawnFailed("No such file or directory".to_owned())
        } else {
            exited(0, "s3cret\n")
        }
    };
    assert_eq!(
        linux_v11_secret(&env_of(&[]), &run).as_deref(),
        Some("s3cret")
    );
    assert_eq!(
        calls.into_inner(),
        [
            "/usr/bin/secret-tool lookup xdg:schema chrome_libsecret_os_crypt_password_v2 application Relay",
            "/usr/local/bin/secret-tool lookup xdg:schema chrome_libsecret_os_crypt_password_v2 application Relay",
        ]
    );
    let missing = |_: &Path, _: &[&str], _: Duration| exited(1, "");
    assert_eq!(linux_v11_secret(&env_of(&[]), &missing), None);
}

#[test]
fn kwallet_is_read_through_busctl_and_its_handle_closed() {
    let calls = RefCell::new(Vec::new());
    let run = |file: &Path, args: &[&str], _: Duration| {
        assert_eq!(file, Path::new("/usr/bin/busctl"));
        let method = args[7];
        calls.borrow_mut().push(args[7..].join(" "));
        match method {
            "networkWallet" => exited(0, r#"{"type":"s","data":["kdewallet"]}"#),
            "open" => exited(0, r#"{"type":"i","data":[12]}"#),
            "hasEntry" => exited(0, r#"{"type":"b","data":[true]}"#),
            "readPassword" => exited(0, r#"{"type":"s","data":["kw-secret"]}"#),
            _ => exited(0, r#"{"type":"b","data":[true]}"#),
        }
    };
    let env = env_of(&[("XDG_CURRENT_DESKTOP", "KDE"), ("KDE_SESSION_VERSION", "5")]);
    assert_eq!(linux_v11_secret(&env, &run).as_deref(), Some("kw-secret"));
    assert_eq!(
        calls.into_inner(),
        [
            "networkWallet",
            "open sxs kdewallet 0 Relay",
            "hasEntry isss 12 Relay Keys Relay Safe Storage Relay",
            "readPassword isss 12 Relay Keys Relay Safe Storage Relay",
            "close ibs 12 false Relay",
        ]
    );
}
