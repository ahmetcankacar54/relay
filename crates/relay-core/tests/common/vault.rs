//! Test helpers for the vault slice: a `security` stand-in mirroring `tests/fake-security.ts`
//! and the fake old seal of the TS vault tests.
#![allow(dead_code)]

use std::fs;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use relay_core::legacy_unseal::LegacyUnsealError;

const FAKE_SECURITY: &str = r#"#!/bin/sh
dir="$(dirname "$0")"
echo "$*" >> "$dir/argv.log"
svc=""; prev=""
for a in "$@"; do if [ "$prev" = "-s" ]; then svc="$a"; fi; prev="$a"; done
key="$(printf '%s' "$svc" | tr -c 'A-Za-z0-9' '_')"
if [ "$1" = "-i" ]; then
  input="$(cat)"
  printf '%s\n' "$input" >> "$dir/stdin.log"
  value="$(printf '%s\n' "$input" | grep add-generic-password | sed -E 's/.* -w ([^ ]+).*/\1/' | head -1)"
  if [ ! -f "$dir/item-Relay_Vault_Key" ] && [ -n "$value" ]; then printf '%s' "$value" > "$dir/item-Relay_Vault_Key"; fi
  exit 0
fi
if [ "$1" = "find-generic-password" ]; then
  [ -f "$dir/force-exit" ] && exit "$(cat "$dir/force-exit")"
  if [ "$key" = "Relay_Vault_Key" ] && [ -f "$dir/race" ] && [ ! -f "$dir/race-done" ]; then touch "$dir/race-done"; cp "$dir/race" "$dir/item-Relay_Vault_Key"; exit 44; fi
  [ -f "$dir/item-$key" ] || exit 44
  cat "$dir/item-$key"; echo
  exit 0
fi
exit 9
"#;

/// A stand-in for /usr/bin/security in a temp folder: it logs argv and stdin, and serves a
/// one-item "keychain" file. Never the real tool. On Windows the script cannot run, so every
/// call fails to start, as the TS tests' stand-in does there.
pub struct FakeSecurity {
    dir: tempfile::TempDir,
    tool: PathBuf,
}

#[derive(Default)]
pub struct Options<'a> {
    pub stored: Option<&'a str>,
    pub exit: Option<i32>,
    pub store_on_first_find: Option<&'a str>,
}

impl FakeSecurity {
    pub fn new(options: Options<'_>) -> Self {
        let dir = tempfile::Builder::new()
            .prefix("relay-fake-security-")
            .tempdir()
            .unwrap();
        let tool = dir.path().join("security");
        fs::write(&tool, FAKE_SECURITY).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&tool, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let f = Self { dir, tool };
        if let Some(stored) = options.stored {
            fs::write(f.path("item-Relay_Vault_Key"), stored).unwrap();
        }
        if let Some(exit) = options.exit {
            fs::write(f.path("force-exit"), exit.to_string()).unwrap();
        }
        if let Some(winner) = options.store_on_first_find {
            fs::write(f.path("race"), winner).unwrap();
        }
        f
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir.path().join(name)
    }

    fn read(&self, name: &str) -> String {
        fs::read_to_string(self.path(name)).unwrap_or_default()
    }

    pub fn tool(&self) -> &Path {
        &self.tool
    }

    pub fn argv_log(&self) -> String {
        self.read("argv.log")
    }

    pub fn stdin_log(&self) -> String {
        self.read("stdin.log")
    }

    pub fn stored(&self) -> String {
        self.read("item-Relay_Vault_Key")
    }
}

/// The TS tests' stand-in for safeStorage: `v10` and the text in base64.
pub fn legacy_seal(text: &str) -> Vec<u8> {
    format!("v10{}", STANDARD.encode(text)).into_bytes()
}

/// Opens `legacy_seal` output; anything else (or text holding `BROKEN`) does not open.
pub fn legacy_unseal(data: &[u8]) -> Result<String, LegacyUnsealError> {
    let text = String::from_utf8_lossy(data);
    let Some(body) = text.strip_prefix("v10") else {
        return Err(LegacyUnsealError::Decrypt);
    };
    if text.contains("BROKEN") {
        return Err(LegacyUnsealError::Decrypt);
    }
    STANDARD
        .decode(body)
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .map_err(|_| LegacyUnsealError::Decrypt)
}
