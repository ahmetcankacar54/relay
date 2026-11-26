//! Port of `cli/src/context.ts`: everything a command needs, after the checks that keep the CLI
//! from damaging what Relay.app or a newer version wrote.

use std::ffi::OsString;
use std::sync::{Arc, Mutex};

use relay_core::desktop::{DesktopError, DesktopManager, OperationLock};
use relay_core::desktop_windows::{DesktopWindows, DesktopWindowsDeps};
use relay_core::process_lock::{LockBy, LockInfo, ProcessLock, ProcessLockError};
use relay_core::relay_paths::{Platform, RelayPaths, home_dir, relay_paths_with};
use relay_core::shared::types::DesktopOperationKind;
use relay_core::store::{STATE_SCHEMA, Store, StoreOptions};
use relay_core::vault_crypto::Sealer;
use relay_core::vault_key::{LoadVaultKey, VAULT_KEY_SERVICE, VaultKeyError, load_vault_key};
use relay_core::vault_migration::{VaultState, mark_vault_format, vault_state};
use relay_i18n::{Args, Locale};

use crate::args::Flags;
use crate::deps::CliDeps;
use crate::errors::{CliResult, Failure};
use crate::guards::{app_older_message, older_than, update_app_message};
use crate::host::CliHost;
use crate::i18n::{T, pick_lang};
use crate::io::{CliError, CliIo, Env, env_get, exit};
use crate::output::color_enabled;

/// What a command needs opened. `write`: it changes the registry or the vault. `desktop`: it
/// runs a Desktop operation, so the vault key is loaded and DesktopManager initialized.
/// `mac_os`: it needs macOS's own tools. A Desktop operation that writes does too: the CLI opens
/// the vault through the macOS Keychain; on Windows and Linux only Relay.app holds its key.
#[derive(Clone, Copy, Debug, Default)]
pub struct Needs {
    pub write: bool,
    pub desktop: bool,
    pub mac_os: bool,
}

impl Needs {
    pub const READ: Needs = Needs {
        write: false,
        desktop: false,
        mac_os: false,
    };
    pub const WRITE: Needs = Needs {
        write: true,
        desktop: false,
        mac_os: false,
    };
    pub const DESKTOP: Needs = Needs {
        write: true,
        desktop: true,
        mac_os: false,
    };
}

pub struct CliContext {
    pub paths: RelayPaths,
    pub store: Arc<Store>,
    pub desktop: Arc<DesktopManager>,
    /// The operation lock shared with Relay.app.
    pub lock: Arc<ProcessLock>,
    pub t: T,
    pub lang: Locale,
    pub io: CliIo,
    pub deps: CliDeps,
    pub flags: Flags,
    pub json: bool,
    pub yes: bool,
    pub color: bool,
    pub vault: VaultState,
    pub app_version: Option<String>,
    /// The holder the operation lock last refused, so a Desktop operation's busy error keeps it.
    busy: Arc<Mutex<Option<LockInfo>>>,
}

impl CliContext {
    /// A Desktop operation's error as the command ends with it: a refused operation lock keeps
    /// its holder (`LockBusyError`), anything else its message.
    pub fn desktop_failure(&self, error: DesktopError) -> Failure {
        if let DesktopError::LockBusy(message) = &error {
            if let Some(holder) = self.busy.lock().unwrap_or_else(|e| e.into_inner()).take() {
                return Failure::LockBusy(holder);
            }
            return Failure::Other(message.clone());
        }
        Failure::Other(error.message().to_owned())
    }
}

/// Relay's folders as `relayPaths(env)` finds them.
pub fn cli_paths(env: &Env) -> RelayPaths {
    relay_paths_with(
        &|name| env_get(env, name).map(OsString::from),
        &home_dir(),
        Platform::current(),
    )
}

/// The operation lock as DesktopManager takes it.
struct CliOperationLock {
    lock: Arc<ProcessLock>,
    busy: Arc<Mutex<Option<LockInfo>>>,
}

impl OperationLock for CliOperationLock {
    fn ensure(&self, kind: DesktopOperationKind) -> Result<Box<dyn FnOnce() + Send>, DesktopError> {
        match self.lock.try_acquire(kind.as_str()) {
            Ok(()) => {
                let lock = Arc::clone(&self.lock);
                Ok(Box::new(move || lock.release()))
            }
            Err(ProcessLockError::Busy(busy)) => {
                let message = busy.to_string();
                *self.busy.lock().unwrap_or_else(|e| e.into_inner()) = Some(busy.holder);
                Err(DesktopError::LockBusy(message))
            }
            Err(ProcessLockError::Io(e)) => Err(DesktopError::new(e.to_string())),
        }
    }
}

