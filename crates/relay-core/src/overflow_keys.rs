//! Port of `electron/core/overflow-keys.ts`: the gateway overflow's API keys, sealed like the
//! rest of the vault and kept by upstream id. The gateway reads them per request, so they stay
//! in memory once read; the page only ever gets a masked hint (`key_hint`).

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use indexmap::IndexMap;
use serde_json::Value;

use crate::desktop_files::{read_bytes, write_bytes};
use crate::shared::overflow::key_hint;
use crate::terminal_identity::{SealFn, UnsealFn};

/// Inside the vault: every overflow upstream's API key, in one sealed file.
const FILE: &str = "api-keys/overflow.bin";

/// Why the keys could not be read or saved.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct OverflowKeysError(pub String);

type Keys = IndexMap<String, String>;

struct Inner {
    vault: PathBuf,
    seal: SealFn,
    unseal: UnsealFn,
    keys: Mutex<Option<Keys>>,
    /// One read at a time: callers that come during a read wait for it.
    loading: Mutex<()>,
}

/// The overflow upstreams' keys. Clones share the keys.
#[derive(Clone)]
pub struct OverflowKeys(Arc<Inner>);

impl OverflowKeys {
    pub fn new(vault: impl Into<PathBuf>, seal: SealFn, unseal: UnsealFn) -> Self {
        OverflowKeys(Arc::new(Inner {
            vault: vault.into(),
            seal,
            unseal,
            keys: Mutex::new(None),
            loading: Mutex::new(()),
        }))
    }

    fn cached(&self) -> Option<Keys> {
        self.0
            .keys
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    fn load(&self) -> Result<Keys, OverflowKeysError> {
        if let Some(keys) = self.cached() {
            return Ok(keys);
        }
        let _one = self.0.loading.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(keys) = self.cached() {
            return Ok(keys);
        }
        let data = read_bytes(&self.0.vault, FILE).map_err(|e| OverflowKeysError(e.to_string()))?;
        let mut keys = Keys::new();
        if let Some(data) = data {
            let text = (self.0.unseal)(&data).map_err(OverflowKeysError)?;
            let parsed: Value =
                serde_json::from_str(&text).map_err(|e| OverflowKeysError(e.to_string()))?;
            if let Value::Object(map) = parsed {
                for (id, key) in map {
                    if let Value::String(key) = key
                        && !key.is_empty()
                    {
                        keys.insert(id, key);
                    }
                }
            }
        }
        *self.0.keys.lock().unwrap_or_else(|e| e.into_inner()) = Some(keys.clone());
        Ok(keys)
    }

    fn save(&self, keys: Keys) -> Result<(), OverflowKeysError> {
        let sealed = if keys.is_empty() {
            None
        } else {
            let text = serde_json::to_string(&keys).expect("strings always serialize");
            Some((self.0.seal)(&text).map_err(OverflowKeysError)?)
        };
        write_bytes(&self.0.vault, FILE, sealed.as_deref())
            .map_err(|e| OverflowKeysError(e.to_string()))?;
        *self.0.keys.lock().unwrap_or_else(|e| e.into_inner()) = Some(keys);
        Ok(())
    }

    pub fn get(&self, id: &str) -> Result<Option<String>, OverflowKeysError> {
        Ok(self.load()?.get(id).cloned())
    }

    pub fn set(&self, id: &str, key: &str) -> Result<(), OverflowKeysError> {
        let mut keys = self.load()?;
        keys.insert(
            id.to_owned(),
            crate::shared::types::js::trim(key).to_owned(),
        );
        self.save(keys)
    }

    pub fn remove(&self, id: &str) -> Result<(), OverflowKeysError> {
        let mut keys = self.load()?;
        if keys.shift_remove(id).is_none() {
            return Ok(());
        }
        self.save(keys)
    }

    /// Each saved key's masked hint, by upstream id; empty until the keys were read once (the
    /// first call starts that read in the background).
    pub fn hints(&self) -> IndexMap<String, String> {
        let Some(keys) = self.cached() else {
            let me = self.clone();
            std::thread::spawn(move || {
                let _ = me.load();
            });
            return IndexMap::new();
        };
        keys.iter()
            .map(|(id, key)| (id.clone(), key_hint(key)))
            .collect()
    }
}
