//! Port of `electron/core/switch-diagnostics.ts`.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::fs_util::create_private_dir_all;
use crate::shared::types::{ClaudeLaunchChoice, ClaudeLaunchPatch};

/// How Relay starts Claude, chosen outside Relay's registry so a change never asks the registry
/// for a new layout: `quic_off`, Claude starts without HTTP/3. On some networks claude.ai's
/// HTTP/3 transfers stall after a working handshake, so Chromium never falls back and the page
/// stays grey (measured 2026-10-26: 13 of 73 assets answered in 8 s over HTTP/3, 94 of 98 in 2 s
/// over HTTP/2). Relay turns it on itself once a stuck start loads without HTTP/3.
///
/// There is no net log any more: Claude 3.6556 and later refuses to start with --log-net-log on
/// its command line. A `netLog` an older Relay saved is ignored.
#[derive(Debug, Clone)]
pub struct SwitchDiagnostics {
    /// The folder the choice lives in, created when first saved.
    pub folder: PathBuf,
    choice: ClaudeLaunchChoice,
}

impl SwitchDiagnostics {
    pub fn new(folder: impl Into<PathBuf>) -> SwitchDiagnostics {
        let folder = folder.into();
        let choice = read(&folder.join("settings.json"));
        SwitchDiagnostics { folder, choice }
    }

    fn file(&self) -> PathBuf {
        self.folder.join("settings.json")
    }

    pub fn current(&self) -> ClaudeLaunchChoice {
        self.choice
    }

    /// Changes what `patch` names, keeps the rest; returns the whole choice.
    pub fn set(&mut self, patch: ClaudeLaunchPatch) -> io::Result<ClaudeLaunchChoice> {
        let mut next = self.choice;
        if let Some(quic_off) = patch.quic_off {
            next.quic_off = quic_off;
        }
        create_private_dir_all(&self.folder)?;
        // writeFileSync's mode applies only when it creates the file.
        let mut options = OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let text = serde_json::to_string(&next).map_err(io::Error::other)?;
        options.open(self.file())?.write_all(text.as_bytes())?;
        self.choice = next;
        Ok(self.current())
    }
}

fn read(file: &Path) -> ClaudeLaunchChoice {
    let saved = fs::read(file)
        .ok()
        .and_then(|bytes| serde_json::from_str::<Value>(&String::from_utf8_lossy(&bytes)).ok());
    ClaudeLaunchChoice {
        quic_off: saved.and_then(|v| v.get("quicOff").and_then(Value::as_bool)) == Some(true),
    }
}
