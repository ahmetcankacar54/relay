//! Port of `electron/core/cookie-vault.ts`: the browser profile's claude.ai logins, one per
//! account, sealed like the rest of the vault.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::LazyLock;

use indexmap::IndexMap;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::cookie_store::{
    CookieSnapshot, decode_snapshot, encode_snapshot, login_id, org_fingerprint,
};
use crate::desktop_files::{read_bytes, write_bytes};
use crate::draft_vault::VaultError;
use crate::draft_vault::{Clock, Seal, Unseal, system_clock};
use crate::extension_vault::list_saved;
use crate::fs_util::{iso_timestamp, parse_iso_ms};
use crate::shared::browser_extension::{BrokenSignIn, SavedSignIn};
use crate::shared::extension_auth::is_account_uuid;

/// Inside the vault, one sealed file per account: `extension-cookies/<account uuid>.bin`.
const DIR: &str = "extension-cookies";
/// The logins the extension could not sign in with, per account; not an account's file.
const REJECTED: &str = "extension-cookies/rejected.bin";
/// The organization each account's saved login was on (`org_fingerprint`), kept after the login
/// itself is forgotten, so a fresh login on that organization can still be told to be its.
const ORGS: &str = "extension-cookies/orgs.bin";

/// One account's rejected logins (`login_id`s), when the last was rejected, and whether it still
/// waits.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Rejection {
    logins: Vec<String>,
    at: String,
    /// No working sign-in of the account was seen since: the user still has to reconnect.
    open: bool,
}

fn invalid(message: &str) -> VaultError {
    VaultError::Invalid(message.to_owned())
}

fn file(account_uuid: &str) -> Result<String, VaultError> {
    if !is_account_uuid(account_uuid) {
        return Err(invalid("Invalid account uuid."));
    }
    Ok(format!("{DIR}/{}.bin", account_uuid.to_lowercase()))
}

/// The browser profile's claude.ai logins, one per account, sealed like the rest of the vault.
/// Each is kept under the account uuid the extension said it belonged to when it was saved, so a
/// login can never be put in place for another account. The cookie values stay encrypted by the
/// browser: Relay never decrypts them.
pub struct CookieVault {
    vault: PathBuf,
    seal: Seal,
    unseal: Unseal,
    now: Clock,
}

impl CookieVault {
    pub fn new(vault: impl Into<PathBuf>, seal: Seal, unseal: Unseal, now: Option<Clock>) -> Self {
        CookieVault {
            vault: vault.into(),
            seal,
            unseal,
            now: now.unwrap_or_else(system_clock),
        }
    }

    fn open(&self, data: &[u8]) -> Result<Value, VaultError> {
        let text = (self.unseal)(data).map_err(VaultError::Unseal)?;
        Ok(serde_json::from_str(&text)?)
    }

    fn write_sealed(&self, relative: &str, value: &Value) -> Result<(), VaultError> {
        let sealed = (self.seal)(&value.to_string()).map_err(VaultError::Seal)?;
        write_bytes(&self.vault, relative, Some(&sealed))?;
        Ok(())
    }

    /// Keeps `snapshot` as the account's login, replacing the one saved.
    pub fn save(&self, account_uuid: &str, snapshot: &CookieSnapshot) -> Result<(), VaultError> {
        if !is_account_uuid(account_uuid) {
            return Err(invalid("This login names no account."));
        }
        let account = account_uuid.to_lowercase();
        let encoded = encode_snapshot(snapshot);
        // Refuses rows that are not part of a login before anything is sealed.
        decode_snapshot(&encoded).map_err(|e| invalid(&e.to_string()))?;
        let record = json!({
            "accountUuid": account,
            "savedAt": iso_timestamp((self.now)()),
            "snapshot": encoded,
        });
        self.write_sealed(&file(account_uuid)?, &record)?;
        if let Some(org) = org_fingerprint(snapshot) {
            let mut orgs = self.orgs();
            if orgs.get(&account) != Some(&org) {
                orgs.insert(account, org);
                self.write_sealed(ORGS, &json!({ "accounts": orgs }))?;
            }
        }
        Ok(())
    }

    /// The organization fingerprint of each account's last saved login, by account uuid.
    pub fn orgs(&self) -> IndexMap<String, String> {
        let mut out = IndexMap::new();
        let Ok(Some(data)) = read_bytes(&self.vault, ORGS) else {
            return out;
        };
        let Ok(value) = self.open(&data) else {
            return out;
        };
        if let Some(accounts) = value.get("accounts").and_then(Value::as_object) {
            for (uuid, org) in accounts {
                if let Some(org) = org.as_str().filter(|o| !o.is_empty())
                    && is_account_uuid(uuid)
                {
                    out.insert(uuid.to_lowercase(), org.to_owned());
                }
            }
        }
        out
    }

