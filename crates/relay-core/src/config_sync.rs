//! Port of `electron/core/config-sync.ts`: keeps Claude Code's own setup the same in every
//! account's Relay profile at a switch.
//!
//! Each Relay account has its own Claude Code profile, so its user MCP servers (`mcpServers` in
//! `.claude.json`), `skills/` and `agents/`, `settings.json` and `CLAUDE.md` are its own. A switch
//! carries the chosen items from the account being left to the one switched to. Items merge by
//! name; one both sides have and that differs goes to the side whose copy is newer by
//! modification time. A copy the switched-to profile loses is saved first under
//! `<backups>/<timestamp>/` (the newest `CONFIG_SYNC_BACKUP_LIMIT` are kept). Nothing is deleted
//! by the merge, and nothing that signs an account in travels.

use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde::Serialize;
use serde_json::{Map, Value};

use crate::clock::now_ms;
use crate::fs_util::{create_private_dir, create_private_dir_all, mtime_ms, resolve, set_times};
use crate::shared::types::ConfigSyncSettings;
use crate::store::file_stamp;

/// How many backup folders `<userData>/config-sync-backups` keeps.
pub const CONFIG_SYNC_BACKUP_LIMIT: usize = 10;

/// The settings.json keys that travel; anything else (apiKeyHelper, auth, oauth…) never does.
pub const SYNCED_SETTINGS_KEYS: [&str; 5] = ["permissions", "env", "hooks", "statusLine", "model"];

/// The folders whose entries travel by name with the `skills` choice.
const ENTRY_FOLDERS: [&str; 2] = ["skills", "agents"];

/// The name words that mark an `env` variable as a secret.
const SECRET_WORDS: [&str; 13] = [
    "TOKEN",
    "SECRET",
    "PASSWORD",
    "PASSWD",
    "CREDENTIAL",
    "CREDENTIALS",
    "KEY",
    "APIKEY",
    "AUTH",
    "OAUTH",
    "COOKIE",
    "SESSION",
    "PAT",
];

/// An `env` variable that belongs to its account: a secret, or what decides which account or
/// endpoint Claude Code talks to. Judged by the name's `_`-separated words, so `GITHUB_TOKEN`
/// stays and `MAX_THINKING_TOKENS` travels.
pub fn account_local_env(name: &str) -> bool {
    let upper = name.to_uppercase();
    upper.split('_').any(|word| SECRET_WORDS.contains(&word))
        || upper == "ANTHROPIC_BASE_URL"
        || upper == "CLAUDE_CONFIG_DIR"
}

/// What a sync did, in the TS object's key order.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSyncResult {
    /// MCP servers added to or replaced in the profile switched to.
    pub mcp_servers: u32,
    /// Skill and agent entries added or replaced.
    pub entries: u32,
    /// settings.json keys added or replaced.
    pub settings: u32,
    pub claude_md: bool,
    /// The items that could not be read or written, by name; the rest still synced.
    pub failed: Vec<String>,
    /// The backup folder of this switch, when the profile switched to lost something.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup: Option<PathBuf>,
}

pub struct ConfigSyncOptions<'a> {
    /// The profile of the account being left.
    pub from: &'a Path,
    /// The profile of the account switched to.
    pub to: &'a Path,
    pub choice: ConfigSyncSettings,
    /// `<userData>/config-sync-backups`.
    pub backups: &'a Path,
    pub now: Option<&'a dyn Fn() -> i64>,
}

type Json = Map<String, Value>;
type Step = Result<(), io::Error>;

fn other(message: &str) -> io::Error {
    io::Error::other(message.to_string())
}

