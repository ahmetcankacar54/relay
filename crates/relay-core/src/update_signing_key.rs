//! Port of `electron/core/update-signing-key.ts`.

/// The public half of the Ed25519 key that signs each release's SHA256SUMS.txt, as SPKI DER in
/// base64 (fingerprint sha256:13fd553596797877597e1b4bfe7c5d8020bfc45e1ca11ee3675a62183273b4b4).
/// Windows and Linux updates install only when sums signed by this key list the downloaded
/// installer. The private half never enters the repository: see scripts/update-signing.mjs.
pub const UPDATE_SIGNING_PUBLIC_KEY: &str =
    "MCowBQYDK2VwAyEAa/6A8ozVRHKMFUYNkgyK8tF7eBdUpjcfDVPsCPvqMrA=";
