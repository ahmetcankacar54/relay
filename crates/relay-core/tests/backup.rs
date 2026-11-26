//! Port of `tests/backup.test.ts`.

use std::cell::RefCell;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use relay_core::backup::{
    BackupContext, BackupErrorReason, BackupHost, BackupPayload, BackupSource, ClaudeCodeSignIns,
    ScryptParams, collect_backup, import_backup, open_backup, read_backup_header, seal_backup,
    summarize_backup,
};
use relay_core::shared::backup::BackupImportMode;
use relay_core::shared::proxy_types::{ProxyConfig, default_proxy_config};
use relay_core::shared::types::{
    AccountAuth, AccountDesktop, AccountKind, AccountProvider, CreateAccount,
};
use relay_core::store::{Store, StoreOptions};
use relay_core::vault_crypto::Sealer;
use serde_json::{Value, json};

/// Fast parameters: the tests check the format, not scrypt's cost.
const FAST: ScryptParams = ScryptParams {
    log_n: 10,
    r: 8,
    p: 1,
};
const PASS: &str = "correct horse battery";
/// 2026-11-23T10:00:00Z.
const NOW: i64 = 1_795_428_000_000;
const DESKTOP_UUID: &str = "11111111-2222-4333-8444-555555555555";

fn gateway() -> ProxyConfig {
    ProxyConfig {
        port: 9411,
        api_key: Some("relay-test-key".into()),
        account_order: Some(Vec::new()),
        ..default_proxy_config()
    }
}

/// Claude Code's credentials kept in memory by profile path, as one computer's Keychain would.
#[derive(Default)]
struct FakeKeychain {
    items: RefCell<HashMap<PathBuf, String>>,
}

impl ClaudeCodeSignIns for FakeKeychain {
    fn read(&self, profile: &Path) -> Result<Option<String>, String> {
        Ok(self.items.borrow().get(profile).cloned())
    }
    fn write(&self, profile: &Path, text: &str) -> Result<(), String> {
        self.items
            .borrow_mut()
            .insert(profile.to_path_buf(), text.to_string());
        Ok(())
    }
}

/// One computer: its own data folder, vault key and Keychain.
struct Machine {
    dir: tempfile::TempDir,
    keychain: FakeKeychain,
    sealer: Sealer,
    store: Store,
}

fn machine(name: &str) -> Machine {
    let dir = tempfile::Builder::new()
        .prefix(&format!("relay-backup-{name}-"))
        .tempdir()
        .unwrap();
    let mut key = [0u8; 32];
    getrandom::fill(&mut key).unwrap();
    let store = Store::open(
        dir.path(),
        StoreOptions {
            backup_on_open: false,
            ..Default::default()
        },
    )
    .unwrap();
    Machine {
        dir,
        keychain: FakeKeychain::default(),
        sealer: Sealer::new(&key).unwrap(),
        store,
    }
}

const NOW_FN: &dyn Fn() -> i64 = &|| NOW;

impl Machine {
    fn data(&self) -> &Path {
        self.dir.path()
    }
    fn context(&self) -> BackupContext<'_> {
        BackupContext {
            host: BackupHost {
                data: self.dir.path(),
                sealer: &self.sealer,
                claude_code: &self.keychain,
            },
            relay_version: "0.29.0".into(),
            platform: "darwin".into(),
            now: NOW_FN,
        }
    }
    fn collect(&self, include: bool) -> BackupPayload {
        let state = self.store.state();
        let gateway = gateway();
        let source = BackupSource {
            settings: &state.settings,
            accounts: &state.accounts,
            gateway: &gateway,
        };
        collect_backup(&source, include, &self.context()).unwrap()
    }
    fn create(
        &self,
        name: &str,
        kind: AccountKind,
        group: Option<&str>,
        provider: Option<AccountProvider>,
    ) -> String {
        let input = CreateAccount {
            name: name.into(),
            kind,
            group: group.map(str::to_string),
            provider,
        };
        self.store.create(&input).unwrap().id
    }
}

struct Seeded {
    a: Machine,
    vertex: String,
    codex: String,
    login: String,
}