pub fn open_context(
    io: &CliIo,
    deps: &CliDeps,
    flags: &Flags,
    needs: Needs,
) -> CliResult<CliContext> {
    let lang = pick_lang(flags.str("lang"), &io.env);
    let t = T(lang);
    if deps.platform != Platform::MacOs && (needs.mac_os || (needs.desktop && needs.write)) {
        return Err(CliError::new(
            t.t("srcContext.savingAndSwitchingWorksOnMacosOnly"),
            exit::ENVIRONMENT,
        )
        .into());
    }
    let paths = cli_paths(&io.env);
    let app_version = (deps.relay_app_version)();
    let state_existed = paths.data.join("state.json").exists();
    let store = Arc::new(Store::open(
        &paths.data,
        StoreOptions {
            backup_on_open: false,
            migrate_on_open: false,
            // A registry without a schema is Relay 0.11's; it is only taken over without an app.
            adopt_unversioned: app_version.is_none(),
            by: LockBy::Cli,
            ..StoreOptions::default()
        },
    )?);
    if needs.write {
        if let Some(version) = &app_version
            && older_than(version, "0.12.0")
        {
            return Err(CliError::new(update_app_message(t), exit::ENVIRONMENT).into());
        }
        if app_version.is_some() && state_existed && store.file_schema() < STATE_SCHEMA {
            return Err(CliError::new(app_older_message(t), exit::ENVIRONMENT).into());
        }
        if store.file_schema() > STATE_SCHEMA {
            return Err(CliError::new(
                t.t("srcContext.aNewerRelayWroteTheAccount"),
                exit::ENVIRONMENT,
            )
            .into());
        }
    }
    let vault = vault_state(&paths.vault)?;
    if needs.desktop && matches!(vault, VaultState::Newer { .. }) {
        return Err(CliError::new(
            t.t("srcContext.aNewerRelayWroteTheVault"),
            exit::ENVIRONMENT,
        )
        .into());
    }
    if needs.desktop && needs.write && matches!(vault, VaultState::Legacy { .. }) {
        let message = match &app_version {
            Some(version) if !older_than(version, "0.12.0") => {
                t.t("srcContext.relayAppHasNotMovedThe")
            }
            _ => update_app_message(t),
        };
        return Err(CliError::new(message, exit::ENVIRONMENT).into());
    }
    let mut sealer = None;
    if needs.desktop && needs.write {
        let key = load_vault_key(&LoadVaultKey {
            tool: Some(&deps.security_tool),
            may_create: vault == VaultState::Empty,
        })
        .map_err(|error| {
            let args = Args::new().set("VAULT_KEY_SERVICE", VAULT_KEY_SERVICE);
            let id = match error {
                VaultKeyError::Missing => "srcContext.theKeychainItemIsMissingSo",
                VaultKeyError::Locked => "srcContext.theKeychainItemCouldNotBe",
                VaultKeyError::Invalid => "srcContext.theKeychainItemDoesNotHold",
                VaultKeyError::Spawn(message) => return Failure::Other(message),
            };
            Failure::Cli(CliError::new(t.f(id, args), exit::ENVIRONMENT))
        })?;
        sealer = Some(Sealer::new(&key).map_err(|e| Failure::Other(e.to_string()))?);
        if !paths.vault.join("format.json").exists() {
            mark_vault_format(&paths.vault)?;
        }
    }
    let scratch = paths.data.join("cli-scratch");
    let host: Arc<CliHost> = Arc::new(CliHost {
        inner: (deps.host)(&paths.claude_apps),
        sealer,
        closed: t.t("srcContext.theVaultIsNotOpenFor"),
        // The CLI never captures drafts; its own scratch folder keeps the start-up sweep away from
        // a capture Relay.app may be running.
        draft_scratch_dir: scratch.clone(),
    });
    let now = io.now.clone();
    let desktop = DesktopManager::new(
        &paths.claude,
        Arc::clone(&store),
        host.clone(),
        Some(deps.transcript_root.clone()),
        Some(Arc::new(move || now())),
    );
    // The app's separate Claude windows: a switch to an account open in one is refused here too,
    // and the main Claude takes over a closed window's conversations.
    let now = io.now.clone();
    let windows = DesktopWindows::new(DesktopWindowsDeps {
        folder: paths.data.join("claude-windows"),
        host: host.clone(),
        current: Box::new(|| Ok(None)),
        seed: Box::new(|_, _| Err(DesktopError::new("relay opens no separate windows."))),
        seal: Box::new(|_, _| Ok(false)),
        quic_off: None,
        now: Box::new(move || now()),
        sleep: None,
        log: None,
    });
    let lock = Arc::new(ProcessLock::new(
        paths.vault.join("operation.lock"),
        LockBy::Cli,
    ));
    let busy = Arc::new(Mutex::new(None));
    let operation_lock = CliOperationLock {
        lock: Arc::clone(&lock),
        busy: Arc::clone(&busy),
    };
    desktop.configure(|hooks| {
        // The Claude extension's sign-in follows the account here too; its backup stays out of the app's.
        hooks.extension = deps.extension.clone();
        hooks.extension_scratch_dir = Some(scratch.join("extension"));
        // And the terminal's Claude Code sign-in.
        hooks.terminal = deps.terminal.clone();
        hooks.windows = Some(Arc::new(windows));
        hooks.operation_lock = Some(Arc::new(operation_lock));
    });
    let ctx = CliContext {
        color: color_enabled(io, flags),
        json: flags.truthy("json"),
        yes: flags.truthy("yes"),
        paths,
        store,
        desktop,
        lock,
        t,
        lang,
        io: io.clone(),
        deps: deps.clone(),
        flags: flags.clone(),
        vault,
        app_version,
        busy,
    };
    if needs.desktop {
        ctx.desktop
            .initialize()
            .map_err(|e| ctx.desktop_failure(e))?;
    }
    Ok(ctx)
}
