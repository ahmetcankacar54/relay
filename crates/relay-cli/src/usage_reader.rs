//! The usage reader `relay usage` and `relay proxy start` share: limits read the way the app
//! reads them, through each account's own Claude Code sign-in, renewed when it must be.

use std::path::Path;
use std::sync::Arc;

use relay_core::cli_diagnostics::diagnose_cli;
use relay_core::profile_lock::{ProfileLockKind, acquire_profile_lock};
use relay_core::relay_paths::Platform;
use relay_core::shared::cli_version::reads_usage;
use relay_core::shared::types::{Account, UsageIssue};
use relay_core::usage::{CredentialRead, ProviderRead, UsageManager, UsageManagerDeps};
use relay_core::usage_credentials::{MISSING_RETRY_MS, UsageError, read_credential};
use relay_core::usage_refresh::{
    UsageCredentialRefresher, UsageRefreshDeps, anthropic_unreachable, default_probe,
};

use crate::context::CliContext;

/// `readCredential(profile, allowPrompt, securityTool)`.
pub fn credential_read(ctx: &CliContext) -> CredentialRead {
    let tool = ctx.deps.security_tool.clone();
    Arc::new(move |profile: &Path, allow_prompt: bool| {
        read_credential(
            profile,
            allow_prompt,
            Some(&tool),
            Platform::current(),
            MISSING_RETRY_MS,
        )
    })
}

/// A UsageManager over the context's registry; `provider` reads Codex and Antigravity accounts.
pub fn usage_manager(ctx: &CliContext, provider: Option<ProviderRead>) -> UsageManager {
    let explicit = (ctx.deps.claude)(ctx.store.with_state(|s| s.executable.clone()).as_deref());
    let data = ctx.paths.data.clone();
    let read = credential_read(ctx);
    let locks = ctx.paths.locks.clone();
    let mut refresh_deps = UsageRefreshDeps::new(
        Arc::new(move || {
            let d = diagnose_cli(explicit.as_deref(), &data);
            match d.executable {
                Some(executable)
                    if d.error.is_none() && reads_usage(d.version.as_deref().unwrap_or("")) =>
                {
                    Ok(executable)
                }
                _ => Err(UsageError::new(UsageIssue::Unavailable)),
            }
        }),
        read.clone(),
    );
    refresh_deps.request = Some(ctx.deps.request.clone());
    refresh_deps.profile_lock = Some(Arc::new(move |id: &str| {
        acquire_profile_lock(&locks, id, ProfileLockKind::Exclusive).map(|guard| {
            let mut guard = Some(guard);
            Box::new(move || {
                if let Some(mut g) = guard.take() {
                    g.release();
                }
            }) as _
        })
    }));
    refresh_deps.unreachable = Some(Arc::new(|| anthropic_unreachable(&default_probe)));
    let refresher = UsageCredentialRefresher::new(refresh_deps);
    let mut deps = UsageManagerDeps::new(read);
    deps.request = ctx.deps.request.clone();
    let now = ctx.io.now.clone();
    deps.now = Arc::new(move || now());
    let store = ctx.store.clone();
    let profile = move |account: &Account| store.profile(&account.id).unwrap_or_default();
    let refresh_profile = profile.clone();
    let refresh = refresher.clone();
    deps.refresh_credential = Some(Arc::new(move |account, credential, force, interaction| {
        refresh.refresh(
            account,
            &refresh_profile(account),
            credential,
            force,
            interaction,
        )
    }));
    deps.refresh_credential_pending = Some(Arc::new(move |account| {
        refresher.has_pending(&profile(account))
    }));
    deps.provider_usage = provider;
    UsageManager::new(ctx.store.clone(), deps)
}
