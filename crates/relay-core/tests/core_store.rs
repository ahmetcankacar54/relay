//! The Store cases of `tests/core.test.ts`. The transcript, environment and Desktop-version cases
//! belong to the sessions and environment ports; the fixture's session file is not needed here.

use std::fs;

use relay_core::shared::types::{AccountKind, CreateAccount};
use relay_core::store::{Store, StoreOptions};

fn create(name: &str, kind: AccountKind, group: Option<&str>) -> CreateAccount {
    CreateAccount {
        name: name.into(),
        kind,
        group: group.map(str::to_string),
        provider: None,
    }
}

fn fixture() -> (tempfile::TempDir, Store) {
    let root = tempfile::Builder::new()
        .prefix("relay-test-")
        .tempdir()
        .unwrap();
    let store = Store::open(root.path(), StoreOptions::default()).unwrap();
    (root, store)
}

#[test]
fn accounts_persist_separate_profiles_and_selected_company_sharing_groups() {
    let (root, store) = fixture();
    let a = store
        .create(&create("Personal A", AccountKind::Personal, None))
        .unwrap();
    let b = store
        .create(&create("Personal B", AccountKind::Personal, None))
        .unwrap();
    let company_a = store
        .create(&create("Company A", AccountKind::Work, None))
        .unwrap();
    let company_b = store
        .create(&create("Company B", AccountKind::Work, None))
        .unwrap();
    assert_ne!(company_a.group, company_b.group);
    let shared_a = store
        .create(&create("Shared A", AccountKind::Work, Some("client")))
        .unwrap();
    let shared_b = store
        .create(&create("Shared B", AccountKind::Work, Some("client")))
        .unwrap();
    assert_eq!(shared_a.group, shared_b.group);
    assert_eq!(a.group, b.group);
    assert_ne!(store.profile(&a.id).unwrap(), store.profile(&b.id).unwrap());
    let reopened = Store::open(root.path(), StoreOptions::default()).unwrap();
    assert_eq!(reopened.state().accounts.len(), 6);
    assert_eq!(reopened.account(&a.id).unwrap().name, "Personal A");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&store.file).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    assert!(
        store
            .create(&create("", AccountKind::Personal, None))
            .is_err()
    );
    assert!(store.profile("../../elsewhere").is_err());
}

#[test]
fn corrupt_state_fails_closed_instead_of_erasing_profiles() {
    let (root, store) = fixture();
    store
        .create(&create("Personal A", AccountKind::Personal, None))
        .unwrap();
    fs::write(&store.file, "{broken").unwrap();
    assert!(Store::open(root.path(), StoreOptions::default()).is_err());
    assert_eq!(fs::read_to_string(&store.file).unwrap(), "{broken");
}
