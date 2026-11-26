//! Port of `tests/account-removal.test.ts`. Skipped: "the app's removal refuses a running
//! terminal…" (electron Service and its runner), "the usage cache forgets a removed account…"
//! (UsageManager, the usage port) and "the app removes an account through one IPC handler…"
//! (main-process source text).

use std::cell::RefCell;
use std::fs;
use std::path::{Path, PathBuf};

use relay_core::account_removal::{
    AccountRemoval, AccountRemovalError, AccountRemovalRefused, DesktopFacts, RemovalBlock,
    removal_block, remove_account,
};
use relay_core::profile_lock::{ProfileLockError, ProfileLockKind, acquire_profile_lock};
use relay_core::shared::error_text::localize_error;
use relay_core::shared::types::{
    AccountAuth, AccountDesktop, AccountKind, AccountRemoved, CreateAccount, Locale,
    PlanningAccount,
};
use relay_core::store::{Store, StoreOptions};
use serde_json::{Value, json};

fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn now() -> String {
    relay_core::fs_util::iso_timestamp(relay_core::clock::now_ms())
}

struct Made {
    id: String,
    profile: PathBuf,
    files: Vec<PathBuf>,
}

struct Fixture {
    _dir: tempfile::TempDir,
    root: PathBuf,
    store: Store,
    vault: PathBuf,
    locks: PathBuf,
    a: Made,
    b: Made,
    state: RefCell<DesktopFacts>,
    signed_out: RefCell<Vec<PathBuf>>,
}

/// A registry with two accounts, each with its profile, sealed sign-ins and the lists naming it.
fn fixture() -> Fixture {
    let dir = tempfile::Builder::new()
        .prefix("relay-remove-")
        .tempdir()
        .unwrap();
    let root = fs::canonicalize(dir.path()).unwrap();
    let store = Store::open(&root, StoreOptions::default()).unwrap();
    let vault = root.join("desktop-vault");
    let locks = root.join("profiles").join(".locks");
    let make = |name: &str| {
        let created = store
            .create(&CreateAccount {
                name: name.into(),
                kind: AccountKind::Personal,
                group: None,
                provider: None,
            })
            .unwrap();
        let desktop = uuid();
        let auth = uuid();
        store
            .update(|s| {
                let a = s.accounts.iter_mut().find(|x| x.id == created.id).unwrap();
                a.desktop = Some(AccountDesktop {
                    account_uuid: desktop.clone(),
                    org_id: uuid(),
                    saved_at: now(),
                    ..Default::default()
                });
                a.auth = Some(AccountAuth {
                    logged_in: true,
                    account_uuid: Some(auth.clone()),
                    checked_at: now(),
                    ..Default::default()
                });
            })
            .unwrap();
        let profile = store.profile(&created.id).unwrap();
        fs::write(profile.join(".credentials.json"), "{}").unwrap();
        // The sealed Claude app sign-in, and the extension's and the browser's under either uuid.
        let files: Vec<PathBuf> = [
            format!("accounts/{desktop}.bin"),
            format!("extension/{desktop}.bin"),
            format!("extension/{auth}.bin"),
            format!("extension-cookies/{desktop}.bin"),
            // The plain terminal's saved sign-ins: one file per organization.
            format!("terminal/{auth}.{}.bin", uuid()),
            format!("terminal/{desktop}.{}.bin", uuid()),
        ]
        .iter()
        .map(|relative| vault.join(relative))
        .collect();
        for file in &files {
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(file, "sealed").unwrap();
        }
        Made {
            id: created.id,
            profile,
            files,
        }
    };
    let a = make("A");
    let b = make("B");
    store
        .update(|s| {
            s.settings.desktop_history_accounts = vec![a.id.clone(), b.id.clone()];
            s.settings.auto_switch_accounts = vec![a.id.clone(), b.id.clone()];
            s.settings.planning.accounts = vec![
                PlanningAccount {
                    id: a.id.clone(),
                    first_start: None,
                },
                PlanningAccount {
                    id: b.id.clone(),
                    first_start: None,
                },
            ];
        })
        .unwrap();
    let state = RefCell::new(DesktopFacts {
        active_profile_id: Some(a.id.clone()),
        pending_profile_id: None,
    });
    Fixture {
        _dir: dir,
        root,
        store,
        vault,
        locks,
        a,
        b,
        state,
        signed_out: RefCell::new(Vec::new()),
    }
}

