//! Chromium cookie fixtures and claude.ai answers, as `tests/desktop-usage.test.ts` builds them.
#![allow(dead_code)]

use std::path::Path;

use aes::Aes128;
use cbc::cipher::block_padding::Pkcs7;
use cbc::cipher::{BlockModeEncrypt, KeyIvInit};
use relay_core::desktop_usage::{CookieFiles, WebResponse, cookie_key};
use relay_core::shared::types::{Account, AccountDesktop};
use sha2::{Digest, Sha256};

pub const PASSWORD: &str = "fixture-safe-storage-password";
pub const ACCOUNT: &str = "0d1e2f3a-38b0-4c1f-9d39-6f1f4c0a1b2c";
pub const ORG: &str = "11111111-2222-4333-8444-555555555555";

pub fn key() -> [u8; 16] {
    cookie_key(PASSWORD)
}

/// AES-128-CBC, PKCS#7, an IV of 16 spaces.
pub fn cbc_encrypt(key: &[u8; 16], plain: &[u8]) -> Vec<u8> {
    let mut buf = vec![0u8; plain.len() + 16];
    buf[..plain.len()].copy_from_slice(plain);
    cbc::Encryptor::<Aes128>::new(key.into(), &[0x20u8; 16].into())
        .encrypt_padded::<Pkcs7>(&mut buf, plain.len())
        .unwrap()
        .to_vec()
}

/// Encrypts like Chromium, database version 24 and later: `prefix` ‖ CBC(SHA-256(host) ‖ value).
pub fn encrypt_with(value: &str, host: &str, prefix: &str, key: &[u8; 16]) -> Vec<u8> {
    let plain = [Sha256::digest(host.as_bytes()).as_slice(), value.as_bytes()].concat();
    [prefix.as_bytes(), &cbc_encrypt(key, &plain)].concat()
}

/// Encrypts like Chromium on macOS with the fixture's Safe Storage key.
pub fn encrypt(value: &str, host: &str) -> Vec<u8> {
    encrypt_with(value, host, "v10", &key())
}

/// A fresh temporary folder, removed on drop.
pub fn temp(prefix: &str) -> tempfile::TempDir {
    tempfile::Builder::new().prefix(prefix).tempdir().unwrap()
}

/// `{ Cookies: bytes }`.
pub fn files(name: &str, bytes: Option<Vec<u8>>) -> CookieFiles {
    CookieFiles::from([(name.to_owned(), bytes)])
}

/// A version-24 cookie database with these `(host, name, value)` rows, encrypted, as its bytes.
pub fn cookie_database(rows: &[(&str, &str, &str)]) -> CookieFiles {
    let dir = temp("relay-desktop-usage-");
    let file = dir.path().join("Cookies");
    let db = rusqlite::Connection::open(&file).unwrap();
    db.execute_batch(
        "create table meta (key text primary key, value text);
         insert into meta values ('version', '24');
         create table cookies (host_key text, name text, value text, encrypted_value blob);",
    )
    .unwrap();
    for (host, name, value) in rows {
        db.execute(
            "insert into cookies values (?, ?, '', ?)",
            rusqlite::params![host, name, encrypt(value, host)],
        )
        .unwrap();
    }
    drop(db);
    files("Cookies", Some(std::fs::read(&file).unwrap()))
}

pub fn json(status: u16, body: &str) -> WebResponse {
    WebResponse {
        status,
        content_type: "application/json".into(),
        retry_after: None,
        body: body.into(),
        cf_mitigated: None,
    }
}

/// The fixture's account, signed in to the Claude app only.
pub fn account() -> Account {
    let mut a = Account::new("a", "A");
    a.group = "g".into();
    a.color = "#000".into();
    a.created_at = "2026-11-01T00:00:00.000Z".into();
    a.desktop = Some(desktop());
    a
}

pub fn desktop() -> AccountDesktop {
    AccountDesktop {
        account_uuid: ACCOUNT.into(),
        org_id: ORG.into(),
        saved_at: "2026-11-01T00:00:00.000Z".into(),
        ..AccountDesktop::default()
    }
}

/// A shell stand-in for `security` with this body, mode 0755.
#[cfg(unix)]
pub fn tool(dir: &Path, body: &str) -> std::path::PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let tool = dir.join("security");
    std::fs::write(&tool, format!("#!/bin/sh\n{body}")).unwrap();
    std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).unwrap();
    tool
}

/// Lines in the stand-in's call log; an error when it never ran.
pub fn log_lines(log: &Path) -> std::io::Result<Vec<String>> {
    Ok(std::fs::read_to_string(log)?
        .trim()
        .split('\n')
        .map(str::to_owned)
        .collect())
}