    /// The login saved for the first of `account_uuids` that has one; None when none does. Fails
    /// when a file is damaged, sealed with another key, names another account or holds rows that
    /// are not a login.
    pub fn load(&self, account_uuids: &[String]) -> Result<Option<CookieSnapshot>, VaultError> {
        for account_uuid in account_uuids {
            let Some(data) = read_bytes(&self.vault, &file(account_uuid)?)? else {
                continue;
            };
            let record = self.open(&data)?;
            if record.get("accountUuid").and_then(Value::as_str)
                != Some(account_uuid.to_lowercase().as_str())
            {
                return Err(invalid("Invalid saved claude.ai login."));
            }
            let snapshot = record.get("snapshot").unwrap_or(&Value::Null);
            return decode_snapshot(snapshot)
                .map(Some)
                .map_err(|e| invalid(&e.to_string()));
        }
        Ok(None)
    }

    /// Forgets the login saved for `account_uuid`: it was put in place and the extension could not
    /// sign in to that account with it. Its identity is kept, so the same login is never saved for
    /// that account again (`is_rejected`), and the account waits for a reconnect (`waiting`).
    pub fn reject(&self, account_uuid: &str) -> Result<(), VaultError> {
        let account = account_uuid.to_lowercase();
        let saved = self.load(std::slice::from_ref(&account)).ok().flatten();
        let id = saved.as_ref().and_then(login_id);
        let mut all = self.rejections();
        let mut logins: Vec<String> = Vec::new();
        let before = all
            .get(&account)
            .map(|r| r.logins.clone())
            .unwrap_or_default();
        let mut seen = HashSet::new();
        for login in before.into_iter().chain(id) {
            if seen.insert(login.clone()) {
                logins.push(login);
            }
        }
        // The newest few are enough: a login is rejected once, and logins come seldom.
        let skip = logins.len().saturating_sub(20);
        logins.drain(..skip);
        all.insert(
            account.clone(),
            Rejection {
                logins,
                at: iso_timestamp((self.now)()),
                open: true,
            },
        );
        self.write_rejections(&all)?;
        write_bytes(&self.vault, &file(&account)?, None)?;
        Ok(())
    }

    /// Whether `snapshot` is a login the extension could not sign in to `account_uuid` with.
    pub fn is_rejected(&self, account_uuid: &str, snapshot: &CookieSnapshot) -> bool {
        let Some(id) = login_id(snapshot) else {
            return false;
        };
        self.rejections()
            .get(&account_uuid.to_lowercase())
            .is_some_and(|r| r.logins.contains(&id))
    }

    /// The account that still waits for a reconnect after a rejected login, the newest first.
    pub fn waiting(&self) -> Option<BrokenSignIn> {
        let mut open: Vec<(String, Rejection)> = self
            .rejections()
            .into_iter()
            .filter(|(_, r)| r.open)
            .collect();
        // `Date.parse(b.at) - Date.parse(a.at)`: an unreadable time compares as equal.
        open.sort_by(
            |(_, a), (_, b)| match (parse_iso_ms(&a.at), parse_iso_ms(&b.at)) {
                (Some(x), Some(y)) => y.cmp(&x),
                _ => std::cmp::Ordering::Equal,
            },
        );
        open.into_iter()
            .next()
            .map(|(account_uuid, r)| BrokenSignIn {
                account_uuid,
                at: r.at,
            })
    }

    /// Whether the account still waits for a reconnect.
    pub fn is_waiting(&self, account_uuid: &str) -> bool {
        self.rejections()
            .get(&account_uuid.to_lowercase())
            .is_some_and(|r| r.open)
    }

    /// The account signed in fine again: it waits no more; its rejected logins stay rejected.
    pub fn reconnected(&self, account_uuid: &str) -> Result<(), VaultError> {
        let mut all = self.rejections();
        let Some(entry) = all.get_mut(&account_uuid.to_lowercase()) else {
            return Ok(());
        };
        if !entry.open {
            return Ok(());
        }
        entry.open = false;
        self.write_rejections(&all)
    }

    fn rejections(&self) -> IndexMap<String, Rejection> {
        static LOGIN: LazyLock<Regex> =
            LazyLock::new(|| Regex::new("^[0-9]{1,20}$").expect("static"));
        let mut out = IndexMap::new();
        let Ok(Some(data)) = read_bytes(&self.vault, REJECTED) else {
            return out;
        };
        let Ok(value) = self.open(&data) else {
            return out;
        };
        let Some(accounts) = value.get("accounts").and_then(Value::as_object) else {
            return out;
        };
        for (uuid, r) in accounts {
            let logins = r.get("logins").and_then(Value::as_array).and_then(|list| {
                list.iter()
                    .map(|x| x.as_str().filter(|x| LOGIN.is_match(x)).map(str::to_owned))
                    .collect::<Option<Vec<_>>>()
            });
            let at = r.get("at").and_then(Value::as_str);
            if let (true, Some(logins), Some(at)) = (is_account_uuid(uuid), logins, at) {
                out.insert(
                    uuid.to_lowercase(),
                    Rejection {
                        logins,
                        at: at.to_owned(),
                        open: r.get("open") == Some(&Value::Bool(true)),
                    },
                );
            }
        }
        out
    }

    fn write_rejections(&self, all: &IndexMap<String, Rejection>) -> Result<(), VaultError> {
        self.write_sealed(REJECTED, &json!({ "accounts": all }))
    }

    /// When each account's login was saved, from the files; nothing is opened.
    pub fn list(&self) -> Vec<SavedSignIn> {
        list_saved(&self.vault, DIR)
    }
}
