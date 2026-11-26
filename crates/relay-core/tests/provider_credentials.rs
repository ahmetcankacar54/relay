//! Port of `tests/provider-credentials.test.ts`.

use std::fs;
use std::path::{Path, PathBuf};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use relay_core::provider_credentials::{
    CodexCredential, CodexCredentialKind, CodexReadOptions, read_codex_credential,
    write_codex_credential,
};
use serde_json::{Value, json};

const ID: &str = "33333333-3333-4333-8333-333333333333";

fn jwt(payload: &Value) -> String {
    format!("h.{}.s", URL_SAFE_NO_PAD.encode(payload.to_string()))
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as f64
}

fn dirs() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let root = tempfile::Builder::new()
        .prefix("relay-codex-cred-")
        .tempdir()
        .unwrap();
    let profile = root.path().join("profile");
    let cli = root.path().join("codex-auth.json");
    (root, profile, cli)
}

fn options(now: Option<f64>, cli: &Path) -> CodexReadOptions {
    CodexReadOptions {
        now,
        cli_files: Some(vec![cli.to_path_buf()]),
    }
}

#[test]
fn a_codex_sign_in_follows_the_codex_cli_s_fresh_token_while_it_is_the_same_chatgpt_account() {
    let (_root, profile, cli) = dirs();
    let now = now_ms();
    let secs = (now / 1000.0).floor() as i64;
    let old = jwt(&json!({ "exp": secs + 60 }));
    write_codex_credential(
        &profile,
        &CodexCredential {
            kind: CodexCredentialKind::Chatgpt,
            access_token: old.clone(),
            expires_at: Some(now + 60_000.0),
            account_id: Some(ID.into()),
        },
    )
    .unwrap();
    let fresh = jwt(&json!({ "exp": secs + 86_400 }));
    fs::write(
        &cli,
        json!({ "tokens": { "access_token": fresh, "account_id": ID } }).to_string(),
    )
    .unwrap();
    let read = read_codex_credential(&profile, &options(Some(now), &cli));
    assert_eq!(read.map(|r| r.access_token), Some(fresh.clone()));
    // The CLI signed in to another ChatGPT account: the saved copy is used, never the other one.
    fs::write(
        &cli,
        json!({ "tokens": { "access_token": fresh, "account_id": "other" } }).to_string(),
    )
    .unwrap();
    assert_eq!(
        read_codex_credential(&profile, &options(Some(now), &cli)).map(|r| r.access_token),
        Some(old)
    );
    // And once the saved copy expires there is no credential at all.
    assert_eq!(
        read_codex_credential(&profile, &options(Some(now + 120_000.0), &cli)),
        None
    );
}

#[test]
fn an_api_key_never_expires_and_a_0_18_account_s_credentials_json_is_still_read_with_the_access_token_s_expiry()
 {
    let (_root, profile, cli) = dirs();
    write_codex_credential(
        &profile,
        &CodexCredential {
            kind: CodexCredentialKind::ApiKey,
            access_token: "sk-x".into(),
            expires_at: None,
            account_id: None,
        },
    )
    .unwrap();
    assert_eq!(
        read_codex_credential(&profile, &options(None, &cli)),
        Some(CodexCredential {
            kind: CodexCredentialKind::ApiKey,
            access_token: "sk-x".into(),
            expires_at: None,
            account_id: None,
        })
    );

    let legacy = profile.parent().unwrap().join("legacy");
    fs::create_dir(&legacy).unwrap();
    let exp = (now_ms() / 1000.0).floor() as i64 + 3600;
    fs::write(
        legacy.join(".credentials.json"),
        json!({ "claudeAiOauth": { "accessToken": jwt(&json!({ "exp": exp })), "expiresAt": now_ms() - 1.0 } })
            .to_string(),
    )
    .unwrap();
    let read = read_codex_credential(&legacy, &options(None, &cli)).unwrap();
    assert_eq!(read.kind, CodexCredentialKind::Chatgpt);
    assert_eq!(
        read.expires_at,
        Some(exp as f64 * 1000.0),
        "the id token's earlier expiry no longer counts"
    );
}