/// A regular file's metadata, or None when it is missing, a link or not a file.
fn file_stat(file: &Path) -> io::Result<Option<fs::Metadata>> {
    match fs::symlink_metadata(file) {
        Ok(meta) => Ok(meta.is_file().then_some(meta)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn exists(file: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(file) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

/// The JSON object in `file` and its mtime: None when missing, an error when it is not one.
fn read_json_object(file: &Path) -> io::Result<Option<(Json, f64)>> {
    let Some(stat) = file_stat(file)? else {
        // A link or folder in its place is never read or replaced.
        if exists(file)? {
            return Err(other("not-a-file"));
        }
        return Ok(None);
    };
    let text = String::from_utf8_lossy(&fs::read(file)?).into_owned();
    match serde_json::from_str::<Value>(&text).map_err(io::Error::other)? {
        Value::Object(map) => Ok(Some((map, mtime_ms(&stat)?))),
        _ => Err(other("not-an-object")),
    }
}

/// Writes through a temporary file, owner-only, so Claude Code never reads half a file.
fn write_atomic(file: &Path, data: &[u8]) -> Step {
    let mut name = file.as_os_str().to_owned();
    name.push(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let temporary = PathBuf::from(name);
    let result = (|| {
        let mut out = crate::fs_util::create_new_private(&temporary)?;
        out.write_all(data)?;
        drop(out);
        fs::rename(&temporary, file)
    })();
    let _ = fs::remove_file(&temporary);
    result
}

/// Claude Code's global config in a profile: the legacy `.config.json` when it exists.
fn profile_config_file(profile: &Path) -> io::Result<PathBuf> {
    let legacy = profile.join(".config.json");
    Ok(if file_stat(&legacy)?.is_some() {
        legacy
    } else {
        profile.join(".claude.json")
    })
}

/// Files and links under `root` with their bytes, and the newest modification time anywhere in it.
fn tree(root: &Path) -> io::Result<(BTreeMap<PathBuf, String>, f64)> {
    fn walk(
        root: &Path,
        relative: &Path,
        files: &mut BTreeMap<PathBuf, String>,
        mtime: &mut f64,
    ) -> Step {
        // `root.join("")` would add a trailing separator, which fails on a file.
        let full = if relative.as_os_str().is_empty() {
            root.to_path_buf()
        } else {
            root.join(relative)
        };
        let stat = fs::symlink_metadata(&full)?;
        *mtime = mtime.max(mtime_ms(&stat)?);
        if stat.file_type().is_symlink() {
            files.insert(
                relative.to_path_buf(),
                format!("link:{}", fs::read_link(&full)?.to_string_lossy()),
            );
        } else if stat.is_file() {
            files.insert(
                relative.to_path_buf(),
                format!("file:{}", STANDARD.encode(fs::read(&full)?)),
            );
        } else if stat.is_dir() {
            if !relative.as_os_str().is_empty() {
                files.insert(relative.to_path_buf(), "dir".into());
            }
            let mut names: Vec<_> = fs::read_dir(&full)?
                .map(|e| e.map(|e| e.file_name()))
                .collect::<io::Result<_>>()?;
            names.sort();
            for name in names {
                walk(root, &relative.join(name), files, mtime)?;
            }
        }
        Ok(())
    }
    let mut files = BTreeMap::new();
    let mut mtime = 0.0;
    walk(root, Path::new(""), &mut files, &mut mtime)?;
    Ok((files, mtime))
}

/// The visible entries of a skills or agents folder; a hidden one, or a link, never travels.
fn entries(dir: &Path) -> io::Result<Vec<String>> {
    let found = match fs::read_dir(dir) {
        Ok(found) => found,
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
            ) =>
        {
            return Ok(Vec::new());
        }
        Err(error) => return Err(error),
    };
    let mut names = Vec::new();
    for entry in found {
        let entry = entry?;
        let kind = entry.file_type()?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with('.') && (kind.is_dir() || kind.is_file()) {
            names.push(name);
        }
    }
    names.sort();
    Ok(names)
}

fn copy_link(source: &Path, target: &Path) -> Step {
    let link = fs::read_link(source)?;
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&link, target)
    }
    #[cfg(windows)]
    {
        if fs::metadata(source).map(|m| m.is_dir()).unwrap_or(false) {
            std::os::windows::fs::symlink_dir(&link, target)
        } else {
            std::os::windows::fs::symlink_file(&link, target)
        }
    }
}

/// `fs.cp(source, target, { recursive: true, verbatimSymlinks: true, preserveTimestamps })`:
/// links are copied as links; with `preserve_times` each file keeps its times.
fn copy_tree(source: &Path, target: &Path, preserve_times: bool) -> Step {
    let stat = fs::symlink_metadata(source)?;
    if stat.file_type().is_symlink() {
        copy_link(source, target)
    } else if stat.is_dir() {
        match fs::create_dir(target) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
        fs::set_permissions(target, stat.permissions())?;
        for entry in fs::read_dir(source)? {
            let name = entry?.file_name();
            copy_tree(&source.join(&name), &target.join(&name), preserve_times)?;
        }
        Ok(())
    } else {
        fs::copy(source, target)?;
        if preserve_times {
            set_times(target, stat.modified()?)?;
        }
        Ok(())
    }
}

fn remove_tree(path: &Path) -> Step {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn pretty(value: &impl Serialize) -> Vec<u8> {
    serde_json::to_string_pretty(value)
        .unwrap_or_default()
        .into_bytes()
}

/// This switch's backup folder, made on the first loss.
struct Backup<'a> {
    root: &'a Path,
    stamp: String,
    dir: Option<PathBuf>,
}

impl Backup<'_> {
    fn dir(&mut self) -> io::Result<PathBuf> {
        if let Some(dir) = &self.dir {
            return Ok(dir.clone());
        }
        create_private_dir_all(self.root)?;
        for n in 0.. {
            let candidate = self.root.join(if n == 0 {
                self.stamp.clone()
            } else {
                format!("{}-{n}", self.stamp)
            });
            match create_private_dir(&candidate) {
                Ok(()) => {
                    self.dir = Some(candidate.clone());
                    return Ok(candidate);
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error),
            }
        }
        unreachable!("the loop returns")
    }
}

/// Carries the chosen items from `from` to `to`. Each item is done on its own: one that fails is
/// named in `failed`, and the others still sync.
pub fn sync_profile_config(options: &ConfigSyncOptions<'_>) -> ConfigSyncResult {
    let ConfigSyncOptions {
        from,
        to,
        choice,
        backups,
        now,
    } = *options;
    let mut result = ConfigSyncResult::default();
    if resolve(from) == resolve(to) {
        return result;
    }
    let now = now.map_or_else(now_ms, |now| now());
    let mut backup = Backup {
        root: backups,
        stamp: file_stamp(now),
        dir: None,
    };

    if choice.mcp_servers && sync_mcp(from, to, &mut backup, &mut result).is_err() {
        result.failed.push("mcpServers".into());
    }
    if choice.skills {
        for folder in ENTRY_FOLDERS {
            if sync_entries(from, to, folder, &mut backup, &mut result).is_err() {
                result.failed.push(folder.into());
            }
        }
    }
    if choice.settings && sync_settings(from, to, &mut backup, &mut result).is_err() {
        result.failed.push("settings".into());
    }
    if choice.claude_md && sync_claude_md(from, to, &mut backup, &mut result).is_err() {
        result.failed.push("CLAUDE.md".into());
    }
    if backup.dir.is_some() {
        prune_config_sync_backups(backups, CONFIG_SYNC_BACKUP_LIMIT);
    }
    result.backup = backup.dir;
    result
}

fn sync_mcp(
    from: &Path,
    to: &Path,
    backup: &mut Backup<'_>,
    result: &mut ConfigSyncResult,
) -> Step {
    let Some((source, source_mtime)) = read_json_object(&profile_config_file(from)?)? else {
        return Ok(());
    };
    let Some(Value::Object(servers)) = source.get("mcpServers") else {
        return Ok(());
    };
    if servers.is_empty() {
        return Ok(());
    }
    let file = profile_config_file(to)?;
    let (mut target, target_mtime) = read_json_object(&file)?.unwrap_or_default();
    let own = match target.get("mcpServers") {
        None => Json::new(),
        Some(Value::Object(own)) => own.clone(),
        Some(_) => return Ok(()),
    };
    let mut next = own.clone();
    let mut lost = Json::new();
    for (name, server) in servers {
        match own.get(name) {
            None => {
                next.insert(name.clone(), server.clone());
            }
            Some(mine) if mine == server || target_mtime >= source_mtime => continue,
            Some(mine) => {
                lost.insert(name.clone(), mine.clone());
                next.insert(name.clone(), server.clone());
            }
        }
        result.mcp_servers += 1;
    }
    if result.mcp_servers == 0 {
        return Ok(());
    }
    if !lost.is_empty() {
        write_atomic(&backup.dir()?.join("mcpServers.json"), &pretty(&lost))?;
    }
    target.insert("mcpServers".into(), Value::Object(next));
    write_atomic(&file, &pretty(&target))
}

fn sync_entries(
    from: &Path,
    to: &Path,
    folder: &str,
    backup: &mut Backup<'_>,
    result: &mut ConfigSyncResult,
) -> Step {
    let source_dir = from.join(folder);
    let names = entries(&source_dir)?;
    if names.is_empty() {
        return Ok(());
    }
    let target_dir = to.join(folder);
    create_private_dir_all(&target_dir)?;
    for name in names {
        let source = source_dir.join(&name);
        let target = target_dir.join(&name);
        let (theirs, their_mtime) = tree(&source)?;
        if exists(&target)? {
            // A link the user made is theirs to keep.
            if fs::symlink_metadata(&target)?.file_type().is_symlink() {
                continue;
            }
            let (ours, our_mtime) = tree(&target)?;
            if ours == theirs || our_mtime >= their_mtime {
                continue;
            }
            let saved = backup.dir()?.join(folder).join(&name);
            create_private_dir_all(saved.parent().unwrap_or(&saved))?;
            copy_tree(&target, &saved, false)?;
        }
        let temporary = target_dir.join(format!(".{name}.{}.tmp", uuid::Uuid::new_v4()));
        let replaced = (|| {
            copy_tree(&source, &temporary, true)?;
            remove_tree(&target)?;
            fs::rename(&temporary, &target)
        })();
        let _ = remove_tree(&temporary);
        replaced?;
        result.entries += 1;
    }
    Ok(())
}

fn sync_settings(
    from: &Path,
    to: &Path,
    backup: &mut Backup<'_>,
    result: &mut ConfigSyncResult,
) -> Step {
    let Some((source, source_mtime)) = read_json_object(&from.join("settings.json"))? else {
        return Ok(());
    };
    let file = to.join("settings.json");
    let (target, target_mtime) = read_json_object(&file)?.unwrap_or_default();
    let mut next = target.clone();
    let mut lost = Json::new();
    let newer = source_mtime > target_mtime;
    for key in SYNCED_SETTINGS_KEYS {
        let Some(theirs) = source.get(key) else {
            continue;
        };
        let mut theirs = theirs.clone();
        let mut ours = target.get(key).cloned();
        // The account-local `env` variables of the profile switched to stay whoever wins.
        let mut kept = Json::new();
        if key == "env" {
            let Value::Object(their_env) = &theirs else {
                continue;
            };
            let own: Vec<(String, Value)> = match &ours {
                None => Vec::new(),
                Some(Value::Object(map)) => {
                    map.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
                }
                Some(_) => continue,
            };
            kept = own
                .iter()
                .filter(|(name, _)| account_local_env(name))
                .cloned()
                .collect();
            let own_travelling: Json = own
                .into_iter()
                .filter(|(name, _)| !account_local_env(name))
                .collect();
            let travelling: Json = their_env
                .iter()
                .filter(|(name, _)| !account_local_env(name))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect();
            if travelling.is_empty() {
                continue;
            }
            theirs = Value::Object(travelling);
            ours = (!own_travelling.is_empty()).then_some(Value::Object(own_travelling));
        }
        if let Some(ours) = &ours
            && (*ours == theirs || !newer)
        {
            continue;
        }
        if let Some(ours) = ours {
            lost.insert(key.into(), ours);
        }
        let value = match (&theirs, key) {
            (Value::Object(map), "env") => {
                let mut merged = kept;
                for (k, v) in map {
                    merged.insert(k.clone(), v.clone());
                }
                Value::Object(merged)
            }
            _ => theirs,
        };
        next.insert(key.into(), value);
        result.settings += 1;
    }
    if result.settings == 0 {
        return Ok(());
    }
    if !lost.is_empty() {
        write_atomic(&backup.dir()?.join("settings.json"), &pretty(&lost))?;
    }
    write_atomic(&file, &pretty(&next))
}

fn sync_claude_md(
    from: &Path,
    to: &Path,
    backup: &mut Backup<'_>,
    result: &mut ConfigSyncResult,
) -> Step {
    let source_file = from.join("CLAUDE.md");
    let Some(source) = file_stat(&source_file)? else {
        return Ok(());
    };
    let file = to.join("CLAUDE.md");
    let target = file_stat(&file)?;
    let text = fs::read(&source_file)?;
    if let Some(target) = target {
        let own = fs::read(&file)?;
        if own == text || mtime_ms(&target)? >= mtime_ms(&source)? {
            return Ok(());
        }
        write_atomic(&backup.dir()?.join("CLAUDE.md"), &own)?;
    } else if exists(&file)? {
        return Ok(());
    }
    write_atomic(&file, &text)?;
    result.claude_md = true;
    Ok(())
}

/// Removes all but the newest `keep` backup folders, by name (each is named by its time). Never
/// fails: an old backup left behind costs a little disk, a failed switch far more.
pub fn prune_config_sync_backups(root: &Path, keep: usize) -> usize {
    let run = || -> io::Result<usize> {
        let mut found = Vec::new();
        for entry in fs::read_dir(root)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if entry.file_type()?.is_dir() && dated(&name) {
                found.push(name);
            }
        }
        found.sort();
        found.reverse();
        let mut removed = 0;
        for name in found.iter().skip(keep) {
            fs::remove_dir_all(root.join(name))?;
            removed += 1;
        }
        Ok(removed)
    };
    run().unwrap_or(0)
}

/// `/^\d{4}-\d{2}-\d{2}T/`.
fn dated(name: &str) -> bool {
    let b = name.as_bytes();
    b.len() >= 11
        && b[..4].iter().all(u8::is_ascii_digit)
        && b[4] == b'-'
        && b[5..7].iter().all(u8::is_ascii_digit)
        && b[7] == b'-'
        && b[8..10].iter().all(u8::is_ascii_digit)
        && b[10] == b'T'
}
