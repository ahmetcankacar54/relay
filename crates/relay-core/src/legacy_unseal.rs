//! Legacy (pre-v2) vault unsealing, for migration only: the bytes Electron's `safeStorage`
//! wrote, which are Chromium's OSCrypt layouts:
//! - macOS: `v10` ‖ AES-128-CBC (PKCS#7, IV 16 × 0x20), key PBKDF2-SHA1 of the Keychain item
//!   "Relay Safe Storage" password, salt `saltysalt`, 1003 iterations.
//! - Windows: `v10` ‖ 12-byte nonce ‖ AES-256-GCM (ciphertext ‖ tag), key from `Local State`
//!   `os_crypt.encrypted_key` (base64, `DPAPI` prefix, then DPAPI); older blobs are DPAPI whole.
//! - Linux: `v11` with the keyring secret (Secret Service `application` "Relay", or KWallet) or
//!   `v10` with "peanuts"; PBKDF2-SHA1 one iteration, AES-128-CBC, IV 16 × 0x20.
//!
//! Like OSCrypt, an empty blob opens as "" and one without a known prefix is old clear text.
