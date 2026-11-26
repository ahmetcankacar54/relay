//! Port of the `UsageManager` case of `tests/provider-sign-in-guards.test.ts`. Skipped: "sign-in
//! banners name Claude accounts only" (`src/app/Banners`, React UI), "the Claude Code sign-in
//! refuses a Codex or Antigravity account…" (main and window source text), "Google sends the
//! browser back to 51121…" and "a pasted callback address goes on only when…"
//! (`electron/core/antigravity-bridge`, another slice).

#[path = "common/usage_manager.rs"]
mod helpers;

use std::sync::Arc;

use helpers::*;
use relay_core::shared::types::{AccountKind, AccountProvider, UsageIssue};
use relay_core::usage::UsageManager;
use relay_core::usage_credentials::UsageError;

#[test]
fn a_codex_accounts_limits_are_never_read_through_a_claude_sign_in() {
    let t = temp_store("relay-provider-guards-");
    let now = ms("2026-11-09T12:00:00Z");
    let codex = create(
        &t.store,
        "OpenAI · Codex",
        AccountKind::Personal,
        Some(AccountProvider::Codex),
    );
    t.store
        .update(|s| s.accounts[0].auth = Some(auth(Some("dev@example.com"), &iso_at(now))))
        .unwrap();
    let credential_reads = Count::default();
    let requests = Count::default();
    let manager = {
        let (credential_reads, requests) = (credential_reads.clone(), requests.clone());
        UsageManager::new(
            t.store.clone(),
            deps(
                move |_, _| {
                    credential_reads.bump();
                    // "no Claude sign-in in a Codex profile"
                    Err(thrown())
                },
                move |_, _| {
                    requests.bump();
                    Err(UsageError::new(UsageIssue::Unavailable))
                },
                Arc::new(move || now),
            ),
        )
    };
    let usage = manager.refresh(&codex.id, false).unwrap();
    // Unsupported, not signed out: nothing offers a Claude sign-in for it.
    assert_eq!(usage.issue, Some(UsageIssue::Unsupported));
    assert_eq!(credential_reads.get(), 0);
    assert_eq!(requests.get(), 0, "no request for a Codex account");
}
