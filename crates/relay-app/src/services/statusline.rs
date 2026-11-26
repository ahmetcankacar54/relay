//! The status line snapshot for `relay statusline` (port of electron/main/statusline.ts).

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use relay_core::shared::terminal_identity::DEFAULT_TERMINAL_MODE;
use relay_core::statusline_file::{
    StatuslineSnapshotInput, build_statusline_snapshot, write_statusline_file,
};

use crate::state::STATE;

/// A burst of changes (gateway answers, limit reads) writes the status line snapshot once.
const STATUSLINE_WRITE_DELAY_MS: u64 = 1_000;

/// A write is armed.
static ARMED: AtomicBool = AtomicBool::new(false);

/// Writes `<userData>/statusline.json` soon, for `relay statusline` in Claude Code: every limit
/// read, gateway answer, switch and token tick asks for it, so the file is never older than a
/// token tick while Relay runs. Never fails; an unwritten file only shows its age in the status
/// line.
pub fn schedule_statusline() {
    if ARMED.swap(true, Ordering::SeqCst) {
        return;
    }
    let spawned = std::thread::Builder::new()
        .name("relay-statusline".into())
        .spawn(|| {
            std::thread::sleep(Duration::from_millis(STATUSLINE_WRITE_DELAY_MS));
            ARMED.store(false, Ordering::SeqCst);
            // The status line says how old the last snapshot is.
            let _ = write();
        });
    if spawned.is_err() {
        ARMED.store(false, Ordering::SeqCst);
    }
}

fn write() -> Option<()> {
    let service = STATE.service.get()?;
    let (accounts, settings) = service
        .store
        .with_state(|s| (s.accounts.clone(), s.settings.clone()));
    let usage = STATE
        .usage
        .get()
        .map(|usage| usage.snapshot())
        .unwrap_or_default();
    let desktop_account_id = STATE
        .observed_desktop()
        .and_then(|state| state.active_profile_id);
    let sessions = crate::services::gateway::sessions();
    let profiles = service.store.root().join("profiles");
    let snapshot = build_statusline_snapshot(&StatuslineSnapshotInput {
        accounts: &accounts,
        usage: &usage,
        desktop_account_id: desktop_account_id.as_deref(),
        terminal_mode: settings.terminal_cli.unwrap_or(DEFAULT_TERMINAL_MODE),
        gateway_sessions: sessions.as_deref(),
        profiles: &profiles.to_string_lossy(),
        language: crate::i18n::locale(),
        zone: &settings.planning.time_zone,
        now: relay_core::clock::now_ms() as f64,
    });
    write_statusline_file(&STATE.paths().data_dir(), &snapshot).ok()
}
