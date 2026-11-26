//! Port of `tests/usage-refresh-manager.test.ts`: the manager with its credential renewal.
//! A TS callback throwing a plain `Error` returns `thrown()` here (what the manager makes of
//! one); the throwing pending probe, a `bool` in Rust, panics instead.

#[path = "common/usage_manager.rs"]
mod helpers;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use helpers::*;
use relay_core::relay_paths::Platform;
use relay_core::shared::types::{Account, AccountKind, AccountUsage, UsageIssue, UsageStatus};
use relay_core::store::Store;
use relay_core::usage::{UsageEndpoint, UsageManager, UsageManagerDeps, UsageRequest};
use relay_core::usage_credentials::{UsageCredential, UsageError};
use relay_core::usage_refresh::{UsageCredentialRefresher, UsageRefreshDeps};
use serde_json::{Value, json};

fn now_at() -> i64 {
    ms("2026-10-13T18:00:00Z")
}

fn old() -> UsageCredential {
    UsageCredential {
        access_token: "fixture-old-access-secret".into(),
        refresh_token: Some("fixture-old-refresh-secret".into()),
        expires_at: Some((now_at() + 300_000) as f64),
        scopes: vec!["user:profile".into(), "user:inference".into()],
        ..UsageCredential::default()
    }
}

fn replacement() -> UsageCredential {
    UsageCredential {
        access_token: "fixture-new-authoritative-secret".into(),
        refresh_token: Some("fixture-new-refresh-secret".into()),
        expires_at: Some((now_at() + 3_600_000) as f64),
        ..old()
    }
}

fn with_expiry(c: UsageCredential, at: i64) -> UsageCredential {
    UsageCredential {
        expires_at: Some(at as f64),
        ..c
    }
}

fn limits() -> Value {
    json!({
        "five_hour": { "utilization": 24, "resets_at": "2026-10-13T22:00:00Z" },
        "seven_day": { "utilization": 48, "resets_at": "2026-10-18T08:00:00Z" },
    })
}

const OLD_ACCESS: &str = "fixture-old-access-secret";
const NEW_ACCESS: &str = "fixture-new-authoritative-secret";

struct Fixture {
    _t: Temp,
    store: Arc<Store>,
    account: Account,
    profile: Value,
    directory: PathBuf,
}

fn fixture() -> Fixture {
    let t = temp_store("relay-refresh-manager-");
    let store = t.store.clone();
    let created = create(&store, "Enrolled", AccountKind::Personal, None);
    let account_uuid = uuid::Uuid::new_v4().to_string();
    let org_id = uuid::Uuid::new_v4().to_string();
    store
        .update(|s| {
            let mut a = auth(Some("enrolled@example.test"), &iso_at(now_at()));
            a.account_uuid = Some(account_uuid.clone());
            a.org_id = Some(org_id.clone());
            s.accounts[0].auth = Some(a);
            s.accounts[0].desktop = Some(desktop(&account_uuid, &org_id, &iso_at(now_at())));
        })
        .unwrap();
    let account = store.account(&created.id).unwrap();
    let profile = json!({
        "account": { "uuid": account_uuid, "email_address": "enrolled@example.test" },
        "organization": { "uuid": org_id },
    });
    let directory = store.profile(&account.id).unwrap();
    Fixture {
        _t: t,
        store,
        account,
        profile,
        directory,
    }
}

fn assert_no_secrets_here(value: &impl serde::Serialize) {
    assert_no_secrets(
        value,
        &[
            OLD_ACCESS,
            "fixture-old-refresh-secret",
            NEW_ACCESS,
            "fixture-new-refresh-secret",
            "provider-error-secret",
        ],
    );
}

