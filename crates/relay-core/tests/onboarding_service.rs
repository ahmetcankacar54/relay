//! The `Service` cases of `tests/onboarding.test.ts` (its CLI diagnosis throttle). The other
//! cases are in `onboarding_environment.rs` and `shared_onboarding.rs`, or are UI
//! (`src/lib/onboarding`, routes) and main-process source text.

#[path = "common/p4services.rs"]
mod helpers;

use std::sync::Arc;

use relay_core::service::{Service, ServiceOptions};
use relay_core::shared::error_text::localize_error;
use relay_i18n::Locale;

fn service(root: &std::path::Path) -> Arc<Service> {
    let mut options = ServiceOptions::new(root.join("Relay"));
    options.imported_root = Some(root.join("unused"));
    Service::new(options).unwrap()
}

#[test]
fn a_missing_cli_error_says_where_to_choose_the_file_in_both_languages() {
    let root = tempfile::Builder::new()
        .prefix("relay-cli-missing-")
        .tempdir()
        .unwrap();
    let service = service(root.path());
    let missing = root.path().join("no-such-claude");
    service
        .store
        .update(|s| s.executable = Some(missing.to_string_lossy().into_owned()))
        .unwrap();
    let error = service.diagnose().error.expect("an error");
    assert_eq!(
        localize_error(&error, Locale::Tr),
        "Claude Code bulunamadı. Claude uygulamasında Code’u bir kez aç (Claude Code’u kendisi indirir) veya Ayarlar → Gelişmiş → Claude Code CLI → Dosyayı seç ile dosyasını göster."
    );
    assert_eq!(
        localize_error(&error, Locale::En),
        "Relay cannot find Claude Code. Open Code once in the Claude app, or select the file in Settings → Advanced → Claude Code CLI."
    );
}

#[cfg(unix)]
fn write_version_cli(file: &std::path::Path, version: &str) {
    // A new file each time, as `fs.writeFile` replaces the content the CLI is read from.
    let _ = std::fs::remove_file(file);
    helpers::script(
        file.parent().unwrap(),
        file.file_name().unwrap().to_str().unwrap(),
        &format!("echo '{version}'"),
    );
}

#[cfg(unix)]
fn clocked(root: &std::path::Path) -> (Arc<Service>, Arc<std::sync::Mutex<i64>>) {
    let service = service(root);
    let now = Arc::new(std::sync::Mutex::new(1_000_000));
    service.set_now(Box::new({
        let now = now.clone();
        move || *now.lock().unwrap()
    }));
    (service, now)
}

#[cfg(unix)]
#[test]
fn a_cli_installed_after_relay_started_is_noticed_by_a_later_snapshot_at_most_once_per_throttle() {
    let root = tempfile::Builder::new()
        .prefix("relay-cli-late-")
        .tempdir()
        .unwrap();
    let (service, now) = clocked(root.path());
    let cli = root.path().join("claude");
    let cli_text = cli.to_string_lossy().into_owned();
    service
        .store
        .update(|s| s.executable = Some(cli_text.clone()))
        .unwrap();
    let first = service.panel_snapshot();
    assert_eq!(first.diagnostics.executable, None);
    assert!(first.diagnostics.error.is_some());
    write_version_cli(&cli, "2.1.296 (Claude Code)");
    // Within the throttle the cached result stands.
    *now.lock().unwrap() += 5_000;
    assert!(service.panel_snapshot().diagnostics.error.is_some());
    *now.lock().unwrap() += Service::REDIAGNOSE_MS;
    let found = service.panel_snapshot().diagnostics;
    assert_eq!(found.executable.as_deref(), Some(cli_text.as_str()));
    assert_eq!(found.error, None);
    assert_eq!(found.version.as_deref(), Some("2.1.296 (Claude Code)"));
    assert_eq!(
        service.snapshot().diagnostics.version.as_deref(),
        Some("2.1.296 (Claude Code)")
    );
    // A usable result is kept for the whole process.
    write_version_cli(&cli, "2.1.300 (Claude Code)");
    *now.lock().unwrap() += Service::REDIAGNOSE_MS * 2;
    assert_eq!(
        service.panel_snapshot().diagnostics.version.as_deref(),
        Some("2.1.296 (Claude Code)")
    );
}

#[cfg(unix)]
#[test]
fn a_cli_too_old_to_read_limits_is_looked_at_again_so_an_update_is_noticed() {
    let root = tempfile::Builder::new()
        .prefix("relay-cli-old-")
        .tempdir()
        .unwrap();
    let (service, now) = clocked(root.path());
    let cli = root.path().join("claude");
    write_version_cli(&cli, "2.1.290 (Claude Code)");
    service
        .store
        .update(|s| s.executable = Some(cli.to_string_lossy().into_owned()))
        .unwrap();
    assert_eq!(
        service.panel_snapshot().diagnostics.version.as_deref(),
        Some("2.1.290 (Claude Code)")
    );
    write_version_cli(&cli, "2.1.296 (Claude Code)");
    *now.lock().unwrap() += Service::REDIAGNOSE_MS;
    assert_eq!(
        service.panel_snapshot().diagnostics.version.as_deref(),
        Some("2.1.296 (Claude Code)")
    );
}