type SignOut<'a> = Option<&'a dyn Fn(&Path) -> Result<bool, String>>;

fn remove(
    f: &Fixture,
    id: &str,
    sign_out: SignOut<'_>,
) -> Result<AccountRemoved, AccountRemovalError> {
    let desktop = || Ok(f.state.borrow().clone());
    remove_account(
        id,
        &AccountRemoval {
            store: &f.store,
            vault: &f.vault,
            locks: &f.locks,
            desktop: &desktop,
            sign_out,
        },
    )
}

fn recording(f: &Fixture) -> impl Fn(&Path) -> Result<bool, String> + '_ {
    |profile: &Path| {
        f.signed_out.borrow_mut().push(profile.to_path_buf());
        Ok(true)
    }
}

fn signed_out(value: Option<bool>) -> AccountRemoved {
    AccountRemoved { signed_out: value }
}

#[test]
fn removing_an_account_deletes_its_profile_and_its_sealed_sign_ins_and_drops_it_from_every_list() {
    let f = fixture();
    let sign_out = recording(&f);
    let result = remove(&f, &f.b.id, Some(&sign_out)).unwrap();
    assert_eq!(result, signed_out(Some(true)));
    // Its usage sign-in was signed out in its own profile, before the profile went.
    assert_eq!(*f.signed_out.borrow(), std::slice::from_ref(&f.b.profile));
    assert!(!f.b.profile.exists());
    for file in &f.b.files {
        assert!(!file.exists(), "{file:?}");
    }
    // The other account keeps everything.
    assert!(f.a.profile.exists());
    for file in &f.a.files {
        assert!(file.exists(), "{file:?}");
    }
    let s = Store::open(&f.root, StoreOptions::default())
        .unwrap()
        .state();
    assert_eq!(
        s.accounts
            .iter()
            .map(|a| a.name.as_str())
            .collect::<Vec<_>>(),
        ["A"]
    );
    assert_eq!(
        s.settings.desktop_history_accounts,
        std::slice::from_ref(&f.a.id)
    );
    assert_eq!(
        s.settings.auto_switch_accounts,
        std::slice::from_ref(&f.a.id)
    );
    assert_eq!(
        s.settings.planning.accounts,
        [PlanningAccount {
            id: f.a.id.clone(),
            first_start: None
        }]
    );
    // Its lock folder goes too.
    assert!(!f.locks.join(&f.b.id).exists());
}

#[test]
fn a_removed_account_leaves_the_gateways_pool_order_and_left_out_list_the_client_bindings_stay() {
    let f = fixture();
    let pool = f.root.join("proxy-pool.json");
    let bindings = json!({ "claude-code": { "ANTHROPIC_BASE_URL": null } });
    fs::write(
        &pool,
        json!({ "accountOrder": [f.b.id, f.a.id], "excludedAccountIds": [f.b.id], "clientBindings": bindings })
            .to_string(),
    )
    .unwrap();
    let sign_out = recording(&f);
    remove(&f, &f.b.id, Some(&sign_out)).unwrap();
    let written: Value = serde_json::from_str(&fs::read_to_string(&pool).unwrap()).unwrap();
    assert_eq!(
        written,
        json!({ "accountOrder": [f.a.id], "excludedAccountIds": [], "clientBindings": bindings })
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&pool).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    // Without the file there is nothing to change, and none is made.
    let g = fixture();
    let sign_out = recording(&g);
    remove(&g, &g.b.id, Some(&sign_out)).unwrap();
    assert!(!g.root.join("proxy-pool.json").exists());
}

