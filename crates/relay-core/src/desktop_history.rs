//! Port of `electron/core/desktop-history.ts`: what a Claude app account's Code history holds.
//! Presence of a transcript is evidence, not a promise of native resume; nothing here writes.

use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::Path;

use crate::clock::now_ms;
use crate::desktop_files::{
    DesktopFileError, JsonObject, Scope, duplicate_sessions, is_uuid, read_object, safe_file,
    scope_path,
};
use crate::fs_util::iso_timestamp;
use crate::shared::types::DesktopHistorySummary;

#[derive(Debug, thiserror::Error)]
pub enum DesktopHistoryError {
    #[error(transparent)]
    File(#[from] DesktopFileError),
    #[error("Unrecognized project format.")]
    UnrecognizedProjects,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Transcript {
    Found,
    Missing,
    Unknown,
}

/// Node's `path.isAbsolute` on this platform.
fn is_absolute(cwd: &str) -> bool {
    Path::new(cwd).is_absolute()
        || (cfg!(windows) && (cwd.starts_with('/') || cwd.starts_with('\\')))
}

/// `text.replace(pattern, "-")` per UTF-16 unit, as a non-unicode JS regex replaces.
fn slug(cwd: &str, keep: impl Fn(char) -> bool) -> String {
    cwd.chars()
        .flat_map(|c| {
            let units = if keep(c) { 0 } else { c.len_utf16() };
            if units == 0 {
                vec![c]
            } else {
                vec!['-'; units]
            }
        })
        .collect()
}

fn transcript_status(root: Option<&Path>, record: &JsonObject) -> Transcript {
    let session = record
        .get("cliSessionId")
        .and_then(|v| v.as_str())
        .filter(|id| is_uuid(id));
    let (Some(root), Some(session)) = (root, session) else {
        return Transcript::Unknown;
    };
    let mut directories: Vec<&str> = Vec::new();
    for key in ["originCwd", "cwd"] {
        if let Some(cwd) = record.get(key).and_then(|v| v.as_str())
            && is_absolute(cwd)
            && !directories.contains(&cwd)
        {
            directories.push(cwd);
        }
    }
    if directories.is_empty() {
        return Transcript::Unknown;
    }
    match safe_file(root, "projects").and_then(|p| Ok(fs::symlink_metadata(p)?)) {
        Ok(meta) if meta.is_dir() => {}
        _ => return Transcript::Unknown,
    }
    // The encodings the CLI has used; exact candidate filenames are probed, never scanned.
    let mut slugs: Vec<String> = Vec::new();
    for cwd in &directories {
        for candidate in [
            slug(cwd, |c| !matches!(c, '/' | '_' | '.')),
            slug(cwd, |c| c.is_ascii_alphanumeric()),
        ] {
            if !slugs.contains(&candidate) {
                slugs.push(candidate);
            }
        }
    }
    // Other CLI versions may encode Unicode folders differently: a failed probe proves nothing.
    let mut unknown = directories.iter().any(|cwd| !cwd.is_ascii());
    for slug in slugs {
        let probe = safe_file(root, &format!("projects/{slug}/{session}.jsonl"))
            .and_then(|file| Ok(fs::symlink_metadata(file)?));
        match probe {
            Ok(meta) if meta.is_file() && meta.len() > 0 => return Transcript::Found,
            Ok(_) => unknown = true,
            Err(DesktopFileError::Io(error)) if error.kind() == io::ErrorKind::NotFound => {}
            Err(_) => unknown = true,
        }
    }
    if unknown {
        Transcript::Unknown
    } else {
        Transcript::Missing
    }
}

/// `/^local_([a-f0-9-]{36})\.json$/i` and `/^deleted_([a-f0-9-]{36})(?:\.json)?$/i`.
fn record_id(name: &str, prefix: &str, json_optional: bool) -> Option<String> {
    let rest = name
        .get(..prefix.len())
        .filter(|p| p.eq_ignore_ascii_case(prefix))
        .map(|_| &name[prefix.len()..])?;
    let id = match rest.len() {
        36 if json_optional => rest,
        41 => rest
            .get(..36)
            .filter(|_| rest[36..].eq_ignore_ascii_case(".json"))?,
        _ => return None,
    };
    id.bytes()
        .all(|b| b.is_ascii_hexdigit() || b == b'-')
        .then(|| id.to_lowercase())
}

/// Counts the account's Code conversations, archived ones, projects, transcripts found and
/// duplicates.
pub fn summarize_history(
    desktop_root: &Path,
    scope: &Scope,
    profile_id: &str,
    source_profiles: f64,
    transcript_root: Option<&Path>,
) -> Result<DesktopHistorySummary, DesktopHistoryError> {
    let mut summary = DesktopHistorySummary {
        profile_id: profile_id.to_string(),
        indexed: 0.0,
        archived: 0.0,
        projects: 0.0,
        transcripts_found: 0.0,
        missing_transcripts: 0.0,
        unknown_transcripts: 0.0,
        duplicates: 0.0,
        source_profiles,
        checked_at: iso_timestamp(now_ms()),
    };
    let relative = scope_path("claude-code-sessions", scope)?;
    let names: Vec<String> = match safe_file(desktop_root, &relative)
        .and_then(|dir| Ok(fs::read_dir(dir)?))
    {
        Ok(entries) => entries
            .map(|entry| Ok(entry?.file_name().to_string_lossy().into_owned()))
            .collect::<io::Result<_>>()
            .map_err(DesktopFileError::from)?,
        Err(DesktopFileError::Io(error)) if error.kind() == io::ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(error.into()),
    };
    let deleted: HashSet<String> = names
        .iter()
        .filter_map(|name| record_id(name, "deleted_", true))
        .collect();
    for name in &names {
        let Some(id) = record_id(name, "local_", false) else {
            continue;
        };
        if deleted.contains(&id) {
            continue;
        }
        summary.indexed += 1.0;
        match read_object(desktop_root, &format!("{relative}/{name}")) {
            Ok(Some(record)) => {
                let flag = |key: &str| record.get(key) == Some(&serde_json::Value::Bool(true));
                if flag("archived") || flag("isArchived") {
                    summary.archived += 1.0;
                }
                match transcript_status(transcript_root, &record) {
                    Transcript::Found => summary.transcripts_found += 1.0,
                    Transcript::Missing => summary.missing_transcripts += 1.0,
                    Transcript::Unknown => summary.unknown_transcripts += 1.0,
                }
            }
            _ => summary.unknown_transcripts += 1.0,
        }
    }
    let spaces = read_object(
        desktop_root,
        &format!(
            "{}/spaces.json",
            scope_path("local-agent-mode-sessions", scope)?
        ),
    )?;
    if let Some(spaces) = &spaces {
        let Some(list) = spaces.get("spaces").and_then(|s| s.as_array()) else {
            return Err(DesktopHistoryError::UnrecognizedProjects);
        };
        summary.projects = list.len() as f64;
    }
    summary.duplicates = duplicate_sessions(desktop_root, scope)?
        .iter()
        .map(|group| group.len() as f64 - 1.0)
        .sum();
    Ok(summary)
}
