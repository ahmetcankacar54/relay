//! Port of the `UsageManager` cases of `tests/limit-origin.test.ts`. Skipped: "a window whose
//! reset passed since its reading is Relay's estimate", "an untagged window takes its source…"
//! (`shared/quota-windows` `limitOrigin`, another slice), "rows, columns and the headline keep
//! each window's source" (`src/data/selectors` and `shared/quota-windows`), "the tooltip names
//! each source…" and "a limit line's tooltip ends with its source and age" (React UI in `src/`).

#[path = "common/usage_manager.rs"]
mod helpers;

use std::sync::Arc;

use helpers::*;
use relay_core::provider_usage::ProviderUsageResult;
use relay_core::shared::types::UsageIssue;
use relay_core::shared::types::{
    AccountKind, AccountProvider, LimitSource, ModelWindow, ModelWindowPeriod, UsageWindow,
};
use relay_core::usage::{
    DesktopUsageSource, LiveLimits, LiveModel, UsageEndpoint, UsageLimits, UsageManager,
};
use relay_core::usage_credentials::UsageError;
use serde_json::{Value, json};

fn now_at() -> i64 {
    ms("2026-11-20T12:00:00Z")
}

fn at() -> String {
    iso_at(now_at())
}

fn cred() -> relay_core::usage_credentials::UsageCredential {
    credential(
        "fixture-secret-never-rendered",
        Some((now_at() + 3_600_000) as f64),
        &["user:profile"],
    )
}

fn answer() -> Value {
    json!({
        "five_hour": { "utilization": 40, "resets_at": "2026-11-20T15:00:00Z" },
        "seven_day": { "utilization": 20, "resets_at": "2026-11-24T12:00:00Z" },
        "seven_day_opus": { "utilization": 10, "resets_at": "2026-11-24T12:00:00Z" },
    })
}

fn answers(endpoint: UsageEndpoint, _: &str) -> Result<Value, UsageError> {
    Ok(match endpoint {
        UsageEndpoint::Profile => json!({
            "account": { "email_address": "a@example.com", "uuid": "account-a" },
            "organization": { "uuid": "org-a" },
        }),
        UsageEndpoint::Usage => answer(),
    })
}

fn signed_in(t: &Temp) -> String {
    let a = create(&t.store, "Vertex", AccountKind::Personal, None);
    t.store
        .update(|s| s.accounts[0].auth = Some(auth(Some("a@example.com"), &at())))
        .unwrap();
    a.id
}

/// A credential read that must not happen: counted, and refused.
fn no_credential(
    reads: &Count,
) -> impl Fn(
    &std::path::Path,
    bool,
) -> Result<relay_core::usage_credentials::UsageCredential, UsageError>
+ use<> {
    let reads = reads.clone();
    move |_, _| {
        reads.bump();
        Err(UsageError::new(UsageIssue::CredentialsMissing))
    }
}

#[test]
fn a_read_through_the_claude_code_sign_in_marks_every_window_official_with_its_read_time() {
    let t = temp_store("relay-limit-origin-");
    let id = signed_in(&t);
    let manager = UsageManager::new(
        t.store.clone(),
        deps(|_, _| Ok(cred()), answers, Arc::new(now_at)),
    );
    let usage = manager.refresh(&id, false).unwrap();
    let windows = [
        (
            usage.five_hour.as_ref().unwrap().source,
            usage.five_hour.as_ref().unwrap().read_at.clone(),
        ),
        (
            usage.seven_day.as_ref().unwrap().source,
            usage.seven_day.as_ref().unwrap().read_at.clone(),
        ),
        (
            usage.model_windows.as_ref().unwrap()[0].source,
            usage.model_windows.as_ref().unwrap()[0].read_at.clone(),
        ),
    ];
    for (source, read_at) in windows {
        assert_eq!(source, Some(LimitSource::Official));
        assert_eq!(read_at, Some(at()));
    }
}

