//! Which account each session is bound to, so its prompt cache stays warm
//! (`proxy-session-cache.ts`).

use crate::js::{Clock, system_clock};
use crate::types::{ProxyConfig, ProxySessionState};
use indexmap::IndexMap;

/// Upper bound on remembered sessions; the least recently used go first.
pub const DEFAULT_MAX_SESSIONS: usize = 10_000;

#[derive(Default)]
pub struct SessionCacheOptions {
    pub ttl_seconds: Option<f64>,
    pub max_entries: Option<usize>,
    pub now: Option<Clock>,
}

pub struct ProxySessionCache {
    /// Insertion order is last-use order: a touched session is re-inserted at the end.
    sessions: IndexMap<String, ProxySessionState>,
    ttl_ms: f64,
    max_entries: usize,
    now: Clock,
}

impl Default for ProxySessionCache {
    fn default() -> Self {
        Self::new(SessionCacheOptions::default())
    }
}

impl ProxySessionCache {
    pub fn new(options: SessionCacheOptions) -> Self {
        ProxySessionCache {
            sessions: IndexMap::new(),
            ttl_ms: options
                .ttl_seconds
                .unwrap_or(ProxyConfig::default().affinity_ttl_seconds)
                * 1000.0,
            max_entries: options.max_entries.unwrap_or(DEFAULT_MAX_SESSIONS).max(1),
            now: options.now.unwrap_or_else(system_clock),
        }
    }

    /// A cache on the given clock with the default lifetime.
    pub fn with_clock(now: Clock) -> Self {
        Self::new(SessionCacheOptions {
            now: Some(now),
            ..Default::default()
        })
    }

    pub fn set_ttl(&mut self, ttl_seconds: f64) {
        if ttl_seconds.is_finite() && ttl_seconds > 0.0 {
            self.ttl_ms = ttl_seconds * 1000.0;
        }
    }

    fn expired(&self, session: &ProxySessionState, now: i64) -> bool {
        (now - session.last_active_at) as f64 > self.ttl_ms
    }

    /// The account bound to this session if it has not expired; counts as a use.
    pub fn get(&mut self, session_key: &str) -> Option<String> {
        let now = (self.now)();
        let existing = self.sessions.get(session_key)?;
        if self.expired(existing, now) {
            self.sessions.shift_remove(session_key);
            return None;
        }
        let mut session = self.sessions.shift_remove(session_key)?;
        session.last_active_at = now;
        session.request_count += 1;
        let account = session.account_id.clone();
        self.sessions.insert(session_key.to_string(), session);
        Some(account)
    }

    /// The account a live session is bound to, without counting it as a use.
    pub fn peek(&self, session_key: &str) -> Option<String> {
        let existing = self.sessions.get(session_key)?;
        (!self.expired(existing, (self.now)())).then(|| existing.account_id.clone())
    }

    /// When a live session last changed account, if it ever did.
    pub fn moved_at(&self, session_key: &str) -> Option<i64> {
        self.sessions.get(session_key)?.moved_at
    }

    /// Binds a session to an account.
    pub fn set(&mut self, session_key: &str, account_id: &str) {
        let now = (self.now)();
        let next = match self.sessions.shift_remove(session_key) {
            Some(existing) => ProxySessionState {
                moved_at: if existing.account_id != account_id {
                    Some(now)
                } else {
                    existing.moved_at
                },
                account_id: account_id.to_string(),
                last_active_at: now,
                request_count: existing.request_count + 1,
                ..existing
            },
            None => ProxySessionState {
                session_key: session_key.to_string(),
                account_id: account_id.to_string(),
                assigned_at: now,
                last_active_at: now,
                request_count: 1,
                moved_at: None,
            },
        };
        self.sessions.insert(session_key.to_string(), next);
        self.prune();
        if self.sessions.len() > self.max_entries {
            let excess = self.sessions.len() - self.max_entries;
            self.sessions.drain(..excess);
        }
    }

    /// Removes every session bound to an account (it hit a limit); answers how many.
    pub fn evict_account(&mut self, account_id: &str) -> usize {
        let before = self.sessions.len();
        self.sessions.retain(|_, s| s.account_id != account_id);
        before - self.sessions.len()
    }

    /// Removes one session.
    pub fn evict_session(&mut self, session_key: &str) -> bool {
        self.sessions.shift_remove(session_key).is_some()
    }

    /// The live sessions, oldest use first.
    pub fn list(&mut self) -> Vec<ProxySessionState> {
        self.prune();
        self.sessions.values().cloned().collect()
    }

    /// How many live sessions there are.
    pub fn count(&mut self) -> usize {
        self.prune();
        self.sessions.len()
    }

    pub fn clear(&mut self) {
        self.sessions.clear();
    }

    /// Drops expired sessions from the old end; stops at the first live one.
    fn prune(&mut self) {
        let cutoff = (self.now)() as f64 - self.ttl_ms;
        let stale = self
            .sessions
            .values()
            .take_while(|s| (s.last_active_at as f64) < cutoff)
            .count();
        if stale > 0 {
            self.sessions.drain(..stale);
        }
    }
}
