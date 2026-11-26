//! A throwaway Ed25519 key for update tests, in the formats the release scripts use.
#![allow(dead_code)]

use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};

const SPKI_HEADER: [u8; 12] = [
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];

pub struct TestKey(SigningKey);

impl TestKey {
    pub fn new(seed: u8) -> TestKey {
        TestKey(SigningKey::from_bytes(&[seed; 32]))
    }

    /// The public key as SPKI DER in base64, as `publicKeyBase64` writes it.
    pub fn public_key(&self) -> String {
        let mut der = SPKI_HEADER.to_vec();
        der.extend_from_slice(self.0.verifying_key().as_bytes());
        base64::engine::general_purpose::STANDARD.encode(der)
    }

    /// The signature of `text` in base64, as `signSums` writes it.
    pub fn sign(&self, text: &str) -> String {
        base64::engine::general_purpose::STANDARD.encode(self.0.sign(text.as_bytes()).to_bytes())
    }
}

/// An RSA public key (SPKI DER, base64): a key of another kind.
pub const RSA_PUBLIC_KEY: &str = "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC6pKZHCzTWtfu5Ie4Ktnkd7+V7HZLX2b8ClpA/ooavPBiq/q4IuArdMF3jABSqHBXgQiNzVXNXXf1NvsYVgOU48EYiJRM9U01dnTLQckMb2dhaM6bgBQZftb0F1/0+d78H4DpqWjEcYBlktJDwr+mh/B+dRauv2exI5LZ23aV4iwIDAQAB";

pub fn sha256_hex(data: &[u8]) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(data)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
