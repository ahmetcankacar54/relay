//! Port of `electron/core/vault-crypto.ts`: the vault's format 2.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};

use crate::legacy_unseal::LegacyUnsealError;

/// The first bytes of every format-2 sealed file.
pub const VAULT_MAGIC: &[u8; 4] = b"RLY2";
/// Authenticated with every format-2 file; no file of another purpose opens as one.
pub const VAULT_AAD: &[u8] = b"relay-vault:v2";
const NONCE: usize = 12;
const TAG: usize = 16;

/// Why a sealed file could not be opened: an older format, or damaged or foreign data.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum VaultFormatError {
    #[error(
        "This vault file is in the old format. Update Relay.app to 0.12 or later and open it once."
    )]
    Legacy,
    #[error("A vault file is damaged or was sealed with another key.")]
    Invalid,
}

/// A key that is not 32 bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("The vault key must be 32 bytes.")]
pub struct VaultKeyLengthError;

/// Why `Sealer::unseal` failed: the format, or the legacy unseal it handed the file to.
#[derive(Debug, thiserror::Error)]
pub enum UnsealError {
    #[error(transparent)]
    Format(#[from] VaultFormatError),
    #[error(transparent)]
    Legacy(#[from] LegacyUnsealError),
}

/// Opens a file of the format before 2 (Electron's safeStorage, during migration).
pub type LegacyUnseal =
    std::sync::Arc<dyn Fn(&[u8]) -> Result<String, LegacyUnsealError> + Send + Sync>;

pub fn is_sealed_v2(data: &[u8]) -> bool {
    data.starts_with(VAULT_MAGIC)
}

/// Seals text as `RLY2`, a 12-byte random nonce, the AES-256-GCM ciphertext and its 16-byte
/// tag. Opening checks the tag, so a damaged file is refused whole. A file in another format
/// goes to the legacy unseal, or is refused as legacy.
pub struct Sealer {
    cipher: Aes256Gcm,
    legacy: Option<LegacyUnseal>,
}

impl Sealer {
    pub fn new(key: &[u8]) -> Result<Self, VaultKeyLengthError> {
        Ok(Self {
            cipher: Aes256Gcm::new_from_slice(key).map_err(|_| VaultKeyLengthError)?,
            legacy: None,
        })
    }

    /// A sealer that hands files of another format to `legacy`.
    pub fn with_legacy(key: &[u8], legacy: LegacyUnseal) -> Result<Self, VaultKeyLengthError> {
        let mut sealer = Self::new(key)?;
        sealer.legacy = Some(legacy);
        Ok(sealer)
    }

    pub fn seal(&self, text: &str) -> Vec<u8> {
        let mut nonce = [0u8; NONCE];
        getrandom::fill(&mut nonce).expect("the OS random source failed");
        let body = self
            .cipher
            .encrypt(
                &Nonce::from(nonce),
                Payload {
                    msg: text.as_bytes(),
                    aad: VAULT_AAD,
                },
            )
            .expect("AES-GCM sealing cannot fail below its 64 GiB limit");
        let mut out = Vec::with_capacity(VAULT_MAGIC.len() + NONCE + body.len());
        out.extend_from_slice(VAULT_MAGIC);
        out.extend_from_slice(&nonce);
        out.extend_from_slice(&body);
        out
    }

    pub fn unseal(&self, data: &[u8]) -> Result<String, UnsealError> {
        if !is_sealed_v2(data) {
            return match &self.legacy {
                Some(legacy) => Ok(legacy(data)?),
                None => Err(VaultFormatError::Legacy.into()),
            };
        }
        if data.len() < VAULT_MAGIC.len() + NONCE + TAG {
            return Err(VaultFormatError::Invalid.into());
        }
        let nonce = Nonce::try_from(&data[4..4 + NONCE]).map_err(|_| VaultFormatError::Invalid)?;
        let plain = self
            .cipher
            .decrypt(
                &nonce,
                Payload {
                    msg: &data[4 + NONCE..],
                    aad: VAULT_AAD,
                },
            )
            .map_err(|_| VaultFormatError::Invalid)?;
        // Node's `toString("utf8")`: invalid sequences become U+FFFD, never an error.
        Ok(String::from_utf8_lossy(&plain).into_owned())
    }
}