type Requests = Log<(&'static str, String)>;

/// A request that logs what it was asked and answers the profile and the limits.
fn answering(
    profile: &Value,
    requests: &Requests,
) -> impl Fn(UsageEndpoint, &str) -> Result<Value, UsageError> + use<> {
    let (profile, requests) = (profile.clone(), requests.clone());
    move |endpoint, token| {
        requests.push((endpoint.as_str(), token.to_owned()));
        Ok(match endpoint {
            UsageEndpoint::Profile => profile.clone(),
            UsageEndpoint::Usage => limits(),
        })
    }
}

fn pairs(list: &[(&'static str, &str)]) -> Vec<(&'static str, String)> {
    list.iter().map(|(e, t)| (*e, (*t).to_owned())).collect()
}

fn base(
    store: &Arc<Store>,
    credentials: impl Fn(&Path, bool) -> Result<UsageCredential, UsageError> + Send + Sync + 'static,
    request: impl Fn(UsageEndpoint, &str) -> Result<Value, UsageError> + Send + Sync + 'static,
    edit: impl FnOnce(&mut UsageManagerDeps),
) -> Arc<UsageManager> {
    let mut d = deps(credentials, request, Arc::new(now_at));
    edit(&mut d);
    Arc::new(UsageManager::new(store.clone(), d))
}

fn counting_samples(d: &mut UsageManagerDeps, samples: &Count) {
    let samples = samples.clone();
    d.on_sample = Arc::new(move |_, _| {
        samples.bump();
    });
}

/// A Linux refresher reading `saved`, asking `request`, and running `run` as the exchange.
fn refresher(
    f: &Fixture,
    cli: &str,
    saved: &Arc<Mutex<UsageCredential>>,
    request: UsageRequest,
    run: impl Fn() -> Result<(), UsageError> + Send + Sync + 'static,
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
) -> Arc<UsageCredentialRefresher> {
    let executable = f.directory.join(cli).to_string_lossy().into_owned();
    let read_saved = saved.clone();
    let mut d = UsageRefreshDeps::new(
        Arc::new(move || Ok(executable.clone())),
        Arc::new(move |_, _| Ok(read_saved.lock().unwrap().clone())),
    );
    d.platform = Some(Platform::Linux);
    d.request = Some(request);
    d.run = Some(Arc::new(move |_| run()));
    d.now = Some(now);
    Arc::new(UsageCredentialRefresher::new(d))
}

/// The manager's renewal through `refresher` (the TS passes no interaction: false).
fn through(
    refresher: &Arc<UsageCredentialRefresher>,
    directory: &Path,
) -> relay_core::usage_refresh::RefreshUsageCredential {
    let (refresher, directory) = (refresher.clone(), directory.to_path_buf());
    Arc::new(move |account, credential, force, _| {
        refresher.refresh(account, &directory, credential, force, false)
    })
}

#[test]
fn usage_proactively_renews_at_the_five_minute_boundary_and_only_reads_quotas_with_the_authoritative_token()
 {
    let f = fixture();
    let requests = Requests::new();
    let samples = Log::<AccountUsage>::new();
    let asked = Log::<(PathBuf, bool)>::new();
    let renewals = Log::<(Account, UsageCredential, bool)>::new();
    let manager = {
        let (samples, asked, renewals) = (samples.clone(), asked.clone(), renewals.clone());
        let uuid = f.account.auth.as_ref().unwrap().account_uuid.clone();
        base(
            &f.store,
            move |directory, prompt| {
                asked.push((directory.to_path_buf(), prompt));
                Ok(old())
            },
            answering(&f.profile, &requests),
            move |d| {
                d.on_sample = Arc::new(move |account, usage| {
                    assert_eq!(account.auth.as_ref().unwrap().account_uuid, uuid);
                    samples.push(usage.clone());
                });
                d.refresh_credential = Some(Arc::new(move |account, supplied, force, _| {
                    renewals.push((account.clone(), supplied.clone(), force));
                    Ok(replacement())
                }));
            },
        )
    };
    let first = spawn_refresh(&manager, &f.account.id, false);
    let duplicate = spawn_refresh(&manager, &f.account.id, false);
    let result = first.join().unwrap();
    assert_eq!(duplicate.join().unwrap(), result);
    assert_eq!(renewals.all(), vec![(f.account.clone(), old(), false)]);
    assert_eq!(asked.all(), vec![(f.directory.clone(), false)]);
    assert_eq!(
        requests.all(),
        pairs(&[("profile", NEW_ACCESS), ("usage", NEW_ACCESS)])
    );
    assert_eq!(result.status, UsageStatus::Ready);
    assert_eq!(result.five_hour.as_ref().unwrap().used_percent, 24.0);
    assert_eq!(samples.all(), vec![result.clone()]);
    assert_no_secrets_here(&(result, manager.snapshot(), samples.all()));
}

#[test]
fn usage_does_not_proactively_rotate_a_credential_just_beyond_the_five_minute_boundary() {
    let f = fixture();
    let renewals = Count::default();
    let requests = Requests::new();
    let manager = {
        let renewals = renewals.clone();
        base(
            &f.store,
            |_, _| Ok(with_expiry(old(), now_at() + 300_001)),
            answering(&f.profile, &requests),
            move |d| {
                d.refresh_credential = Some(Arc::new(move |_, _, _, _| {
                    renewals.bump();
                    Ok(replacement())
                }));
            },
        )
    };
    assert_eq!(
        manager.refresh(&f.account.id, false).unwrap().status,
        UsageStatus::Ready
    );
    assert_eq!(renewals.get(), 0);
    assert!(requests.all().iter().all(|(_, token)| token == OLD_ACCESS));
}

#[test]
fn a_pending_credential_attempt_invokes_reconciliation_even_when_the_saved_access_token_is_fresh_beyond_five_minutes()
 {
    let f = fixture();
    let supplied = with_expiry(old(), now_at() + 3_600_000);
    let reconciliations = Log::<(Account, UsageCredential, bool)>::new();
    let probes = Log::<Account>::new();
    let requests = Requests::new();
    let manager = {
        let (reconciliations, probes, supplied) =
            (reconciliations.clone(), probes.clone(), supplied.clone());
        base(
            &f.store,
            move |_, _| Ok(supplied.clone()),
            answering(&f.profile, &requests),
            move |d| {
                d.refresh_credential = Some(Arc::new(move |account, credential, force, _| {
                    reconciliations.push((account.clone(), credential.clone(), force));
                    Ok(replacement())
                }));
                d.refresh_credential_pending = Some(Arc::new(move |account| {
                    probes.push(account.clone());
                    true
                }));
            },
        )
    };
    let result = manager.refresh(&f.account.id, false).unwrap();
    assert_eq!(result.status, UsageStatus::Ready);
    assert_eq!(
        reconciliations.all(),
        vec![(f.account.clone(), supplied, false)]
    );
    assert_eq!(probes.all(), vec![f.account.clone()]);
    assert_eq!(
        requests.all(),
        pairs(&[("profile", NEW_ACCESS), ("usage", NEW_ACCESS)])
    );
}

#[test]
fn a_genuine_pending_journal_blocks_fresh_quota_reads_until_a_confirmed_browser_replacement_is_reread_and_verified()
 {
    let f = fixture();
    let unverified = with_expiry(old(), now_at() + 3_600_000);
    let saved = Arc::new(Mutex::new(unverified.clone()));
    let exchanges = Count::default();
    let samples = Count::default();
    let requests = Requests::new();
    let request: UsageRequest = Arc::new(answering(&f.profile, &requests));
    let refresher = {
        let exchanges = exchanges.clone();
        refresher(
            &f,
            "fixture-cli",
            &saved,
            request.clone(),
            move || {
                exchanges.bump();
                Err(thrown())
            },
            Arc::new(now_at),
        )
    };
    assert_eq!(
        refresher
            .refresh(&f.account, &f.directory, &unverified, true, false)
            .unwrap_err()
            .issue,
        UsageIssue::Expired
    );
    assert!(refresher.has_pending(&f.directory));
    let reconciliations = Log::<bool>::new();
    let manager = {
        let (saved, reconciliations, samples) =
            (saved.clone(), reconciliations.clone(), samples.clone());
        let (renew, probe, directory) = (
            through(&refresher, &f.directory),
            refresher.clone(),
            f.directory.clone(),
        );
        base(
            &f.store,
            move |_, _| Ok(saved.lock().unwrap().clone()),
            move |endpoint, token| request(endpoint, token),
            move |d| {
                counting_samples(d, &samples);
                d.refresh_credential = Some(Arc::new(move |account, credential, force, prompt| {
                    reconciliations.push(force);
                    renew(account, credential, force, prompt)
                }));
                d.refresh_credential_pending =
                    Some(Arc::new(move |_| probe.has_pending(&directory)));
            },
        )
    };
    let blocked = manager.refresh(&f.account.id, false).unwrap();
    assert_eq!(blocked.issue, Some(UsageIssue::Expired));
    assert_eq!(samples.get(), 0);
    assert_eq!(requests.len(), 0);
    assert_eq!(reconciliations.all(), vec![false]);
    assert_eq!(exchanges.get(), 1);
    // Connected-login lifecycle: invalidate cached failure, then reread the new isolated
    // credential. Presence of a replacement alone does not clear intent.
    *saved.lock().unwrap() = replacement();
    manager.invalidate(&f.account.id);
    assert!(refresher.has_pending(&f.directory));
    let result = manager.refresh(&f.account.id, false).unwrap();
    assert_eq!(result.status, UsageStatus::Ready);
    assert_eq!(samples.get(), 1);
    assert_eq!(exchanges.get(), 1);
    assert_eq!(reconciliations.all(), vec![false, false]);
    assert_eq!(
        requests.all(),
        pairs(&[
            ("profile", NEW_ACCESS),
            ("profile", NEW_ACCESS),
            ("usage", NEW_ACCESS)
        ])
    );
    assert!(!refresher.has_pending(&f.directory));
    assert_no_secrets_here(&(blocked, result, manager.snapshot()));
}

#[test]
fn a_fresh_saved_replacement_without_a_refresh_token_reconciles_pending_intent_through_scope_and_server_identity_proof()
 {
    let f = fixture();
    let saved = Arc::new(Mutex::new(old()));
    let exchanges = Count::default();
    let samples = Count::default();
    let reconciliations = Count::default();
    let verify_started = Deferred::<()>::new();
    let verification = Deferred::<Value>::new();
    let requests = Requests::new();
    let request: UsageRequest = {
        let (requests, profile) = (requests.clone(), f.profile.clone());
        let (verify_started, verification) = (verify_started.clone(), verification.clone());
        Arc::new(move |endpoint, token| {
            requests.push((endpoint.as_str(), token.to_owned()));
            if requests.len() == 1 {
                assert_eq!(endpoint, UsageEndpoint::Profile);
                verify_started.resolve(());
                return Ok(verification.wait());
            }
            Ok(match endpoint {
                UsageEndpoint::Profile => profile.clone(),
                UsageEndpoint::Usage => limits(),
            })
        })
    };
    let refresher = {
        let exchanges = exchanges.clone();
        refresher(
            &f,
            "fixture-cli",
            &saved,
            request.clone(),
            move || {
                exchanges.bump();
                Err(thrown())
            },
            Arc::new(now_at),
        )
    };
    assert_eq!(
        refresher
            .refresh(&f.account, &f.directory, &old(), false, false)
            .unwrap_err()
            .issue,
        UsageIssue::Expired
    );
    *saved.lock().unwrap() = UsageCredential {
        refresh_token: None,
        ..replacement()
    };
    let checks = Log::<(bool, Option<String>, Vec<String>)>::new();
    let manager = {
        let (saved, samples, reconciliations, checks) = (
            saved.clone(),
            samples.clone(),
            reconciliations.clone(),
            checks.clone(),
        );
        let (renew, probe, directory) = (
            through(&refresher, &f.directory),
            refresher.clone(),
            f.directory.clone(),
        );
        base(
            &f.store,
            move |_, _| Ok(saved.lock().unwrap().clone()),
            move |endpoint, token| request(endpoint, token),
            move |d| {
                counting_samples(d, &samples);
                d.refresh_credential = Some(Arc::new(move |account, credential, force, prompt| {
                    reconciliations.bump();
                    checks.push((
                        force,
                        credential.refresh_token.clone(),
                        credential.scopes.clone(),
                    ));
                    renew(account, credential, force, prompt)
                }));
                d.refresh_credential_pending =
                    Some(Arc::new(move |_| probe.has_pending(&directory)));
            },
        )
    };
    let pending = spawn_refresh(&manager, &f.account.id, false);
    verify_started.wait();
    assert!(refresher.has_pending(&f.directory));
    assert_eq!(samples.get(), 0);
    assert_eq!(reconciliations.get(), 1);
    assert_eq!(exchanges.get(), 1);
    assert_eq!(checks.all(), vec![(false, None, old().scopes)]);
    verification.resolve(f.profile.clone());
    let result = pending.join().unwrap();
    assert_eq!(result.status, UsageStatus::Ready);
    assert_eq!(samples.get(), 1);
    assert_eq!(exchanges.get(), 1);
    assert!(!refresher.has_pending(&f.directory));
    assert_eq!(
        requests.all(),
        pairs(&[
            ("profile", NEW_ACCESS),
            ("profile", NEW_ACCESS),
            ("usage", NEW_ACCESS)
        ])
    );
    assert_no_secrets_here(&(result, manager.snapshot()));
}

#[test]
fn pending_reconciliation_and_pending_probe_failures_remain_safe_errors_without_quota_fallback() {
    for failure in ["probe", "reconciliation"] {
        let f = fixture();
        let requests = Count::default();
        let samples = Count::default();
        let reconciliations = Count::default();
        let manager = {
            let (requests, samples, reconciliations) =
                (requests.clone(), samples.clone(), reconciliations.clone());
            base(
                &f.store,
                |_, _| Ok(with_expiry(old(), now_at() + 3_600_000)),
                move |_, _| {
                    requests.bump();
                    Ok(limits())
                },
                move |d| {
                    counting_samples(d, &samples);
                    d.refresh_credential = Some(Arc::new(move |_, _, _, _| {
                        reconciliations.bump();
                        Err(thrown())
                    }));
                    d.refresh_credential_pending = Some(Arc::new(move |_| {
                        if failure == "probe" {
                            panic!("provider-error-secret {OLD_ACCESS} fixture-old-refresh-secret");
                        }
                        true
                    }));
                },
            )
        };
        let failed = manager.refresh(&f.account.id, false).unwrap();
        assert_eq!(failed.issue, Some(UsageIssue::Unavailable), "{failure}");
        assert_eq!(requests.get(), 0);
        assert_eq!(samples.get(), 0);
        let expected = if failure == "probe" { 0 } else { 1 };
        assert_eq!(reconciliations.get(), expected, "{failure}");
        manager.refresh(&f.account.id, false).unwrap();
        assert_eq!(reconciliations.get(), expected, "{failure}");
        assert_no_secrets_here(&(failed, manager.snapshot()));
    }
}

#[test]
fn a_profile_401_forces_one_renewal_before_expiry_and_retries_identity_and_quotas_with_the_new_token()
 {
    let f = fixture();
    let requests = Requests::new();
    let renewals = Log::<(String, bool, String)>::new();
    let samples = Count::default();
    let manager = {
        let (renewals, samples) = (renewals.clone(), samples.clone());
        let answer = answering(&f.profile, &requests);
        let log = requests.clone();
        base(
            &f.store,
            |_, _| Ok(with_expiry(old(), now_at() + 3_600_000)),
            move |endpoint, token| {
                if token == OLD_ACCESS {
                    log.push((endpoint.as_str(), token.to_owned()));
                    return Err(UsageError::new(UsageIssue::Expired));
                }
                answer(endpoint, token)
            },
            move |d| {
                counting_samples(d, &samples);
                d.refresh_credential = Some(Arc::new(move |account, supplied, force, _| {
                    renewals.push((account.id.clone(), force, supplied.access_token.clone()));
                    Ok(replacement())
                }));
            },
        )
    };
    assert_eq!(
        manager.refresh(&f.account.id, false).unwrap().status,
        UsageStatus::Ready
    );
    assert_eq!(
        renewals.all(),
        vec![(f.account.id.clone(), true, OLD_ACCESS.to_owned())]
    );
    assert_eq!(samples.get(), 1);
    assert_eq!(
        requests.all(),
        pairs(&[
            ("profile", OLD_ACCESS),
            ("profile", NEW_ACCESS),
            ("usage", NEW_ACCESS)
        ])
    );
}

#[test]
fn manager_and_refresher_verify_the_saved_replacement_before_reading_usage_with_that_same_token() {
    let f = fixture();
    let saved = Arc::new(Mutex::new(old()));
    let exchanges = Count::default();
    let samples = Count::default();
    let requests = Requests::new();
    let request: UsageRequest = Arc::new(answering(&f.profile, &requests));
    let refresher = {
        let (exchanges, saved) = (exchanges.clone(), saved.clone());
        refresher(
            &f,
            "fixture-cli",
            &saved.clone(),
            request.clone(),
            move || {
                exchanges.bump();
                *saved.lock().unwrap() = replacement();
                Ok(())
            },
            Arc::new(now_at),
        )
    };
    let manager = {
        let (saved, samples, renew) = (
            saved.clone(),
            samples.clone(),
            through(&refresher, &f.directory),
        );
        base(
            &f.store,
            move |_, _| Ok(saved.lock().unwrap().clone()),
            move |endpoint, token| request(endpoint, token),
            move |d| {
                counting_samples(d, &samples);
                d.refresh_credential = Some(renew);
            },
        )
    };
    let result = manager.refresh(&f.account.id, false).unwrap();
    assert_eq!(result.status, UsageStatus::Ready);
    assert_eq!(exchanges.get(), 1);
    assert_eq!(samples.get(), 1);
    assert_eq!(
        requests.all(),
        pairs(&[
            ("profile", NEW_ACCESS),
            ("profile", NEW_ACCESS),
            ("usage", NEW_ACCESS)
        ])
    );
    assert_no_secrets_here(&(result, manager.snapshot()));
}

#[test]
fn a_replacement_profile_401_never_triggers_a_second_rotation_after_either_proactive_or_forced_renewal()
 {
    for proactive in [true, false] {
        let f = fixture();
        let renewals = Log::<bool>::new();
        let requests = Log::<&'static str>::new();
        let samples = Count::default();
        let manager = {
            let (renewals, requests, samples) =
                (renewals.clone(), requests.clone(), samples.clone());
            base(
                &f.store,
                move |_, _| {
                    Ok(with_expiry(
                        old(),
                        now_at() + if proactive { 300_000 } else { 3_600_000 },
                    ))
                },
                move |endpoint, _| {
                    requests.push(endpoint.as_str());
                    Err(UsageError::new(UsageIssue::Expired))
                },
                move |d| {
                    counting_samples(d, &samples);
                    d.refresh_credential = Some(Arc::new(move |_, _, force, _| {
                        renewals.push(force);
                        Ok(replacement())
                    }));
                },
            )
        };
        let result = manager.refresh(&f.account.id, false).unwrap();
        assert_eq!(result.issue, Some(UsageIssue::Expired));
        assert_eq!(result.status, UsageStatus::Error);
        assert_eq!(renewals.all(), vec![!proactive], "proactive: {proactive}");
        assert_eq!(requests.len(), if proactive { 1 } else { 2 });
        assert!(requests.all().iter().all(|e| *e == "profile"));
        assert_eq!(samples.get(), 0);
        manager.refresh(&f.account.id, false).unwrap();
        assert_eq!(renewals.len(), 1);
        assert_no_secrets_here(&(result, manager.snapshot()));
    }
}

#[test]
fn invalidation_during_rotation_prevents_subsequent_requests_samples_and_old_completion_cache_writes()
 {
    for proactive in [true, false] {
        let f = fixture();
        let started = Deferred::<()>::new();
        let rotation = Deferred::<UsageCredential>::new();
        let requests = Count::default();
        let samples = Count::default();
        let renewals = Count::default();
        let manager = {
            let (requests, samples, renewals) =
                (requests.clone(), samples.clone(), renewals.clone());
            let (started, rotation) = (started.clone(), rotation.clone());
            base(
                &f.store,
                move |_, _| {
                    Ok(with_expiry(
                        old(),
                        now_at() + if proactive { 300_000 } else { 3_600_000 },
                    ))
                },
                move |_, _| {
                    requests.bump();
                    Err(UsageError::new(UsageIssue::Expired))
                },
                move |d| {
                    counting_samples(d, &samples);
                    d.refresh_credential = Some(Arc::new(move |_, _, _, _| {
                        renewals.bump();
                        started.resolve(());
                        Ok(rotation.wait())
                    }));
                },
            )
        };
        let pending = spawn_refresh(&manager, &f.account.id, false);
        started.wait();
        manager.invalidate(&f.account.id);
        rotation.resolve(replacement());
        let result = pending.join().unwrap();
        assert_eq!(renewals.get(), 1);
        assert_eq!(
            requests.get(),
            if proactive { 0 } else { 1 },
            "proactive: {proactive}"
        );
        assert_eq!(samples.get(), 0);
        assert_eq!(result.status, UsageStatus::Idle);
        assert_eq!(result.five_hour, None);
        assert_eq!(snap(&manager, &f.account.id), result);
    }
}

#[test]
fn rotation_callback_failures_hide_provider_details_and_tokens_without_fallback_requests_or_a_second_attempt()
 {
    let f = fixture();
    let renewals = Count::default();
    let requests = Count::default();
    let samples = Count::default();
    let manager = {
        let (renewals, requests, samples) = (renewals.clone(), requests.clone(), samples.clone());
        base(
            &f.store,
            |_, _| Ok(old()),
            move |_, _| {
                requests.bump();
                Ok(limits())
            },
            move |d| {
                counting_samples(d, &samples);
                d.refresh_credential = Some(Arc::new(move |_, _, _, _| {
                    renewals.bump();
                    Err(thrown())
                }));
            },
        )
    };
    let first = spawn_refresh(&manager, &f.account.id, false);
    let second = spawn_refresh(&manager, &f.account.id, false);
    let first = first.join().unwrap();
    assert_eq!(second.join().unwrap(), first);
    assert_eq!(first.issue, Some(UsageIssue::Unavailable));
    assert_eq!(renewals.get(), 1);
    assert_eq!(requests.get(), 0);
    assert_eq!(samples.get(), 0);
    manager.refresh(&f.account.id, false).unwrap();
    assert_eq!(renewals.get(), 1);
    assert_no_secrets_here(&(first, manager.snapshot()));
}

#[test]
fn an_uncertain_exchange_remains_blocked_after_the_managers_retry_delay_without_rotating_the_same_credential_again()
 {
    let f = fixture();
    let clock = Clock::new(now_at());
    let exchanges = Count::default();
    let requests = Count::default();
    let samples = Count::default();
    let saved = Arc::new(Mutex::new(old()));
    let refresher = {
        let (exchanges, requests, profile) =
            (exchanges.clone(), requests.clone(), f.profile.clone());
        refresher(
            &f,
            "fixture-cli",
            &saved,
            Arc::new(move |_, _| {
                requests.bump();
                Ok(profile.clone())
            }),
            move || {
                exchanges.bump();
                Err(thrown())
            },
            clock.now_fn(),
        )
    };
    let manager = {
        let (requests, samples) = (requests.clone(), samples.clone());
        let mut d = deps(
            |_, _| Ok(old()),
            move |_, _| {
                requests.bump();
                Ok(limits())
            },
            clock.now_fn(),
        );
        counting_samples(&mut d, &samples);
        d.refresh_credential = Some(through(&refresher, &f.directory));
        UsageManager::new(f.store.clone(), d)
    };
    let failed = manager.refresh(&f.account.id, false).unwrap();
    assert_eq!(failed.issue, Some(UsageIssue::Expired));
    assert_eq!(exchanges.get(), 1);
    clock.set(ms(failed.retry_at.as_deref().unwrap()) + 1);
    let retried = manager.refresh(&f.account.id, false).unwrap();
    assert_eq!(retried.issue, Some(UsageIssue::Expired));
    assert_eq!(exchanges.get(), 1);
    assert_eq!(requests.get(), 0);
    assert_eq!(samples.get(), 0);
    assert_no_secrets_here(&(failed, retried, manager.snapshot()));
}

#[test]
fn an_expired_or_profile_less_replacement_is_rejected_before_server_reads_and_history_samples() {
    let cases = [
        (
            "expired",
            with_expiry(replacement(), now_at()),
            UsageIssue::Expired,
        ),
        (
            "missing-profile-scope",
            UsageCredential {
                scopes: vec!["user:inference".into()],
                ..replacement()
            },
            UsageIssue::Scope,
        ),
    ];
    for (name, credential, issue) in cases {
        let f = fixture();
        let requests = Count::default();
        let samples = Count::default();
        let manager = {
            let (requests, samples) = (requests.clone(), samples.clone());
            base(
                &f.store,
                |_, _| Ok(old()),
                move |_, _| {
                    requests.bump();
                    Ok(limits())
                },
                move |d| {
                    counting_samples(d, &samples);
                    d.refresh_credential = Some(Arc::new(move |_, _, _, _| Ok(credential.clone())));
                },
            )
        };
        assert_eq!(
            manager.refresh(&f.account.id, false).unwrap().issue,
            Some(issue),
            "{name}"
        );
        assert_eq!(requests.get(), 0);
        assert_eq!(samples.get(), 0);
    }
}

#[test]
fn a_renewed_token_must_still_verify_the_enrolled_uuid_and_desktop_organization_before_quotas() {
    for field in ["account", "organization"] {
        let f = fixture();
        let requests = Requests::new();
        let samples = Count::default();
        let manager = {
            let (requests, samples, profile) =
                (requests.clone(), samples.clone(), f.profile.clone());
            base(
                &f.store,
                |_, _| Ok(old()),
                move |endpoint, token| {
                    requests.push((endpoint.as_str(), token.to_owned()));
                    let mut answer = profile.clone();
                    answer[field]["uuid"] = json!(uuid::Uuid::new_v4().to_string());
                    Ok(answer)
                },
                move |d| {
                    counting_samples(d, &samples);
                    d.refresh_credential = Some(Arc::new(|_, _, _, _| Ok(replacement())));
                },
            )
        };
        assert_eq!(
            manager.refresh(&f.account.id, false).unwrap().issue,
            Some(UsageIssue::IdentityMismatch),
            "{field}"
        );
        assert_eq!(requests.all(), pairs(&[("profile", NEW_ACCESS)]));
        assert_eq!(samples.get(), 0);
    }
}

#[test]
fn missing_refresh_tokens_or_required_scopes_cannot_start_a_credential_exchange_through_the_manager()
 {
    let cases = [
        (
            "missing-refresh-token",
            UsageCredential {
                refresh_token: None,
                ..with_expiry(old(), now_at() - 1)
            },
        ),
        (
            "missing-profile-scope",
            UsageCredential {
                scopes: vec!["user:inference".into()],
                ..old()
            },
        ),
        (
            "missing-inference-scope",
            UsageCredential {
                scopes: vec!["user:profile".into()],
                ..old()
            },
        ),
    ];
    for (name, credential) in cases {
        let f = fixture();
        let exchanges = Count::default();
        let requests = Count::default();
        let samples = Count::default();
        let saved = Arc::new(Mutex::new(credential.clone()));
        let refresher = {
            let (exchanges, requests, profile) =
                (exchanges.clone(), requests.clone(), f.profile.clone());
            refresher(
                &f,
                "never-executed-cli",
                &saved,
                Arc::new(move |_, _| {
                    requests.bump();
                    Ok(profile.clone())
                }),
                move || {
                    exchanges.bump();
                    Ok(())
                },
                Arc::new(now_at),
            )
        };
        let manager = {
            let (requests, samples, renew) = (
                requests.clone(),
                samples.clone(),
                through(&refresher, &f.directory),
            );
            base(
                &f.store,
                move |_, _| Ok(credential.clone()),
                move |_, _| {
                    requests.bump();
                    Ok(limits())
                },
                move |d| {
                    counting_samples(d, &samples);
                    d.refresh_credential = Some(renew);
                },
            )
        };
        let result = manager.refresh(&f.account.id, false).unwrap();
        assert_eq!(result.status, UsageStatus::Error, "{name}");
        assert_eq!(exchanges.get(), 0, "{name}");
        assert_eq!(requests.get(), 0, "{name}");
        assert_eq!(samples.get(), 0, "{name}");
        assert_no_secrets_here(&(result, manager.snapshot()));
    }
}

#[test]
fn usage_forwards_explicit_interaction_consent_to_both_proactive_and_forced_credential_renewal() {
    for allow_interaction in [false, true] {
        for force in [false, true] {
            let f = fixture();
            let supplied = with_expiry(old(), now_at() + if force { 3_600_000 } else { 300_000 });
            let prompts = Log::<bool>::new();
            let renewals = Log::<(bool, bool)>::new();
            let requests = Requests::new();
            let manager = {
                let (prompts, renewals) = (prompts.clone(), renewals.clone());
                let answer = answering(&f.profile, &requests);
                base(
                    &f.store,
                    move |_, allow_prompt| {
                        prompts.push(allow_prompt);
                        Ok(supplied.clone())
                    },
                    move |endpoint, token| {
                        if token == OLD_ACCESS {
                            return Err(UsageError::new(UsageIssue::Expired));
                        }
                        answer(endpoint, token)
                    },
                    move |d| {
                        d.refresh_credential = Some(Arc::new(move |_, _, forced, interaction| {
                            renewals.push((forced, interaction));
                            Ok(replacement())
                        }));
                    },
                )
            };
            let result = manager.refresh(&f.account.id, allow_interaction).unwrap();
            let name = format!("{allow_interaction}-{force}");
            assert_eq!(result.status, UsageStatus::Ready, "{name}");
            assert_eq!(prompts.all(), vec![allow_interaction], "{name}");
            assert_eq!(renewals.all(), vec![(force, allow_interaction)], "{name}");
            assert_no_secrets_here(&(result, manager.snapshot()));
        }
    }
}

#[test]
fn macos_background_polling_renews_a_near_expiry_connection_without_user_interaction() {
    let f = fixture();
    let saved = Arc::new(Mutex::new(old()));
    let executions = Count::default();
    let requests = Requests::new();
    let prompts = Log::<bool>::new();
    let refresher_prompts = Log::<bool>::new();
    let samples = Log::<AccountUsage>::new();
    let request: UsageRequest = Arc::new(answering(&f.profile, &requests));
    let refresher = {
        let executable = f.directory.join("mock-cli").to_string_lossy().into_owned();
        let (read_saved, run_saved, executions, refresher_prompts) = (
            saved.clone(),
            saved.clone(),
            executions.clone(),
            refresher_prompts.clone(),
        );
        let mut d = UsageRefreshDeps::new(
            Arc::new(move || Ok(executable.clone())),
            Arc::new(move |_, allow_prompt| {
                refresher_prompts.push(allow_prompt);
                Ok(read_saved.lock().unwrap().clone())
            }),
        );
        d.platform = Some(Platform::MacOs);
        d.request = Some(request.clone());
        d.run = Some(Arc::new(move |_| {
            executions.bump();
            *run_saved.lock().unwrap() = replacement();
            Ok(())
        }));
        d.now = Some(Arc::new(now_at));
        Arc::new(UsageCredentialRefresher::new(d))
    };
    let manager = {
        let (saved, prompts, samples) = (saved.clone(), prompts.clone(), samples.clone());
        let (renewer, probe, directory) =
            (refresher.clone(), refresher.clone(), f.directory.clone());
        let renew_directory = f.directory.clone();
        base(
            &f.store,
            move |_, allow_prompt| {
                prompts.push(allow_prompt);
                Ok(saved.lock().unwrap().clone())
            },
            move |endpoint, token| request(endpoint, token),
            move |d| {
                d.on_sample = Arc::new(move |_, usage| samples.push(usage.clone()));
                d.refresh_credential =
                    Some(Arc::new(move |account, credential, force, interaction| {
                        renewer.refresh(account, &renew_directory, credential, force, interaction)
                    }));
                d.refresh_credential_pending =
                    Some(Arc::new(move |_| probe.has_pending(&directory)));
            },
        )
    };
    let background = manager.refresh(&f.account.id, false).unwrap();
    assert_eq!(background.status, UsageStatus::Ready);
    assert!(!background.stale);
    assert_eq!(background.issue, None);
    assert_eq!(background.connection_renewal_required, None);
    assert_eq!(background.five_hour.as_ref().unwrap().used_percent, 24.0);
    assert_eq!(executions.get(), 1);
    assert!(!refresher.has_pending(&f.directory));
    assert_eq!(prompts.all(), vec![false]);
    assert!(refresher_prompts.all().iter().all(|p| !p));
    assert_eq!(
        requests.all().last().cloned(),
        Some(("usage", NEW_ACCESS.to_owned()))
    );
    assert_eq!(samples.len(), 1);
    assert_no_secrets_here(&(background, manager.snapshot(), samples.all()));
}

#[test]
fn renewal_refusal_falls_back_only_for_a_still_valid_token_with_no_pending_attempt_and_other_errors_never_read_quotas()
 {
    let cases = [
        (
            "expired-token",
            now_at(),
            false,
            UsageIssue::RenewalRequired,
        ),
        (
            "pending-intent",
            now_at() + 300_000,
            true,
            UsageIssue::RenewalRequired,
        ),
        (
            "uncertain-exchange",
            now_at() + 300_000,
            false,
            UsageIssue::Expired,
        ),
        (
            "read-denied",
            now_at() + 300_000,
            false,
            UsageIssue::KeychainLocked,
        ),
        (
            "profile-error",
            now_at() + 300_000,
            false,
            UsageIssue::IdentityMismatch,
        ),
    ];
    for (name, expires_at, pending, issue) in cases {
        let f = fixture();
        let requests = Count::default();
        let samples = Count::default();
        let renewals = Log::<(bool, bool)>::new();
        let manager = {
            let (requests, samples, renewals) =
                (requests.clone(), samples.clone(), renewals.clone());
            base(
                &f.store,
                move |_, _| Ok(with_expiry(old(), expires_at)),
                move |_, _| {
                    requests.bump();
                    Ok(limits())
                },
                move |d| {
                    counting_samples(d, &samples);
                    d.refresh_credential = Some(Arc::new(move |_, _, force, interaction| {
                        renewals.push((force, interaction));
                        Err(UsageError::new(issue))
                    }));
                    d.refresh_credential_pending = Some(Arc::new(move |_| pending));
                },
            )
        };
        let result = manager.refresh(&f.account.id, false).unwrap();
        assert_eq!(result.status, UsageStatus::Error, "{name}");
        assert_eq!(result.issue, Some(issue), "{name}");
        assert_eq!(result.connection_renewal_required, None, "{name}");
        assert_eq!(result.checked_at, None, "{name}");
        assert_eq!(result.five_hour, None, "{name}");
        assert_eq!(requests.get(), 0, "{name}");
        assert_eq!(samples.get(), 0, "{name}");
        assert_eq!(renewals.all(), vec![(false, false)], "{name}");
        assert_no_secrets_here(&(result, manager.snapshot()));
    }
}

#[test]
fn a_401_after_background_renewal_refusal_cannot_publish_fresh_quotas_or_launch_a_second_interactive_command()
 {
    let f = fixture();
    let renewals = Log::<(bool, bool)>::new();
    let requests = Requests::new();
    let samples = Count::default();
    let manager = {
        let (renewals, requests, samples) = (renewals.clone(), requests.clone(), samples.clone());
        base(
            &f.store,
            |_, _| Ok(old()),
            move |endpoint, token| {
                requests.push((endpoint.as_str(), token.to_owned()));
                Err(UsageError::new(UsageIssue::Expired))
            },
            move |d| {
                counting_samples(d, &samples);
                d.refresh_credential = Some(Arc::new(move |_, _, force, interaction| {
                    renewals.push((force, interaction));
                    Err(UsageError::new(UsageIssue::RenewalRequired))
                }));
            },
        )
    };
    let result = manager.refresh(&f.account.id, false).unwrap();
    assert_eq!(result.status, UsageStatus::Error);
    assert_eq!(result.issue, Some(UsageIssue::RenewalRequired));
    assert_eq!(result.connection_renewal_required, None);
    assert_eq!(result.checked_at, None);
    assert_eq!(result.five_hour, None);
    assert_eq!(samples.get(), 0);
    assert_eq!(requests.all(), pairs(&[("profile", OLD_ACCESS)]));
    assert_eq!(renewals.all(), vec![(false, false), (true, false)]);
    assert_no_secrets_here(&(result, manager.snapshot()));
}

#[test]
fn explicit_user_renewal_bypasses_a_local_renewal_required_backoff_while_background_retries_remain_blocked()
 {
    let f = fixture();
    let reads = Count::default();
    let interactions = Log::<bool>::new();
    let tokens = Log::<String>::new();
    let manager = {
        let (reads, interactions, tokens, profile) = (
            reads.clone(),
            interactions.clone(),
            tokens.clone(),
            f.profile.clone(),
        );
        base(
            &f.store,
            move |_, _| {
                reads.bump();
                Ok(with_expiry(old(), now_at()))
            },
            move |endpoint, token| {
                tokens.push(token.to_owned());
                Ok(match endpoint {
                    UsageEndpoint::Profile => profile.clone(),
                    UsageEndpoint::Usage => limits(),
                })
            },
            move |d| {
                d.refresh_credential = Some(Arc::new(move |_, _, _, interaction| {
                    interactions.push(interaction);
                    if !interaction {
                        return Err(UsageError::new(UsageIssue::RenewalRequired));
                    }
                    Ok(replacement())
                }));
            },
        )
    };
    let first = manager.refresh(&f.account.id, false).unwrap();
    assert_eq!(first.issue, Some(UsageIssue::RenewalRequired));
    assert_eq!(
        manager.refresh(&f.account.id, false).unwrap().issue,
        Some(UsageIssue::RenewalRequired)
    );
    assert_eq!(reads.get(), 1);
    let explicit = manager.refresh(&f.account.id, true).unwrap();
    assert_eq!(explicit.status, UsageStatus::Ready);
    assert_eq!(reads.get(), 2);
    assert_eq!(interactions.all(), vec![false, true]);
    assert!(tokens.all().iter().all(|t| t == NEW_ACCESS));
    assert_no_secrets_here(&(first, explicit, manager.snapshot()));
}

#[test]
fn an_explicit_renewal_cannot_bypass_server_retry_after_even_when_retained_quotas_have_a_connection_renewal_flag()
 {
    let f = fixture();
    let clock = Clock::new(now_at());
    let reads = Count::default();
    let renewals = Count::default();
    let requests = Count::default();
    let retry_at = now_at() + 600_000;
    let manager = {
        let (reads, renewals, requests, profile) = (
            reads.clone(),
            renewals.clone(),
            requests.clone(),
            f.profile.clone(),
        );
        let now = clock.clone();
        let mut d = deps(
            move |_, _| {
                reads.bump();
                Ok(old())
            },
            move |endpoint, _| {
                requests.bump();
                if now.get() > now_at() {
                    return Err(UsageError::with_retry(
                        UsageIssue::RateLimited,
                        Some(retry_at as f64),
                        None,
                    ));
                }
                Ok(match endpoint {
                    UsageEndpoint::Profile => profile.clone(),
                    UsageEndpoint::Usage => limits(),
                })
            },
            clock.now_fn(),
        );
        d.refresh_credential = Some(Arc::new(move |_, _, _, _| {
            renewals.bump();
            Err(UsageError::new(UsageIssue::RenewalRequired))
        }));
        UsageManager::new(f.store.clone(), d)
    };
    assert_eq!(
        manager
            .refresh(&f.account.id, false)
            .unwrap()
            .connection_renewal_required,
        Some(true)
    );
    clock.add(60_001);
    let limited = manager.refresh(&f.account.id, false).unwrap();
    assert_eq!(limited.issue, Some(UsageIssue::RateLimited));
    assert_eq!(limited.retry_at, Some(iso_at(retry_at)));
    assert_eq!(limited.connection_renewal_required, Some(true));
    let counts = (reads.get(), renewals.get(), requests.get());
    let explicit = manager.refresh(&f.account.id, true).unwrap();
    assert_eq!(explicit, limited);
    assert_eq!((reads.get(), renewals.get(), requests.get()), counts);
    assert_no_secrets_here(&(limited, explicit, manager.snapshot()));
}
