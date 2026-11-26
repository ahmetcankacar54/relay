//! Port of `electron/core/backup-prune.ts`: keeps the vault's switch backups to a bounded count.

use std::fs;
use std::path::Path;

use crate::desktop_files::read_object;
use crate::fs_util::mtime_ms;

/// How many switch backups (`<vault>/backups/<id>.bin`) the vault keeps.
pub const SWITCH_BACKUP_LIMIT: usize = 20;

/// `/^([0-9a-f]{8}-…-[0-9a-f]{12})\.bin$/i`: the id, lowercased.
fn backup_id(name: &str) -> Option<String> {
    let id = name.strip_suffix(".bin")?;
    let b = id.as_bytes();
    let shaped = b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        });
    shaped.then(|| id.to_lowercase())
}

/// Removes all but the newest `keep` switch backups, by modification time. The backup the
/// recovery journal (`journal.json`) names is never removed, however old: recovery restores
/// exactly that one. A journal that cannot be read removes nothing. Never fails, so pruning can
/// never fail a switch; returns how many backups it removed.
pub fn prune_switch_backups(vault: &Path, keep: usize) -> usize {
    let run = || -> Option<usize> {
        let journal = read_object(vault, "journal.json").ok()?;
        let referenced = journal
            .as_ref()
            .and_then(|j| j.get("backup"))
            .and_then(|b| b.as_str())
            .map(str::to_lowercase);
        let dir = vault.join("backups");
        let mut found: Vec<(String, String, f64)> = Vec::new();
        for entry in fs::read_dir(&dir).ok()? {
            let name = entry.ok()?.file_name().into_string().ok();
            let Some(name) = name else { continue };
            let Some(id) = backup_id(&name) else { continue };
            let stat = fs::symlink_metadata(dir.join(&name)).ok()?;
            if !stat.is_file() {
                continue;
            }
            found.push((name, id, mtime_ms(&stat).ok()?));
        }
        // Newest first; the same time by name, descending.
        found.sort_by(|a, b| b.2.total_cmp(&a.2).then_with(|| b.0.cmp(&a.0)));
        let mut removed = 0;
        for (name, id, _) in found.iter().skip(keep) {
            if Some(id) == referenced.as_ref() {
                continue;
            }
            match fs::remove_file(dir.join(name)) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Some(0),
            }
            removed += 1;
        }
        Some(removed)
    };
    // An old backup left behind costs a little disk; a failed switch costs far more.
    run().unwrap_or(0)
}
