//! How a gateway host reuses a sign-in it read (`startProxy` in `electron/main/gateway.ts`,
//! `relay proxy start` in the CLI): a token is reused for 20 s, never past its expiry, and
//! dropped at once when the upstream refuses it, so a burst does not ask the Keychain per
//! request.

use std::collections::HashMap;
use std::sync::Mutex;

/// How long a read sign-in is reused before the Keychain is asked again.
pub const CREDENTIAL_TTL_MS: i64 = 20_000;

/// A sign-in as the host read it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReadCredential {
    pub access_token: String,
    /// When the token stops working (ms); `None` when the sign-in does not say.
    pub expires_at: Option<i64>,
}

#[derive(Default)]
pub struct CredentialCache {
    entries: Mutex<HashMap<String, (String, i64)>>,
}

impl CredentialCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// The cached token, while it is fresh.
    pub fn get(&self, account_id: &str, now: i64) -> Option<String> {
        let mut entries = self.entries.lock().unwrap();
        match entries.get(account_id) {
            Some((token, until)) if *until > now => Some(token.clone()),
            Some(_) => {
                entries.remove(account_id);
                None
            }
            None => None,
        }
    }

    /// The token the gateway may send for a sign-in just read: `None` (and nothing kept) when
    /// it has expired, since it would only earn a 401.
    pub fn accept(&self, account_id: &str, credential: ReadCredential, now: i64) -> Option<String> {
        if credential.expires_at.is_some_and(|at| at <= now) {
            self.forget(account_id);
            return None;
        }
        let until = (now + CREDENTIAL_TTL_MS).min(credential.expires_at.unwrap_or(i64::MAX));
        self.entries.lock().unwrap().insert(
            account_id.to_string(),
            (credential.access_token.clone(), until),
        );
        Some(credential.access_token)
    }

    /// The upstream refused the token: it is read again next time.
    pub fn forget(&self, account_id: &str) {
        self.entries.lock().unwrap().remove(account_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_token_is_reused_for_twenty_seconds_never_past_its_expiry() {
        let cache = CredentialCache::new();
        let read = |expires_at| ReadCredential {
            access_token: "tok".into(),
            expires_at,
        };
        assert_eq!(cache.accept("a", read(Some(1_000)), 1_000), None, "expired");
        assert_eq!(cache.get("a", 1_000), None);
        assert_eq!(cache.accept("a", read(None), 0).as_deref(), Some("tok"));
        assert_eq!(cache.get("a", 19_999).as_deref(), Some("tok"));
        assert_eq!(cache.get("a", 20_000), None);
        cache.accept("b", read(Some(5_000)), 0);
        assert_eq!(cache.get("b", 5_000), None, "not past its expiry");
        cache.accept("c", read(None), 0);
        cache.forget("c");
        assert_eq!(cache.get("c", 1), None);
    }
}
