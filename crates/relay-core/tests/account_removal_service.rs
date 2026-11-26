//! The `Service.remove` case of `tests/account-removal.test.ts` ("the app's removal refuses a
//! running terminal…"); the rest are in `account_removal.rs` and `account_removal_usage.rs`.
//! The TS swapped `runner.list` and `auth.active` for stand-ins; here a real terminal and a real
//! usage sign-in run on the account instead.

#![cfg(unix)]

#[path = "common/p4services.rs"]
mod helpers;

use std::collections::HashMap;
use std::fs;

use helpers::script;
use relay_core::account_removal::{AccountRemovalError, DesktopFacts};
use relay_core::environment::process_env;
use relay_core::runner::RunInput;
use relay_core::service::{Service, ServiceError, ServiceOptions, ServiceRemoval};
use relay_core::shared::error_text::localize_error;
use relay_core::shared::types::{
    AccountAuth, AccountDesktop, AccountKind, AccountRemoved, CreateAccount, RunKind,
};
use relay_i18n::Locale;

#[test]
fn the_app_s_removal_refuses_a_running_terminal_and_a_usage_sign_in_in_progress_and_signs_out_with_the_cli()
 {
    let dir = tempfile::Builder::new()
        .prefix("relay-remove-")
        .tempdir()
        .unwrap();
    let root = fs::canonicalize(dir.path()).unwrap();
    let mut options = ServiceOptions::new(&root);
    options.imported_root = Some(root.join("unused-imported"));
    let service = Service::new(options).unwrap();
    let vault = root.join("desktop-vault");
    let locks = root.join("profiles").join(".locks");
    let make = |name: &str| {
        let created = service
            .store
            .create(&CreateAccount {
                name: name.into(),
                kind: AccountKind::Personal,
                group: None,
                provider: None,
            })
            .unwrap();
        service
            .store
            .update(|s| {
                let a = s.accounts.iter_mut().find(|x| x.id == created.id).unwrap();
                a.desktop = Some(AccountDesktop {
                    account_uuid: uuid::Uuid::new_v4().to_string(),
                    org_id: uuid::Uuid::new_v4().to_string(),
                    saved_at: "2026-01-01T00:00:00.000Z".into(),
                    email: None,
                    rejected_at: None,
                });
                a.auth = Some(AccountAuth {
                    logged_in: true,
                    account_uuid: Some(uuid::Uuid::new_v4().to_string()),
                    checked_at: "2026-01-01T00:00:00.000Z".into(),
                    ..Default::default()
                });
            })
            .unwrap();
        let profile = service.store.profile(&created.id).unwrap();
        fs::write(profile.join(".credentials.json"), "{}").unwrap();
        (created.id, profile)
    };
    let (a, _) = make("A");
    let (b, b_profile) = make("B");
    let log = root.join("cli.log");
    let cli = script(
        &root,
        "fixture-cli",
        &format!(
            "if [ \"$1\" = \"--version\" ]; then echo \"2.1.296\"; exit 0; fi\necho \"$*|$CLAUDE_CONFIG_DIR\" >> \"{}\"",
            log.display()
        ),
    );
    service
        .store
        .update(|s| s.executable = Some(cli.to_string_lossy().into_owned()))
        .unwrap();
    let desktop = || -> Result<DesktopFacts, String> {
        Ok(DesktopFacts {
            active_profile_id: Some(a.clone()),
            pending_profile_id: None,
        })
    };
    let options = ServiceRemoval {
        vault: &vault,
        locks: &locks,
        desktop: &desktop,
    };

    // A terminal runs on B.
    let project = root.join("project");
    fs::create_dir_all(&project).unwrap();
    let run = service
        .runner
        .start(
            "/bin/cat",
            &[],
            &HashMap::new(),
            RunInput {
                account_id: b.clone(),
                title: "p".into(),
                cwd: project.to_string_lossy().into_owned(),
                kind: RunKind::Session,
                session_key: None,
            },
        )
        .unwrap();
    let refused = service.remove(&b, &options).unwrap_err();
    assert_eq!(
        refused.to_string(),
        "Stop the running session for this account first."
    );
    assert_eq!(
        localize_error(
            "Stop the running session for this account first.",
            Locale::Tr
        ),
        "Bu hesapta çalışan oturumu önce durdur."
    );
    service.runner.stop(&run.id).unwrap();

    // B's usage sign-in is in progress.
    let waiting = script(&root, "waiting-cli", "exec sleep 30");
    let flow = service
        .auth
        .start(
            &b,
            waiting.to_str().unwrap(),
            &b_profile,
            &process_env(),
            None,
        )
        .unwrap();
    let refused = service.remove(&b, &options).unwrap_err();
    assert!(
        refused
            .to_string()
            .contains("Finish or cancel this account’s usage sign-in first.")
    );
    assert!(
        localize_error(
            "Finish or cancel this account’s usage sign-in first.",
            Locale::Tr
        )
        .contains("limit okuma girişini tamamla ya da iptal et")
    );
    service.auth.cancel(&b, &flow.id).unwrap();

    assert!(matches!(
        service.remove(&a, &options),
        Err(ServiceError::Removal(AccountRemovalError::Refused(_)))
    ));
    assert!(!log.exists());
    assert_eq!(
        service.remove(&b, &options).unwrap(),
        AccountRemoved {
            signed_out: Some(true)
        }
    );
    assert_eq!(
        fs::read_to_string(&log).unwrap().trim(),
        format!("auth logout|{}", b_profile.display())
    );
    let names: Vec<String> = service
        .store
        .state()
        .accounts
        .into_iter()
        .map(|a| a.name)
        .collect();
    assert_eq!(names, ["A"]);
}
