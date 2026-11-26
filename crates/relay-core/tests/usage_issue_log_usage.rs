//! Port of the `UsageManager` cases of `tests/usage-issue-log.test.ts`. The log file's own cases
//! (`appendUsageIssue`, `electron/core/usage-issue-log`) belong to another slice, and "main logs
//! usage issues to usage-issues.json…" reads main-process source text: skipped here.

#[path = "common/usage_manager.rs"]
mod helpers;

use std::sync::{Arc, Mutex};

use helpers::*;
use relay_core::shared::types::{Account, AccountKind, AccountUsage, UsageIssue, UsageStatus};
use relay_core::usage::{UsageEndpoint, UsageManager};
use relay_core::usage_credentials::UsageError;
use serde_json::json;

const MINUTE: i64 = 60_000;
const SECRET: &str = "fixture-usage-issue-secret";

fn start() -> i64 {
    ms("2026-10-17T09:00:00Z")
}

struct Polling {
    _t: Temp,
    id: String,
    manager: UsageManager,
    clock: Clock,
    failure: Arc<Mutex<Option<UsageIssue>>>,
}

impl Polling {
    /// Wait out the failure backoff, then poll once.
    fn poll(&self, next: Option<UsageIssue>) -> AccountUsage {
        self.clock.add(31 * MINUTE);
        *self.failure.lock().unwrap() = next;
        self.manager.refresh(&self.id, false).unwrap()
    }

    fn poll_within_backoff(&self) -> AccountUsage {
        self.clock.add(1_000);
        self.manager.refresh(&self.id, false).unwrap()
    }
}

fn polling_fixture(
    on_issue: impl Fn(&Account, UsageIssue, Option<&str>) + Send + Sync + 'static,
) -> Polling {
    let t = temp_store("relay-usage-issues-");
    let created = create(&t.store, "A", AccountKind::Personal, None);
    t.store
        .update(|s| s.accounts[0].auth = Some(auth(Some("a@example.test"), &iso_at(start()))))
        .unwrap();
    let clock = Clock::new(start());
    let failure = Arc::new(Mutex::new(None::<UsageIssue>));
    let mut d = {
        let failure = failure.clone();
        deps(
            move |_, _| match *failure.lock().unwrap() {
                Some(issue) => Err(UsageError::new(issue)),
                None => Ok(credential(SECRET, None, &["user:profile"])),
            },
            |endpoint, _| {
                Ok(match endpoint {
                    UsageEndpoint::Profile => json!({ "account": { "email": "a@example.test" } }),
                    UsageEndpoint::Usage => json!({ "five_hour": {
                        "utilization": 10,
                        "resets_at": iso_at(start() + 4 * 60 * MINUTE),
                    }}),
                })
            },
            clock.now_fn(),
        )
    };
    d.on_issue = Some(Arc::new(on_issue));
    let manager = UsageManager::new(t.store.clone(), d);
    Polling {
        _t: t,
        id: created.id,
        manager,
        clock,
        failure,
    }
}

#[test]
fn on_issue_fires_once_per_change_of_issue_not_on_every_failed_poll() {
    let seen = Log::<(String, UsageIssue)>::new();
    let f = {
        let seen = seen.clone();
        polling_fixture(move |account, issue, _| seen.push((account.id.clone(), issue)))
    };
    assert_eq!(
        f.poll(Some(UsageIssue::Expired)).issue,
        Some(UsageIssue::Expired)
    );
    assert_eq!(seen.all(), vec![(f.id.clone(), UsageIssue::Expired)]);
    // The same issue on later failed polls is not reported again.
    assert_eq!(
        f.poll(Some(UsageIssue::Expired)).issue,
        Some(UsageIssue::Expired)
    );
    assert_eq!(
        f.poll(Some(UsageIssue::Expired)).issue,
        Some(UsageIssue::Expired)
    );
    assert_eq!(seen.len(), 1);
    // A poll inside the backoff does not run, so it reports nothing either.
    f.poll_within_backoff();
    assert_eq!(seen.len(), 1);
    // A different issue is a change.
    assert_eq!(
        f.poll(Some(UsageIssue::Scope)).issue,
        Some(UsageIssue::Scope)
    );
    assert_eq!(
        seen.all().last().cloned(),
        Some((f.id.clone(), UsageIssue::Scope))
    );
    assert_eq!(seen.len(), 2);
    // A good poll reports nothing, and the same issue after it is a new change.
    assert_eq!(f.poll(None).status, UsageStatus::Ready);
    assert_eq!(seen.len(), 2);
    assert_eq!(
        f.poll(Some(UsageIssue::Scope)).issue,
        Some(UsageIssue::Scope)
    );
    assert_eq!(seen.len(), 3);
    assert_eq!(
        seen.all()
            .into_iter()
            .map(|(_, issue)| issue)
            .collect::<Vec<_>>(),
        vec![UsageIssue::Expired, UsageIssue::Scope, UsageIssue::Scope]
    );
}

#[test]
fn on_issue_sees_the_account_and_the_issue_never_a_credential_and_a_throwing_log_does_not_break_polling()
 {
    let received = Log::<(Account, UsageIssue, Option<String>)>::new();
    let f = {
        let received = received.clone();
        polling_fixture(move |account, issue, detail| {
            received.push((account.clone(), issue, detail.map(str::to_owned)));
            panic!("fixture disk failure");
        })
    };
    assert_eq!(
        f.poll(Some(UsageIssue::CredentialsMissing)).issue,
        Some(UsageIssue::CredentialsMissing)
    );
    assert_eq!(received.len(), 1);
    assert_no_secrets(&received.all(), &[SECRET]);
    // The manager still answers and keeps polling after the failed write.
    assert_eq!(f.poll(None).status, UsageStatus::Ready);
}
