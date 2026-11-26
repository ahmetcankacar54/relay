//! Port of the `UsageManager` case of `tests/gateway-phase2.test.ts` ("an answer's windows make
//! the account fresh…"). The other cases test the gateway (`electron/core/proxy`, relay-gateway)
//! and the UI. `parseLiveLimits(ALLOWED)` is the gateway's; its result is written out here.

#[path = "common/usage_manager.rs"]
mod helpers;

use std::sync::Arc;

use helpers::*;
use relay_core::shared::types::{
    AccountKind, AccountProvider, AccountUsage, UsageStatus, UsageWindow,
};
use relay_core::usage::{LiveLimits, UsageEndpoint, UsageManager};
use serde_json::json;

/// `parseLiveLimits(ALLOWED)`: the rate-limit headers of a real answer (2026-11-13).
fn allowed() -> LiveLimits {
    LiveLimits {
        five_hour: Some(UsageWindow::new(0.0, Some(&iso_at(1_794_582_600_000)))),
        seven_day: Some(UsageWindow::new(28.0, Some(&iso_at(1_795_060_800_000)))),
        models: None,
    }
}

fn five_hour(used_percent: f64) -> LiveLimits {
    LiveLimits {
        five_hour: Some(UsageWindow::new(used_percent, None)),
        ..LiveLimits::default()
    }
}

#[test]
fn an_answers_windows_make_the_account_fresh_for_everything_that_reads_limits_while_reads_keep_their_own_pace()
 {
    let t = temp_store("relay-live-usage-");
    let claude = create(&t.store, "Claude", AccountKind::Personal, None);
    let clock = Clock::new(ms("2026-11-13T12:00:00Z"));
    let account_uuid = "11111111-2222-4333-8444-555555555555";
    let org_id = "66666666-7777-4888-8999-aaaaaaaaaaaa";
    t.store
        .update(|s| {
            let mut a = auth(Some("dev@example.com"), &iso_at(clock.get()));
            a.account_uuid = Some(account_uuid.into());
            a.org_id = Some(org_id.into());
            s.accounts[0].auth = Some(a);
            s.accounts[0].desktop = Some(desktop(account_uuid, org_id, &iso_at(clock.get())));
            s.settings.usage_refresh_minutes = 5;
        })
        .unwrap();
    let profile = json!({
        "account": { "uuid": account_uuid, "email_address": "dev@example.com" },
        "organization": { "uuid": org_id },
    });
    let reads = Count::default();
    let samples = Log::<AccountUsage>::new();
    let manager = {
        let (reads, expiry) = (reads.clone(), clock.get() as f64 + 86_400_000.0);
        let mut d = deps(
            move |_, _| {
                Ok(credential(
                    "fixture-token",
                    Some(expiry),
                    &["user:profile", "user:inference"],
                ))
            },
            move |endpoint, _| {
                if endpoint == UsageEndpoint::Profile {
                    return Ok(profile.clone());
                }
                reads.bump();
                Ok(json!({
                    "five_hour": { "utilization": 10, "resets_at": "2026-11-13T15:00:00Z" },
                    "seven_day": { "utilization": 20, "resets_at": "2026-11-18T08:00:00Z" },
                    "seven_day_opus": { "utilization": 5, "resets_at": "2026-11-18T08:00:00Z" },
                }))
            },
            clock.now_fn(),
        );
        let samples = samples.clone();
        d.on_sample = Arc::new(move |_, usage| samples.push(usage.clone()));
        Arc::new(UsageManager::new(t.store.clone(), d))
    };
    manager.refresh(&claude.id, false).unwrap();
    assert_eq!(reads.get(), 1);
    let read = snap(&manager, &claude.id);
    assert_eq!(read.five_hour.as_ref().unwrap().used_percent, 10.0);

    clock.add(4 * 60_000);
    manager.observe(&claude.id, &allowed());
    let live = snap(&manager, &claude.id);
    assert_eq!(live.status, UsageStatus::Ready);
    assert!(!live.stale);
    assert_eq!(live.five_hour.as_ref().unwrap().used_percent, 0.0);
    assert_eq!(live.seven_day.as_ref().unwrap().used_percent, 28.0);
    assert_eq!(live.live_at, Some(iso_at(clock.get())));
    assert_eq!(live.checked_at, live.live_at);
    assert_eq!(
        live.model_windows, read.model_windows,
        "what only a read knows stays"
    );
    assert_eq!(samples.len(), 2, "the read, then the first live reading");

    // The same percents a minute later add no sample; a moved percent does, once a minute.
    clock.add(61_000);
    manager.observe(&claude.id, &allowed());
    assert_eq!(samples.len(), 2);
    manager.observe(&claude.id, &five_hour(3.0));
    assert_eq!(samples.len(), 3);
    manager.observe(&claude.id, &five_hour(4.0));
    assert_eq!(samples.len(), 3, "not twice within a minute");

    // The read's own schedule: five minutes after the last read, not after the last answer.
    manager.tick();
    until(|| reads.get() == 2);
    assert_eq!(
        reads.get(),
        2,
        "polled although the live reading is a second old"
    );

    // Codex and accounts without a sign-in are left alone.
    let codex = create(
        &t.store,
        "Codex",
        AccountKind::Personal,
        Some(AccountProvider::Codex),
    );
    manager.observe(&codex.id, &five_hour(50.0));
    assert_eq!(snap(&manager, &codex.id).five_hour, None);
}
