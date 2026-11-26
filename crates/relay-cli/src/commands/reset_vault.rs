use relay_core::desktop_files::read_bytes;
use relay_core::fs_util::{create_private_dir_all, iso_timestamp};
use relay_core::vault_crypto::is_sealed_v2;
use relay_core::vault_key::{
    LoadVaultKey, VAULT_KEY_SERVICE, VaultKeyError, load_vault_key, read_vault_key,
};
use relay_core::vault_migration::{VaultState, mark_vault_format, sealed_files};
use relay_i18n::Args;

use crate::CommandRun;
use crate::confirm::confirm;
use crate::context::{Needs, open_context};
use crate::describe::relay_app_running;
use crate::errors::{CliResult, Failure};
use crate::io::{CliError, exit};

/// What a lost key leaves unusable, set aside together.
const SET_ASIDE: [&str; 7] = [
    "accounts",
    "backups",
    "drafts",
    "extension",
    "journal.json",
    "pending.json",
    "format.json",
];

/// Starts the vault over when its Keychain key is gone for good: the files it sealed are set
/// aside (never deleted), a new key is made, and every account's Claude app sign-in is cleared
/// so `relay add <name>` can link it again. Refused while the key can be read.
pub fn reset_vault(run: &CommandRun<'_>) -> CliResult<i32> {
    let (io, t) = (run.io, run.t);
    if !run.parsed.positionals.is_empty() {
        return Err(CliError::new(t.t("resetVault.usageRelayResetVault"), exit::USAGE).into());
    }
    // The vault key is a macOS Keychain item; elsewhere Relay.app keeps it.
    let ctx = open_context(
        io,
        run.deps,
        &run.parsed.flags,
        Needs {
            write: true,
            desktop: false,
            mac_os: true,
        },
    )?;
    match &ctx.vault {
        VaultState::Empty => {
            return Err(
                CliError::new(t.t("resetVault.theVaultIsEmptyNothingTo"), exit::FAILED).into(),
            );
        }
        VaultState::Newer { .. } => {
            return Err(CliError::new(
                t.t("resetVault.aNewerRelayWroteTheVault"),
                exit::ENVIRONMENT,
            )
            .into());
        }
        // An old-format vault never had a key: its sign-ins are sealed by Relay.app's own key,
        // which the app moves to the vault key itself. Only files sealed with the vault key can
        // be orphaned.
        VaultState::Legacy { .. } => {
            let mut any_v2 = false;
            for relative in sealed_files(&ctx.paths.vault)? {
                if read_bytes(&ctx.paths.vault, &relative)?.is_some_and(|data| is_sealed_v2(&data))
                {
                    any_v2 = true;
                }
            }
            if !any_v2 {
                return Err(
                    CliError::new(t.t("resetVault.theVaultIsStillInThe"), exit::FAILED).into(),
                );
            }
        }
        VaultState::Ready => {}
    }
    // A running Relay.app keeps the key it loaded in memory and would go on sealing with it.
    // Unknown: go on; the operation lock below still guards a running operation.
    if (ctx.deps.process_list)().is_ok_and(|l| relay_app_running(&l)) {
        return Err(CliError::new(t.t("resetVault.quitRelayAppFirstQThen"), exit::BUSY).into());
    }
    match read_vault_key(&ctx.deps.security_tool) {
        Ok(_) => {
            return Err(CliError::new(t.t("resetVault.theVaultKeyCanBeRead"), exit::FAILED).into());
        }
        Err(VaultKeyError::Locked) => {
            return Err(CliError::new(
                t.t("resetVault.theKeychainIsLockedUnlockThe"),
                exit::ENVIRONMENT,
            )
            .into());
        }
        Err(VaultKeyError::Invalid) => {
            return Err(CliError::new(
                t.f(
                    "resetVault.theKeychainItemIsDamagedDelete",
                    Args::new().set("VAULT_KEY_SERVICE", VAULT_KEY_SERVICE),
                ),
                exit::ENVIRONMENT,
            )
            .into());
        }
        Err(VaultKeyError::Spawn(message)) => return Err(Failure::Other(message)),
        Err(VaultKeyError::Missing) => {}
    }
    confirm(
        io,
        t,
        &[
            t.t("resetVault.theVaultKeyIsGoneFrom"),
            t.t("resetVault.theOldFilesWillBeSet"),
            t.t("resetVault.thenSaveEachAccountAgainWith"),
        ],
        ctx.yes,
    )?;
    ctx.lock.try_acquire("reset")?;
    let result = (|| -> CliResult<()> {
        let stamp = iso_timestamp(io.now()).replace([':', '.'], "-");
        let aside = ctx.paths.vault.join(format!("lost-key-{stamp}"));
        create_private_dir_all(&aside)?;
        for name in SET_ASIDE {
            let from = ctx.paths.vault.join(name);
            if from.exists() {
                std::fs::rename(&from, aside.join(name))?;
            }
        }
        ctx.store.update(|s| {
            for account in &mut s.accounts {
                account.desktop = None;
            }
        })?;
        load_vault_key(&LoadVaultKey {
            tool: Some(&ctx.deps.security_tool),
            may_create: true,
        })?;
        mark_vault_format(&ctx.paths.vault)?;
        Ok(())
    })();
    ctx.lock.release();
    result?;
    io.out(&t.t("resetVault.theVaultWasResetSaveEach"));
    Ok(exit::OK)
}
