//! The errors a command ends with, by the class the TS throws (`describeError` in
//! `cli/src/main.ts` tells them apart by class), and the message and exit code each gives.

use relay_core::continuation_journal::PrivateJsonError;
use relay_core::desktop_files::DesktopFileError;
use relay_core::fs_util::parse_iso_ms;
use relay_core::process_lock::{LockBusyError, LockInfo, ProcessLockError};
use relay_core::profile_lock::{ProfileLockBusyError, ProfileLockError};
use relay_core::redact::{INVALID_JSON, redact};
use relay_core::shared::error_text::localize_error;
use relay_core::store::schema::SchemaError;
use relay_core::store::{StoreError, StoreWriteRefused};
use relay_core::vault_crypto::VaultFormatError;
use relay_core::vault_key::VaultKeyError;
use relay_core::vault_migration::VaultMigrationError;
use relay_i18n::{Args, Locale};

use crate::describe::lock_holder_text;
use crate::i18n::T;
use crate::io::{CliError, exit};

/// What a command failed with.
#[derive(Debug)]
pub enum Failure {
    /// `CliError`: shown as it is (redacted), with its own exit code.
    Cli(CliError),
    /// `LockBusyError`: the Desktop operation lock is held.
    LockBusy(LockInfo),
    /// `ProfileLockBusyError`.
    ProfileLockBusy,
    /// `ZodError`: the path of the first issue (`None` or empty at the root).
    Schema(Option<String>),
    /// `StoreWriteRefused`, `VaultKeyError`, `VaultFormatError`: localized, exit 5.
    Environment(String),
    /// Anything else: an `Error`'s message.
    Other(String),
}

pub type CliResult<T> = Result<T, Failure>;

impl Failure {
    pub fn cli(message: impl Into<String>, code: i32) -> Failure {
        Failure::Cli(CliError::new(message, code))
    }
    pub fn other(message: impl Into<String>) -> Failure {
        Failure::Other(message.into())
    }
    /// The message as `error.message` reads in the TS.
    pub fn message(&self) -> String {
        match self {
            Failure::Cli(e) => e.message.clone(),
            Failure::LockBusy(holder) => LockBusyError {
                holder: holder.clone(),
            }
            .to_string(),
            Failure::ProfileLockBusy => "Claude Code is running with this account.".into(),
            Failure::Schema(_) => "Invalid input".into(),
            Failure::Environment(m) | Failure::Other(m) => m.clone(),
        }
    }
}

impl From<CliError> for Failure {
    fn from(e: CliError) -> Self {
        Failure::Cli(e)
    }
}
impl From<LockBusyError> for Failure {
    fn from(e: LockBusyError) -> Self {
        Failure::LockBusy(e.holder)
    }
}
impl From<ProcessLockError> for Failure {
    fn from(e: ProcessLockError) -> Self {
        match e {
            ProcessLockError::Busy(b) => b.into(),
            ProcessLockError::Io(e) => e.into(),
        }
    }
}
impl From<ProfileLockBusyError> for Failure {
    fn from(_: ProfileLockBusyError) -> Self {
        Failure::ProfileLockBusy
    }
}
impl From<ProfileLockError> for Failure {
    fn from(e: ProfileLockError) -> Self {
        match e {
            ProfileLockError::Busy(b) => b.into(),
            ProfileLockError::Io(e) => e.into(),
            other => Failure::Other(other.to_string()),
        }
    }
}
impl From<SchemaError> for Failure {
    fn from(e: SchemaError) -> Self {
        Failure::Schema(e.path())
    }
}
impl From<StoreWriteRefused> for Failure {
    fn from(e: StoreWriteRefused) -> Self {
        Failure::Environment(e.to_string())
    }
}
impl From<StoreError> for Failure {
    fn from(e: StoreError) -> Self {
        match e {
            StoreError::Invalid(s) => s.into(),
            StoreError::WriteRefused(w) => w.into(),
            StoreError::Lock(l) => l.into(),
            StoreError::Json(_) => Failure::Other(INVALID_JSON.into()),
            StoreError::Io(e) => e.into(),
            other => Failure::Other(other.to_string()),
        }
    }
}
impl From<VaultKeyError> for Failure {
    fn from(e: VaultKeyError) -> Self {
        match e {
            VaultKeyError::Spawn(m) => Failure::Other(m),
            other => Failure::Environment(other.to_string()),
        }
    }
}
impl From<VaultFormatError> for Failure {
    fn from(e: VaultFormatError) -> Self {
        Failure::Environment(e.to_string())
    }
}
impl From<VaultMigrationError> for Failure {
    fn from(e: VaultMigrationError) -> Self {
        match e {
            VaultMigrationError::Io(e) => e.into(),
            other => Failure::Other(other.to_string()),
        }
    }
}
impl From<DesktopFileError> for Failure {
    fn from(e: DesktopFileError) -> Self {
        Failure::Other(e.to_string())
    }
}
impl From<PrivateJsonError> for Failure {
    fn from(e: PrivateJsonError) -> Self {
        match e {
            PrivateJsonError::Json(_) => Failure::Other(INVALID_JSON.into()),
            other => Failure::Other(other.to_string()),
        }
    }
}
impl From<std::io::Error> for Failure {
    fn from(e: std::io::Error) -> Self {
        Failure::Other(e.to_string())
    }
}
impl From<serde_json::Error> for Failure {
    fn from(_: serde_json::Error) -> Self {
        Failure::Other(INVALID_JSON.into())
    }
}

