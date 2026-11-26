//! The Desktop host as a command uses it: the deps' host, sealing with the vault key the
//! context loaded, or refusing for a command that never opens the vault (`closedSealer`), and
//! with the CLI's own draft scratch folder.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use relay_core::desktop::{
    AnswerGuard, AutomationTarget, DesktopError, DesktopHost, DesktopResult, LaunchOptions,
};
use relay_core::desktop_instances::ClaudeWindowProcess;
use relay_core::desktop_launch::{ClaudeSignOut, LaunchWatch};
use relay_core::draft_transfer::{DraftJob, DraftResult};
use relay_core::vault_crypto::Sealer;

pub struct CliHost {
    pub inner: Arc<dyn DesktopHost>,
    /// `None`: the vault is not open for this command.
    pub sealer: Option<Sealer>,
    /// What a refused seal or unseal says.
    pub closed: String,
    pub draft_scratch_dir: PathBuf,
}

impl CliHost {
    fn sealer(&self) -> DesktopResult<&Sealer> {
        self.sealer
            .as_ref()
            .ok_or_else(|| DesktopError::new(self.closed.clone()))
    }
}

impl DesktopHost for CliHost {
    fn available(&self) -> bool {
        self.inner.available()
    }
    fn running(&self) -> DesktopResult<bool> {
        self.inner.running()
    }
    fn seems_running(&self) -> DesktopResult<bool> {
        self.inner.seems_running()
    }
    fn quit(&self, answer_guard: Option<&AnswerGuard>) -> DesktopResult<()> {
        self.inner.quit(answer_guard)
    }
    fn launch(&self, options: Option<LaunchOptions>) -> DesktopResult<()> {
        self.inner.launch(options)
    }
    fn seal(&self, data: &str) -> DesktopResult<Vec<u8>> {
        Ok(self.sealer()?.seal(data))
    }
    fn unseal(&self, data: &[u8]) -> DesktopResult<String> {
        self.sealer()?
            .unseal(data)
            .map_err(|e| DesktopError::new(e.to_string()))
    }
    fn reads_drafts(&self) -> bool {
        self.inner.reads_drafts()
    }
    fn read_drafts(&self, job: &DraftJob) -> DraftResult {
        self.inner.read_drafts(job)
    }
    fn drafts_blocked(&self) -> DesktopResult<Option<String>> {
        self.inner.drafts_blocked()
    }
    fn draft_scratch_dir(&self) -> Option<PathBuf> {
        Some(self.draft_scratch_dir.clone())
    }
    fn claude_uptime_ms(&self) -> Option<i64> {
        self.inner.claude_uptime_ms()
    }
    fn watch_launch(&self) -> Option<Box<dyn LaunchWatch>> {
        self.inner.watch_launch()
    }
    fn signed_out(&self) -> Option<bool> {
        self.inner.signed_out()
    }
    fn sign_outs(&self) -> Option<Vec<ClaudeSignOut>> {
        self.inner.sign_outs()
    }
    fn has_windows(&self) -> bool {
        self.inner.has_windows()
    }
    fn windows(&self) -> DesktopResult<Vec<ClaudeWindowProcess>> {
        self.inner.windows()
    }
    fn launch_window(&self, dir: &Path, options: Option<LaunchOptions>) -> DesktopResult<()> {
        self.inner.launch_window(dir, options)
    }
    fn quit_window(&self, pid: i64) -> DesktopResult<()> {
        self.inner.quit_window(pid)
    }
    fn activate_window(&self, pid: i64) -> DesktopResult<()> {
        self.inner.activate_window(pid)
    }
    fn automation_target(&self) -> DesktopResult<AutomationTarget> {
        self.inner.automation_target()
    }
    fn windows_seen(&self) -> usize {
        self.inner.windows_seen()
    }
}
