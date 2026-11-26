//! Port of `electron/core/cli-diagnostics.ts`: finding the official Claude Code CLI and reading
//! its version.

use std::path::Path;

use crate::desktop_usage::desktop_usage_readable;
use crate::environment::{
    ExecutableSource, command, current_arch, executable_source, process_env, profile_environment,
    resolve_executable, supports_desktop,
};
use crate::relay_paths::Platform;
use crate::shared::types::{Diagnostics, DiagnosticsSource};
use crate::usage::js_slice;

/// Node's `process.platform` for this build.
pub fn platform_name(platform: Platform) -> &'static str {
    match platform {
        Platform::MacOs => "darwin",
        Platform::Windows => "win32",
        Platform::Linux => "linux",
    }
}

/// Finds the official Claude Code CLI (`explicit` first, then the usual places, then the one the
/// Claude app downloaded) and reads its version, in a throwaway profile under `data_dir` so no
/// account is involved.
pub fn diagnose_cli(explicit: Option<&str>, data_dir: &Path) -> Diagnostics {
    let executable = resolve_executable(explicit);
    let platform = Platform::current();
    let mut base = Diagnostics {
        source: executable
            .as_deref()
            .map(|e| match executable_source(e, explicit) {
                ExecutableSource::Chosen => DiagnosticsSource::Chosen,
                ExecutableSource::Path => DiagnosticsSource::Path,
                ExecutableSource::ClaudeApp => DiagnosticsSource::ClaudeApp,
            }),
        executable: executable.clone(),
        version: None,
        desktop_supported: false,
        desktop_usage: Some(desktop_usage_readable(data_dir, platform)),
        platform: platform_name(platform).into(),
        data_dir: data_dir.to_string_lossy().into_owned(),
        error: None,
    };
    let Some(executable) = executable else {
        base.error = Some("Claude Code was not found. Open Code once in the Claude app (it downloads Claude Code itself) or pick it in Settings → Advanced → Claude Code CLI → Choose file.".into());
        return base;
    };
    let env = profile_environment(
        &data_dir.join("diagnostic").to_string_lossy(),
        &process_env(),
    );
    match command(&executable, &["--version"], &env, data_dir) {
        Ok(output) => {
            let version = js_slice(output.stdout.trim(), 150);
            base.desktop_supported = supports_desktop(&version, platform, current_arch());
            base.version = Some(version);
        }
        Err(_) => {
            base.error =
                Some("The Claude Code version could not be read. Check the executable.".into());
        }
    }
    base
}