#[test]
fn a_read_through_the_claude_apps_sign_in_marks_its_windows_as_the_app_session() {
    let t = temp_store("relay-limit-origin-");
    let a = create(&t.store, "Alto", AccountKind::Personal, None);
    t.store
        .update(|s| {
            s.accounts[0].desktop = Some(desktop(
                "00000000-0000-4000-8000-000000000001",
                "00000000-0000-4000-8000-000000000002",
                &at(),
            ));
        })
        .unwrap();
    let reads = Count::default();
    let mut d = deps(no_credential(&reads), answers, Arc::new(now_at));
    d.desktop_usage = Some(DesktopUsageSource {
        usable: Arc::new(|_| true),
        read: Arc::new(|_, _| Ok(answer())),
    });
    let manager = UsageManager::new(t.store.clone(), d);
    let usage = manager.refresh(&a.id, false).unwrap();
    assert_eq!(reads.get(), 0, "no Claude Code credential");
    assert_eq!(
        usage.five_hour.unwrap().source,
        Some(LimitSource::AppSession)
    );
    assert_eq!(usage.seven_day.unwrap().read_at, Some(at()));
}

#[test]
fn a_codex_or_antigravity_read_through_its_providers_own_quota_api_is_official() {
    let t = temp_store("relay-limit-origin-");
    let a = create(
        &t.store,
        "Codex",
        AccountKind::Personal,
        Some(AccountProvider::Codex),
    );
    t.store
        .update(|s| s.accounts[0].auth = Some(auth(Some("dev@example.com"), &at())))
        .unwrap();
    let reads = Count::default();
    let requests = Count::default();
    let mut d = {
        let requests = requests.clone();
        deps(
            no_credential(&reads),
            move |_, _| {
                requests.bump();
                Err(UsageError::new(UsageIssue::Unavailable))
            },
            Arc::new(now_at),
        )
    };
    d.provider_usage = Some(Arc::new(|_| {
        Ok(ProviderUsageResult {
            limits: UsageLimits {
                five_hour: Some(UsageWindow::new(10.0, None)),
                model_windows: Some(vec![ModelWindow {
                    key: "antigravity_gemini_5h".into(),
                    label: "Gemini".into(),
                    used_percent: 30.0,
                    period: Some(ModelWindowPeriod::FiveHour),
                    ..ModelWindow::default()
                }]),
                ..UsageLimits::default()
            },
            plan: None,
        })
    }));
    let manager = UsageManager::new(t.store.clone(), d);
    let usage = manager.refresh(&a.id, false).unwrap();
    assert_eq!(
        (reads.get(), requests.get()),
        (0, 0),
        "no Claude credential or request"
    );
    assert_eq!(
        usage.five_hour,
        Some(UsageWindow {
            used_percent: 10.0,
            resets_at: None,
            source: Some(LimitSource::Official),
            read_at: Some(at()),
        })
    );
    assert_eq!(
        usage.model_windows.unwrap()[0].source,
        Some(LimitSource::Official)
    );
}

#[test]
fn windows_a_gateway_answer_reported_say_so_what_only_the_read_knows_keeps_the_reads_source() {
    let t = temp_store("relay-limit-origin-");
    let id = signed_in(&t);
    let clock = Clock::new(now_at());
    let manager = UsageManager::new(
        t.store.clone(),
        deps(|_, _| Ok(cred()), answers, clock.now_fn()),
    );
    manager.refresh(&id, false).unwrap();
    clock.add(120_000);
    manager.observe(
        &id,
        &LiveLimits {
            five_hour: Some(UsageWindow::new(55.0, Some("2026-11-20T15:00:00Z"))),
            ..LiveLimits::default()
        },
    );
    let usage = snap(&manager, &id);
    assert_eq!(
        usage.five_hour,
        Some(UsageWindow {
            used_percent: 55.0,
            resets_at: Some("2026-11-20T15:00:00Z".into()),
            source: Some(LimitSource::Gateway),
            read_at: Some(iso_at(clock.get())),
        })
    );
    let seven_day = usage.seven_day.unwrap();
    assert_eq!(seven_day.source, Some(LimitSource::Official));
    assert_eq!(seven_day.read_at, Some(at()));
    // A model the answer named is the gateway's too.
    manager.observe(
        &id,
        &LiveLimits {
            models: Some(vec![LiveModel {
                model: "opus".into(),
                weekly: true,
                used_percent: 12.0,
                resets_at: None,
            }]),
            ..LiveLimits::default()
        },
    );
    let windows = snap(&manager, &id).model_windows.unwrap();
    let opus = windows.iter().find(|w| w.key == "seven_day_opus").unwrap();
    assert_eq!(opus.source, Some(LimitSource::Gateway));
}