/// Machine A with a Claude account (Claude app and Claude Code sign-ins) and a Codex account.
fn seeded() -> Seeded {
    let a = machine("a");
    let vertex = a.create("Vertex", AccountKind::Work, Some("Alto"), None);
    let codex = a.create(
        "Alto Codex",
        AccountKind::Personal,
        None,
        Some(AccountProvider::Codex),
    );
    a.store
        .update(|state| {
            state.settings.usage_warning_percent = 95;
            state.settings.risk_acknowledged = [(
                relay_core::shared::feature_risk::FeatureRiskId::EarlyStart,
                1,
            )]
            .into_iter()
            .collect();
            state.settings.planning.auto_start = true;
            let account = state
                .accounts
                .iter_mut()
                .find(|item| item.id == vertex)
                .unwrap();
            account.desktop = Some(AccountDesktop {
                account_uuid: DESKTOP_UUID.into(),
                org_id: "22222222-3333-4444-8555-666666666666".into(),
                saved_at: "2026-11-20T10:00:00.000Z".into(),
                ..Default::default()
            });
            account.auth = Some(AccountAuth {
                logged_in: true,
                email: Some("vertex@example.com".into()),
                checked_at: "2026-11-20T10:00:00.000Z".into(),
                ..Default::default()
            });
        })
        .unwrap();
    let login = json!({
        "accountUuid": DESKTOP_UUID,
        "auth": { "oauthAccount": "vertex" },
        "cookies": { "Cookies": "c2VjcmV0" },
    })
    .to_string();
    let accounts = a.data().join("desktop-vault").join("accounts");
    fs::create_dir_all(&accounts).unwrap();
    fs::write(
        accounts.join(format!("{DESKTOP_UUID}.bin")),
        a.sealer.seal(&login),
    )
    .unwrap();
    let vertex_profile = a.data().join("profiles").join(&vertex);
    fs::write(
        vertex_profile.join(".claude.json"),
        json!({ "oauthAccount": { "emailAddress": "vertex@example.com" } }).to_string(),
    )
    .unwrap();
    a.keychain.items.borrow_mut().insert(
        vertex_profile,
        json!({ "claudeAiOauth": { "accessToken": "at-vertex", "refreshToken": "rt-vertex" } })
            .to_string(),
    );
    let codex_profile = a.data().join("profiles").join(&codex);
    fs::write(
        codex_profile.join("provider-credential.json"),
        json!({ "provider": "codex", "accessToken": "at-codex" }).to_string(),
    )
    .unwrap();
    Seeded {
        a,
        vertex,
        codex,
        login,
    }
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

fn reason(
    result: Result<impl std::fmt::Debug, relay_core::backup::BackupError>,
) -> BackupErrorReason {
    result.unwrap_err().reason
}

#[test]
fn a_backup_with_sign_ins_moves_accounts_settings_and_sign_ins_to_a_computer_with_another_vault_key()
 {
    let Seeded {
        a,
        vertex,
        codex,
        login,
    } = seeded();
    let payload = a.collect(true);
    let file = seal_backup(&payload, PASS, FAST).unwrap();
    assert!(
        !contains(&file, b"at-vertex"),
        "nothing secret is readable in the file"
    );
    assert!(!contains(&file, b"Vertex"), "account names are sealed too");

    let b = machine("b");
    let opened = open_backup(&file, PASS).unwrap();
    let summary = summarize_backup(&opened.payload, &b.store.state().accounts);
    let rows: Vec<_> = summary
        .accounts
        .iter()
        .map(|x| (x.name.as_str(), x.provider, x.sign_in, x.present))
        .collect();
    assert_eq!(
        rows,
        [
            ("Vertex", AccountProvider::Claude, true, false),
            ("Alto Codex", AccountProvider::Codex, true, false)
        ]
    );
    let imported = import_backup(
        &opened,
        BackupImportMode::Replace,
        &b.store,
        &default_proxy_config(),
        &b.context(),
    )
    .unwrap();
    assert_eq!(imported.result.added, 2.0);
    assert_eq!(imported.result.sign_ins, 2.0);
    assert_eq!(imported.result.sign_ins_failed, 0.0);
    assert_eq!(
        serde_json::to_value(imported.gateway).unwrap(),
        json!({
            "port": 9411,
            "routingStrategy": "soonest-reset",
            "affinityTtlSeconds": 3600,
            "accountOrder": [],
            "apiKey": "relay-test-key",
        })
    );

    // The registry and settings came over; the accepted risk notes and the gateway stay this computer's.
    let reopened = Store::open(
        b.data(),
        StoreOptions {
            backup_on_open: false,
            ..Default::default()
        },
    )
    .unwrap()
    .state();
    assert_eq!(
        reopened
            .accounts
            .iter()
            .map(|x| x.id.clone())
            .collect::<Vec<_>>(),
        [vertex.clone(), codex.clone()]
    );
    let auth = reopened.accounts[0].auth.clone().unwrap();
    assert_eq!(auth.email.as_deref(), Some("vertex@example.com"));
    assert!(auth.logged_in);
    assert_eq!(reopened.settings.usage_warning_percent, 95);
    assert!(reopened.settings.risk_acknowledged.is_empty());
    assert!(
        !reopened.settings.planning.auto_start,
        "early start waits for its risk note here"
    );

    // The Claude app sign-in is sealed with B's key: B opens it, A's key cannot.
    let sealed = fs::read(
        b.data()
            .join("desktop-vault/accounts")
            .join(format!("{DESKTOP_UUID}.bin")),
    )
    .unwrap();
    assert_eq!(b.sealer.unseal(&sealed).unwrap(), login);
    assert!(a.sealer.unseal(&sealed).is_err());

    // Claude Code's credential lands under B's profile path; the profile files follow.
    let vertex_profile = b.data().join("profiles").join(&vertex);
    assert!(
        b.keychain
            .items
            .borrow()
            .get(&vertex_profile)
            .unwrap()
            .contains("at-vertex")
    );
    assert!(
        fs::read_to_string(vertex_profile.join(".claude.json"))
            .unwrap()
            .contains("vertex@example.com")
    );
    assert!(
        fs::read_to_string(
            b.data()
                .join("profiles")
                .join(&codex)
                .join("provider-credential.json")
        )
        .unwrap()
        .contains("at-codex")
    );
}

#[test]
fn a_backup_without_sign_ins_carries_no_secret_and_its_accounts_arrive_signed_out() {
    let Seeded { a, vertex, .. } = seeded();
    let payload = a.collect(false);
    assert_eq!(payload.sessions, None);
    assert_eq!(payload.gateway.as_ref().unwrap().api_key, None);
    let file = seal_backup(&payload, PASS, FAST).unwrap();
    let b = machine("b");
    let opened = open_backup(&file, PASS).unwrap();
    assert!(!summarize_backup(&opened.payload, &[]).sign_ins);
    let imported = import_backup(
        &opened,
        BackupImportMode::Merge,
        &b.store,
        &default_proxy_config(),
        &b.context(),
    )
    .unwrap();
    assert_eq!(
        (
            imported.result.added,
            imported.result.sign_ins,
            imported.result.before
        ),
        (2.0, 0.0, None)
    );
    let account = b.store.account(&vertex).unwrap();
    assert!(!account.auth.unwrap().logged_in);
    assert_eq!(account.desktop.unwrap().account_uuid, DESKTOP_UUID);
    assert!(b.data().join("profiles").join(&vertex).is_dir());
    assert!(!b.data().join("desktop-vault/accounts").exists());
    assert!(b.keychain.items.borrow().is_empty());
}

#[test]
fn a_wrong_passphrase_and_a_changed_file_are_refused_never_partly_read() {
    let Seeded { a, .. } = seeded();
    let payload = a.collect(true);
    let file = seal_backup(&payload, PASS, FAST).unwrap();
    assert_eq!(
        reason(open_backup(&file, "not the passphrase")),
        BackupErrorReason::WrongPassphrase
    );
    for at in [10, 30, 60, file.len() - 5] {
        let mut changed = file.clone();
        changed[at] ^= 1;
        assert_eq!(
            reason(open_backup(&changed, PASS)),
            BackupErrorReason::WrongPassphrase,
            "byte {at}"
        );
    }
    assert_eq!(
        reason(open_backup(&file[..40], PASS)),
        BackupErrorReason::Damaged
    );
    assert_eq!(
        reason(seal_backup(&payload, "short", FAST)),
        BackupErrorReason::ShortPassphrase
    );
}

#[test]
fn the_format_is_checked_before_the_passphrase_is_asked() {
    let Seeded { a, .. } = seeded();
    let file = seal_backup(&a.collect(false), PASS, FAST).unwrap();
    assert_eq!(read_backup_header(&file).unwrap().params, FAST);
    let mut newer = file.clone();
    newer[4] = 2;
    assert_eq!(
        reason(read_backup_header(&newer)),
        BackupErrorReason::NewerFormat
    );
    assert_eq!(
        reason(open_backup(&newer, PASS)),
        BackupErrorReason::NewerFormat
    );
    assert_eq!(
        reason(read_backup_header(br#"{"kind":"relay-backup"}"#)),
        BackupErrorReason::NotABackup
    );
    let mut greedy = file.clone();
    greedy[5] = 24;
    assert_eq!(
        reason(read_backup_header(&greedy)),
        BackupErrorReason::Damaged
    );
}

#[test]
fn a_replace_first_saves_what_was_here_with_the_same_passphrase_a_merge_skips_accounts_already_here()
 {
    let Seeded { a, vertex, .. } = seeded();
    let payload = a.collect(true);
    let file = seal_backup(&payload, PASS, FAST).unwrap();

    let b = machine("b");
    let local = b.create("Example", AccountKind::Personal, None, None);
    let local_profile = b.data().join("profiles").join(&local);
    b.keychain.items.borrow_mut().insert(
        local_profile.clone(),
        json!({ "claudeAiOauth": { "accessToken": "at-local" } }).to_string(),
    );
    b.store
        .update(|state| state.settings.usage_warning_percent = 80)
        .unwrap();

    let import = |mode| {
        import_backup(
            &open_backup(&file, PASS).unwrap(),
            mode,
            &b.store,
            &default_proxy_config(),
            &b.context(),
        )
        .unwrap()
    };
    let merged = import(BackupImportMode::Merge);
    assert_eq!(merged.result.added, 2.0);
    assert_eq!(
        b.store.state().settings.usage_warning_percent,
        80,
        "a merge keeps this computer's settings"
    );
    let again = import(BackupImportMode::Merge);
    assert_eq!((again.result.added, again.result.skipped), (0.0, 2.0));
    assert!(
        summarize_backup(&payload, &b.store.state().accounts)
            .accounts
            .iter()
            .all(|x| x.present)
    );

    let replaced = import(BackupImportMode::Replace);
    let before = replaced.result.before.clone().unwrap();
    assert_eq!(
        b.store
            .state()
            .accounts
            .iter()
            .map(|x| x.name.as_str())
            .collect::<Vec<_>>(),
        ["Vertex", "Alto Codex"]
    );
    assert_eq!(b.store.state().settings.usage_warning_percent, 95);
    assert!(
        local_profile.exists(),
        "the dropped account's files stay on disk"
    );

    let kept = open_backup(
        &fs::read(b.data().join("relay-backups").join(before)).unwrap(),
        PASS,
    )
    .unwrap();
    assert_eq!(
        kept.payload
            .accounts
            .iter()
            .map(|x| x.name.as_str())
            .collect::<Vec<_>>(),
        ["Example", "Vertex", "Alto Codex"]
    );
    assert_eq!(
        kept.payload.settings["usageWarningPercent"],
        Value::from(80)
    );
    assert!(
        kept.payload
            .sessions
            .as_ref()
            .unwrap()
            .claude_code
            .get(&local)
            .unwrap()
            .contains("at-local")
    );
    assert!(kept.payload.accounts.iter().any(|x| x.id == vertex));
}