/// Core errors that mean "busy or blocked" (exit 3), with what to do about each.
fn blocked(message: &str) -> Option<&'static str> {
    if message.contains("Finish or cancel the current Desktop sign-in first") {
        Some("desktopOp.aSignInIsPendingFinish")
    } else if message.contains("Restore the interrupted Desktop switch first")
        || message.contains("Desktop recovery is required")
    {
        Some("desktopOp.aSwitchWasInterruptedRunRelay")
    } else if message.contains("A Desktop operation is already in progress") {
        Some("srcMain.anotherClaudeAppOperationIsRunning")
    } else {
        None
    }
}

/// `Math.max(0, Math.round((now - Date.parse(from)) / 1000))`; NaN for an unreadable time.
pub fn seconds_since(from: &str, now: i64) -> f64 {
    match parse_iso_ms(from) {
        Some(at) => js_round((now - at) as f64 / 1000.0).max(0.0),
        None => f64::NAN,
    }
}

/// `Math.round`: halves go up.
pub fn js_round(x: f64) -> f64 {
    let floor = x.floor();
    if x - floor >= 0.5 { floor + 1.0 } else { floor }
}

fn lock_message(holder: &LockInfo, t: T, now: i64) -> String {
    t.f(
        "srcMain.startedSAgoTryAgainWhen",
        Args::new()
            .set("lockHolderText", lock_holder_text(holder, t))
            .set("seconds", seconds_since(&holder.started_at, now)),
    )
}

/// The message and exit code an error ends the CLI with, in `lang`. Messages are always
/// redacted, and a core error the app knows (shared/error-text) is shown localized.
pub fn describe_error(error: &Failure, lang: Locale, now: i64) -> (String, i32) {
    let t = T(lang);
    match error {
        Failure::Cli(e) => (redact(&e.message, 600), e.code),
        Failure::LockBusy(holder) => (lock_message(holder, t, now), exit::BUSY),
        Failure::ProfileLockBusy => (t.t("srcMain.thisAccountIsInUseBy"), exit::BUSY),
        Failure::Schema(path) => (
            match path.as_deref().filter(|p| !p.is_empty()) {
                Some(where_) => t.f(
                    "srcMain.relaySAccountListStateJson2",
                    Args::new().set("where", where_),
                ),
                None => t.t("srcMain.relaySAccountListStateJson"),
            },
            exit::FAILED,
        ),
        Failure::Environment(m) => (localize_error(&redact(m, 600), lang), exit::ENVIRONMENT),
        Failure::Other(m) => {
            let message = redact(m, 600);
            if let Some(id) = blocked(&message) {
                return (t.t(id), exit::BUSY);
            }
            (localize_error(&message, lang), exit::FAILED)
        }
    }
}