#[test]
fn the_account_open_in_the_claude_app_and_one_whose_sign_in_is_pending_are_refused_and_kept() {
    let f = fixture();
    let state = f.state.borrow().clone();
    assert_eq!(removal_block(&f.a.id, &state), Some(RemovalBlock::Active));
    assert_eq!(removal_block(&f.b.id, &state), None);
    let pending = DesktopFacts {
        active_profile_id: None,
        pending_profile_id: Some(f.b.id.clone()),
    };
    assert_eq!(
        removal_block(&f.b.id, &pending),
        Some(RemovalBlock::Pending)
    );
    let sign_out = recording(&f);
    match remove(&f, &f.a.id, Some(&sign_out)) {
        Err(AccountRemovalError::Refused(e)) => assert_eq!(e.reason, RemovalBlock::Active),
        other => panic!("{other:?}"),
    }
    // Desktop is read again at removal: a sign-in begun since the question was asked counts.
    f.state.borrow_mut().pending_profile_id = Some(f.b.id.clone());
    match remove(&f, &f.b.id, Some(&sign_out)) {
        Err(AccountRemovalError::Refused(e)) => assert_eq!(e.reason, RemovalBlock::Pending),
        other => panic!("{other:?}"),
    }
    assert!(f.signed_out.borrow().is_empty());
    assert_eq!(
        Store::open(&f.root, StoreOptions::default())
            .unwrap()
            .state()
            .accounts
            .len(),
        2
    );
    for file in f.a.files.iter().chain(&f.b.files) {
        assert!(file.exists(), "{file:?}");
    }
    // Both refusals read in both languages.
    for reason in [RemovalBlock::Active, RemovalBlock::Pending] {
        let message = AccountRemovalRefused { reason }.to_string();
        let tr = localize_error(&message, Locale::Tr);
        assert_ne!(tr, message, "{reason:?}");
        assert!(!tr.contains("Desktop"));
    }
}

#[test]
fn a_held_profile_lock_refuses_the_removal_before_anything_is_deleted() {
    let f = fixture();
    let _held = acquire_profile_lock(&f.locks, &f.b.id, ProfileLockKind::Shared).unwrap();
    let sign_out = recording(&f);
    match remove(&f, &f.b.id, Some(&sign_out)) {
        Err(AccountRemovalError::ProfileLock(ProfileLockError::Busy(_))) => {}
        other => panic!("{other:?}"),
    }
    assert!(f.signed_out.borrow().is_empty());
    assert!(f.b.profile.exists());
    assert_eq!(
        Store::open(&f.root, StoreOptions::default())
            .unwrap()
            .state()
            .accounts
            .len(),
        2
    );
    let text = "Claude Code is running with this account.";
    assert_ne!(localize_error(text, Locale::Tr), text);
}

#[test]
fn a_usage_sign_in_that_cannot_be_signed_out_is_said_and_the_account_still_goes() {
    let f = fixture();
    let failing = |_: &Path| -> Result<bool, String> { Err("no network".into()) };
    assert_eq!(
        remove(&f, &f.b.id, Some(&failing)).unwrap(),
        signed_out(Some(false))
    );
    assert!(!f.b.profile.exists());
    // Without a CLI it is not signed out either; without a usage sign-in there is nothing to say.
    let g = fixture();
    assert_eq!(remove(&g, &g.b.id, None).unwrap(), signed_out(Some(false)));
    let a_id = g.a.id.clone();
    g.store
        .update(|s| s.accounts.iter_mut().find(|a| a.id == a_id).unwrap().auth = None)
        .unwrap();
    g.state.borrow_mut().active_profile_id = None;
    let sign_out = recording(&g);
    assert_eq!(
        remove(&g, &g.a.id, Some(&sign_out)).unwrap(),
        signed_out(None)
    );
    assert!(g.signed_out.borrow().is_empty());
}

#[test]
fn a_stale_not_logged_in_check_still_signs_the_profile_out_and_other_accounts_terminal_copies_stay()
{
    let f = fixture();
    let b_id = f.b.id.clone();
    f.store
        .update(|s| {
            s.accounts
                .iter_mut()
                .find(|a| a.id == b_id)
                .unwrap()
                .auth
                .as_mut()
                .unwrap()
                .logged_in = false
        })
        .unwrap();
    let keep = f
        .vault
        .join("terminal")
        .join(format!("{}.{}.bin", uuid(), uuid()));
    fs::write(&keep, "sealed").unwrap();
    let sign_out = recording(&f);
    assert_eq!(
        remove(&f, &f.b.id, Some(&sign_out)).unwrap(),
        signed_out(Some(true))
    );
    assert_eq!(*f.signed_out.borrow(), std::slice::from_ref(&f.b.profile));
    for file in &f.b.files {
        assert!(!file.exists(), "{file:?}");
    }
    assert!(keep.exists());
    for file in &f.a.files {
        assert!(file.exists(), "{file:?}");
    }
}
