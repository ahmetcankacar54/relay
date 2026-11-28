//! Port of `electron/core/desktop-files.ts`: the file primitives for Claude Desktop's data and
//! Relay's desktop vault, and the conversation and project merge planners.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{Map, Value};

use crate::fs_util::{create_new_private, create_private_dir_all, dirname, resolve};

/// A JSON object, keys in file order.
pub type JsonObject = Map<String, Value>;

/// The largest Desktop file Relay reads, 64 MiB.
pub const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;

/// The `config.json` keys that sign Claude Desktop in.
pub const AUTH_KEYS: [&str; 3] = [
    "oauth:tokenCache",
    "oauth:tokenCacheV2",
    "lastKnownAccountUuid",
];

/// Claude Desktop's cookie database and its journals, old and new layout.
pub const COOKIE_FILES: [&str; 8] = [
    "Cookies",
    "Cookies-journal",
    "Cookies-wal",
    "Cookies-shm",
    "Network/Cookies",
    "Network/Cookies-journal",
    "Network/Cookies-wal",
    "Network/Cookies-shm",
];

#[derive(Debug, thiserror::Error)]
pub enum DesktopFileError {
    #[error("Invalid Desktop path.")]
    InvalidPath,
    #[error("Desktop data cannot contain symbolic links.")]
    SymbolicLink,
    #[error("Unsupported Desktop file size or type.")]
    UnsupportedFile,
    #[error("Unsupported Desktop data format.")]
    UnsupportedFormat,
    /// An id that is not a uuid (zod's `z.uuid().parse`).
    #[error("Invalid UUID")]
    InvalidUuid,
    #[error("Unrecognized project format.")]
    UnrecognizedProjectFormat,
    #[error("Unrecognized project record.")]
    UnrecognizedProjectRecord,
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Io(#[from] io::Error),
}

/// zod 4's `z.uuid()`: RFC 9562 versions 1–8 with the variant bits, or the nil and max uuids.
pub fn is_uuid(text: &str) -> bool {
    if text == "00000000-0000-0000-0000-000000000000"
        || text == "ffffffff-ffff-ffff-ffff-ffffffffffff"
    {
        return true;
    }
    let bytes = text.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (i, &b) in bytes.iter().enumerate() {
        let ok = match i {
            8 | 13 | 18 | 23 => b == b'-',
            14 => (b'1'..=b'8').contains(&b),
            19 => matches!(b, b'8' | b'9' | b'a' | b'b' | b'A' | b'B'),
            _ => b.is_ascii_hexdigit(),
        };
        if !ok {
            return false;
        }
    }
    true
}

/// `relative` under `root`, refused when it leaves `root` or passes through a symbolic link
/// (`root` itself included).
pub fn safe_file(root: &Path, relative: &str) -> Result<PathBuf, DesktopFileError> {
    let base = resolve(root);
    let target = resolve(&base.join(relative));
    let mut prefix = base.as_os_str().as_encoded_bytes().to_vec();
    prefix.push(std::path::MAIN_SEPARATOR as u8);
    if !target.as_os_str().as_encoded_bytes().starts_with(&prefix) {
        return Err(DesktopFileError::InvalidPath);
    }
    let mut p = target.as_path();
    loop {
        match fs::symlink_metadata(p) {
            Ok(meta) if meta.is_symlink() => return Err(DesktopFileError::SymbolicLink),
            Ok(_) => {}
            Err(e) if crate::fs_util::is_enoent(&e) => {}
            Err(e) => return Err(e.into()),
        }
        if p == base {
            break;
        }
        p = dirname(p);
    }
    Ok(target)
}

/// The file's bytes, or None when it is not there.
pub fn read_bytes(root: &Path, relative: &str) -> Result<Option<Vec<u8>>, DesktopFileError> {
    let file = safe_file(root, relative)?;
    let read = || -> Result<Vec<u8>, DesktopFileError> {
        let st = fs::metadata(&file)?;
        if !st.is_file() || st.len() > MAX_FILE_BYTES {
            return Err(DesktopFileError::UnsupportedFile);
        }
        Ok(fs::read(&file)?)
    };
    match read() {
        Ok(data) => Ok(Some(data)),
        Err(DesktopFileError::Io(e)) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// The file's JSON object, or None when it is not there. Anything but an object is refused.
pub fn read_object(root: &Path, relative: &str) -> Result<Option<JsonObject>, DesktopFileError> {
    let Some(data) = read_bytes(root, relative)? else {
        return Ok(None);
    };
    // Buffer#toString: invalid UTF-8 becomes U+FFFD, a byte-order mark stays (and fails).
    match serde_json::from_str::<Value>(&String::from_utf8_lossy(&data))? {
        Value::Object(obj) => Ok(Some(obj)),
        _ => Err(DesktopFileError::UnsupportedFormat),
    }
}

/// Replaces the file with `data` through a private `<file>.relay-<uuid>` file that is flushed
/// and renamed into place; missing folders are created private. `None` removes the file.
pub fn write_bytes(
    root: &Path,
    relative: &str,
    data: Option<&[u8]>,
) -> Result<(), DesktopFileError> {
    let file = safe_file(root, relative)?;
    let Some(data) = data else {
        return match fs::remove_file(&file) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e.into()),
            _ => Ok(()),
        };
    };
    create_private_dir_all(dirname(&file))?;
    let mut tmp = file.as_os_str().to_owned();
    tmp.push(format!(".relay-{}", uuid::Uuid::new_v4()));
    let tmp = PathBuf::from(tmp);
    let result = (|| -> io::Result<()> {
        let mut handle = create_new_private(&tmp)?;
        handle.write_all(data)?;
        handle.sync_all()?;
        drop(handle);
        fs::rename(&tmp, &file)
    })();
    match fs::remove_file(&tmp) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e.into()),
        _ => Ok(result?),
    }
}

/// `JSON.stringify(value, null, 2)` as bytes, no trailing newline.
pub fn json_bytes<T: Serialize + ?Sized>(value: &T) -> Vec<u8> {
    serde_json::to_vec_pretty(value).expect("JSON values always serialize")
}

/// The account Claude Desktop's `config.json` is signed in as: its `lastKnownAccountUuid`
/// when it is a uuid and a `oauth:tokenCacheV2` is present.
pub fn identity(config: Option<&JsonObject>) -> Option<String> {
    let config = config?;
    let id = config.get("lastKnownAccountUuid")?.as_str()?;
    let cache = config.get("oauth:tokenCacheV2")?.as_str()?;
    (is_uuid(id) && !cache.is_empty()).then(|| id.to_owned())
}

/// The uuid-named folders in `relative`, in directory order; none when it is not there.
pub fn directories(root: &Path, relative: &str) -> Result<Vec<String>, DesktopFileError> {
    let dir = safe_file(root, relative)?;
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    let mut names = Vec::new();
    for entry in entries {
        let entry = entry?;
        // Dirent#isDirectory: a link to a folder is not one.
        if !entry.file_type()?.is_dir() {
            continue;
        }
        if let Some(name) = entry.file_name().to_str().filter(|n| is_uuid(n)) {
            names.push(name.to_owned());
        }
    }
    Ok(names)
}

/// An account in an organization: where Claude Desktop keeps its per-account data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scope {
    pub account_uuid: String,
    pub org_id: String,
}

/// `<kind>/<accountUuid>/<orgId>`, refusing ids that are not uuids.
pub fn scope_path(kind: &str, scope: &Scope) -> Result<String, DesktopFileError> {
    if !is_uuid(&scope.account_uuid) || !is_uuid(&scope.org_id) {
        return Err(DesktopFileError::InvalidUuid);
    }
    Ok(format!("{kind}/{}/{}", scope.account_uuid, scope.org_id))
}

/// One record of a carried conversation: its alias and the account it belongs to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CarriedMember {
    pub alias: String,
    pub account_uuid: String,
}

/// One conversation the merge carries into the target account.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CarriedConversation {
    /// The alias of the conversation's single card in the target after the merge.
    pub target_alias: String,
    /// Every record of the group, any account, including target cards the merge deletes.
    pub members: Vec<CarriedMember>,
}

/// The files a plan writes, by path under Claude's data folder, in the order first planned;
/// `None` removes the file. A later write to a path replaces it in place, as `Map.set` does.
pub type Writes = indexmap::IndexMap<String, Option<Vec<u8>>>;

struct SessionRecord {
    name: String,
    alias: String,
    obj: JsonObject,
    scope: Scope,
    is_target: bool,
}

impl SessionRecord {
    fn cli_session_id(&self) -> &str {
        self.obj
            .get("cliSessionId")
            .and_then(Value::as_str)
            .unwrap_or("")
    }
    fn last_activity_at(&self) -> f64 {
        self.obj
            .get("lastActivityAt")
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
    }
}

/// `Number.isFinite(value)`.
fn finite(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64).filter(|n| n.is_finite())
}

/// A conversation Claude runs over SSH: its folder is on the remote machine, so it may be neither
/// absolute nor resolvable here.
fn ssh_host(obj: &JsonObject) -> Option<String> {
    let config = obj.get("sshConfig")?.as_object()?;
    let host = config.get("sshHost")?.as_str().filter(|h| !h.is_empty())?;
    let port = match finite(config.get("sshPort")) {
        Some(port) => crate::shared::types::js::number_string(port),
        None => "22".into(),
    };
    Some(format!("{host}:{port}"))
}

fn posix_absolute(path: &str) -> bool {
    path.starts_with('/')
}

fn win32_absolute(path: &str) -> bool {
    let bytes = path.as_bytes();
    matches!(bytes.first(), Some(b'/' | b'\\'))
        || (bytes.len() > 2
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && matches!(bytes[2], b'/' | b'\\'))
}

/// Node's `path.isAbsolute` on this host.
fn host_absolute(path: &str) -> bool {
    if cfg!(windows) {
        win32_absolute(path)
    } else {
        posix_absolute(path)
    }
}

/// A record's folder is usable: absolute here, or absolute on the remote machine for SSH.
fn usable_cwd(obj: &JsonObject) -> bool {
    let Some(cwd) = obj.get("cwd").and_then(Value::as_str) else {
        return false;
    };
    host_absolute(cwd) || (ssh_host(obj).is_some() && (win32_absolute(cwd) || posix_absolute(cwd)))
}

fn session_key(cli_session_id: &str, obj: &JsonObject) -> String {
    use unicode_normalization::UnicodeNormalization;
    let cwd = obj.get("cwd").and_then(Value::as_str).unwrap_or("");
    let folder = match ssh_host(obj) {
        Some(host) => format!("ssh:{host}:{cwd}"),
        None => resolve(Path::new(cwd)).to_string_lossy().into_owned(),
    };
    format!(
        "{}|{}",
        cli_session_id.to_lowercase(),
        folder.nfc().collect::<String>()
    )
}

/// Desktop gives every account its own `local_<uuid>` alias for a conversation, and it adopts
/// transcripts started under another account as `local_<cliSessionId>`. Records are grouped by
/// file name, current CLI session and resumed lineage (`priorCliSessionIds`). Each group must
/// produce exactly one card per account. Groups keep the order of their first record.
fn group_sessions(records: &[SessionRecord]) -> Vec<Vec<usize>> {
    let mut parent: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    fn find(parent: &mut std::collections::HashMap<String, String>, key: &str) -> String {
        let mut root = key.to_string();
        while parent.get(&root).is_some_and(|up| *up != root) {
            root = parent[&root].clone();
        }
        parent.insert(key.to_string(), root.clone());
        root
    }
    let mut union = |a: &str, b: &str| {
        for key in [a, b] {
            parent
                .entry(key.to_string())
                .or_insert_with(|| key.to_string());
        }
        let ra = find(&mut parent, a);
        let rb = find(&mut parent, b);
        if ra != rb {
            parent.insert(ra, rb);
        }
    };
    for record in records {
        let file = format!("file:{}", record.alias);
        union(
            &file,
            &format!("cli:{}", session_key(record.cli_session_id(), &record.obj)),
        );
        if let Some(priors) = record
            .obj
            .get("priorCliSessionIds")
            .and_then(Value::as_array)
        {
            for prior in priors
                .iter()
                .filter_map(Value::as_str)
                .filter(|p| is_uuid(p))
            {
                union(&file, &format!("cli:{}", session_key(prior, &record.obj)));
            }
        }
    }
    let mut groups: indexmap::IndexMap<String, Vec<usize>> = indexmap::IndexMap::new();
    for (index, record) in records.iter().enumerate() {
        let key = find(&mut parent, &format!("file:{}", record.alias));
        groups.entry(key).or_default().push(index);
    }
    groups.into_values().collect()
}

/// Auto mode turned into Manual by Claude rather than by the user: Claude records Manual where
/// auto mode is unavailable while keeping `autoChosenInApp`; choosing Manual sets it false.
pub fn forced_manual(obj: &JsonObject) -> bool {
    obj.get("permissionMode").and_then(Value::as_str) == Some("default")
        && obj.get("autoChosenInApp") == Some(&Value::Bool(true))
}

/// The most recently active record is the live conversation; ties prefer the target.
fn newest<'a>(records: &[&'a SessionRecord]) -> &'a SessionRecord {
    let own_alias = |r: &SessionRecord| r.alias == r.cli_session_id().to_lowercase();
    let mut sorted = records.to_vec();
    sorted.sort_by(|a, b| {
        b.last_activity_at()
            .partial_cmp(&a.last_activity_at())
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(b.is_target.cmp(&a.is_target))
            .then(own_alias(b).cmp(&own_alias(a)))
            .then(a.alias.cmp(&b.alias))
    });
    sorted[0]
}

static DELETED_NAME: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
    regex::Regex::new(r"(?i)^deleted_([a-f0-9-]{36})(?:\.json)?$").unwrap()
});
static LOCAL_NAME: std::sync::LazyLock<regex::Regex> =
    std::sync::LazyLock::new(|| regex::Regex::new(r"(?i)^local_([a-f0-9-]{36})\.json$").unwrap());

fn read_sessions(
    root: &Path,
    scope: &Scope,
    is_target: bool,
) -> Result<(Vec<SessionRecord>, Vec<String>), DesktopFileError> {
    let relative = scope_path("claude-code-sessions", scope)?;
    let mut records = Vec::new();
    let mut deleted = Vec::new();
    let names: Vec<String> = match fs::read_dir(safe_file(root, &relative)?) {
        Ok(entries) => entries
            .map(|entry| entry.map(|e| e.file_name().to_string_lossy().into_owned()))
            .collect::<io::Result<_>>()?,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok((records, deleted)),
        Err(e) => return Err(e.into()),
    };
    for name in names {
        if let Some(deletion) = DELETED_NAME.captures(&name) {
            deleted.push(deletion[1].to_lowercase());
        }
        let Some(local) = LOCAL_NAME.captures(&name) else {
            continue;
        };
        // A record Desktop is rewriting, or a format Relay does not understand, is left exactly
        // as it is: it must not block switching for every other one.
        let Ok(Some(obj)) = read_object(root, &format!("{relative}/{name}")) else {
            continue;
        };
        if !obj
            .get("cliSessionId")
            .and_then(Value::as_str)
            .is_some_and(is_uuid)
            || !usable_cwd(&obj)
            || finite(obj.get("lastActivityAt")).is_none()
        {
            continue;
        }
        records.push(SessionRecord {
            alias: local[1].to_lowercase(),
            name,
            obj,
            scope: scope.clone(),
            is_target,
        });
    }
    Ok((records, deleted))
}

/// Read-only duplicate report for one account's Code index (same conversation, several cards).
pub fn duplicate_sessions(
    root: &Path,
    scope: &Scope,
) -> Result<Vec<Vec<String>>, DesktopFileError> {
    let (records, _) = read_sessions(root, scope, true)?;
    Ok(group_sessions(&records)
        .into_iter()
        .filter(|group| group.len() > 1)
        .map(|group| {
            let mut names: Vec<String> = group.iter().map(|&i| records[i].name.clone()).collect();
            names.sort();
            names
        })
        .collect())
}

/// Where Claude keeps its per-account choices, among them the permission modes below.
pub const DESKTOP_PREFERENCES: &str = "claude_desktop_config.json";
const MODES: [&str; 4] = ["default", "acceptEdits", "plan", "auto"];
/// The mode a new Code conversation starts in, per account.
const NEW_CHAT_MODE: &str = "cc-landing-draft-permission-mode";
/// The mode each folder's new conversations start in, per account: `{ [folder]: mode }`.
const FOLDER_MODES: &str = "epitaxy-folder-permission-mode-v2";

fn is_mode(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|mode| MODES.contains(&mode))
}

/// Claude keeps the permission mode for new conversations, overall and per folder, under each
/// account's id. Fills what `to` has not chosen with the choices of `from`, the account being
/// left; what `to` chose stays, and Bypass never travels. The whole new file, or None when
/// nothing changes.
pub fn plan_permission_preferences(
    config: Option<&JsonObject>,
    from: &str,
    to: &str,
) -> Result<Option<JsonObject>, DesktopFileError> {
    let Some(config) = config else {
        return Ok(None);
    };
    let Some(prefs) = config
        .get("preferences")
        .and_then(|p| p.get("epitaxyPrefs"))
        .and_then(Value::as_object)
    else {
        return Ok(None);
    };
    if from == to {
        return Ok(None);
    }
    if !is_uuid(from) || !is_uuid(to) {
        return Err(DesktopFileError::InvalidUuid);
    }
    let mut next = prefs.clone();
    let mut changed = false;
    let new_to = format!("{NEW_CHAT_MODE}.{to}");
    let mode = prefs.get(&format!("{NEW_CHAT_MODE}.{from}"));
    if is_mode(mode) && !prefs.contains_key(&new_to) {
        next.insert(new_to, mode.cloned().unwrap_or(Value::Null));
        changed = true;
    }
    let folders_to = format!("{FOLDER_MODES}.{to}");
    let folders = prefs.get(&format!("{FOLDER_MODES}.{from}"));
    let own = prefs.get(&folders_to);
    if let Some(folders) = folders.and_then(Value::as_object)
        && (own.is_none() || own.is_some_and(Value::is_object))
    {
        let mut merged = own.and_then(Value::as_object).cloned().unwrap_or_default();
        let before = merged.len();
        for (folder, value) in folders {
            if is_mode(Some(value)) && !merged.contains_key(folder) {
                merged.insert(folder.clone(), value.clone());
            }
        }
        if merged.len() > before {
            next.insert(folders_to, Value::Object(merged));
            changed = true;
        }
    }
    if !changed {
        return Ok(None);
    }
    let mut preferences = config
        .get("preferences")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    preferences.insert("epitaxyPrefs".into(), Value::Object(next));
    let mut out = config.clone();
    out.insert("preferences".into(), Value::Object(preferences));
    Ok(Some(out))
}

/// Claude's split view under `preferences.epitaxyPrefs`: the Code session in front
/// (`state.lastPrimaryCodeSession`) and those beside it (`state.extraPanesByMode[mode]`, each
/// `{ref: {kind, id}, pos}`), any number of them. The page empties it the first time it starts on
/// another account and keeps it when it starts again on the same one (seen 2026-11-28).
pub const PANE_STORE: &str = "desktop-frame.paneStore.v1";

fn pane_store(config: Option<&JsonObject>) -> Option<&Value> {
    config?
        .get("preferences")?
        .get("epitaxyPrefs")?
        .get(PANE_STORE)
}

fn pane_ref_id(item: &Value) -> Option<&str> {
    let reference = item.get("ref")?;
    (reference.get("kind")?.as_str()? == "code")
        .then(|| reference.get("id")?.as_str())
        .flatten()
}

/// The split view `config` shows, when it shows any Code session; the value as Claude stored it.
pub fn pane_layout(config: Option<&JsonObject>) -> Option<Value> {
    let store = pane_store(config)?;
    let state = store.get("state")?;
    let primary = state
        .get("lastPrimaryCodeSession")
        .and_then(|p| p.get("id"))
        .and_then(Value::as_str)
        .is_some();
    let beside = state
        .get("extraPanesByMode")
        .and_then(Value::as_object)
        .is_some_and(|modes| {
            modes
                .values()
                .any(|panes| panes.as_array().is_some_and(|p| !p.is_empty()))
        });
    (primary || beside).then(|| store.clone())
}

/// `config` with the split view `layout` written back, after Claude emptied it on starting under
/// another account. Only the sessions `has_session` finds (the account switched to has them)
/// stay; the one in front must be among them, or nothing is written. None as well when `config`
/// already shows a split view, or holds no preferences to write into.
pub fn plan_pane_layout(
    config: Option<&JsonObject>,
    layout: &Value,
    has_session: &dyn Fn(&str) -> bool,
) -> Option<JsonObject> {
    let config = config?;
    if pane_layout(Some(config)).is_some() {
        return None;
    }
    let prefs = config
        .get("preferences")?
        .get("epitaxyPrefs")?
        .as_object()?;
    let mut layout = layout.clone();
    let state = layout.get_mut("state")?.as_object_mut()?;
    let primary = state
        .get("lastPrimaryCodeSession")
        .and_then(|p| p.get("id"))
        .and_then(Value::as_str)?;
    if !has_session(primary) {
        return None;
    }
    if let Some(modes) = state
        .get_mut("extraPanesByMode")
        .and_then(Value::as_object_mut)
    {
        for panes in modes.values_mut() {
            if let Some(panes) = panes.as_array_mut() {
                panes.retain(|pane| pane_ref_id(pane).is_some_and(has_session));
            }
        }
    }
    let mut prefs = prefs.clone();
    prefs.insert(PANE_STORE.into(), layout);
    let mut preferences = config.get("preferences")?.as_object()?.clone();
    preferences.insert("epitaxyPrefs".into(), Value::Object(prefs));
    let mut out = config.clone();
    out.insert("preferences".into(), Value::Object(preferences));
    Some(out)
}

/// The Code sessions a split view shows: the one in front first, then those beside it.
pub fn pane_layout_sessions(layout: &Value) -> Vec<String> {
    let Some(state) = layout.get("state") else {
        return Vec::new();
    };
    let mut ids: Vec<String> = state
        .get("lastPrimaryCodeSession")
        .and_then(|p| p.get("id"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .into_iter()
        .collect();
    if let Some(modes) = state.get("extraPanesByMode").and_then(Value::as_object) {
        for panes in modes.values().filter_map(Value::as_array) {
            ids.extend(panes.iter().filter_map(pane_ref_id).map(str::to_owned));
        }
    }
    ids
}

/// Sessions in another Claude data folder (a separate window's), read as sources even under the
/// target's own scope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutsideSource {
    pub root: PathBuf,
    pub scope: Scope,
}

/// What a history plan is told besides its scopes.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HistoryPlanOptions {
    pub seen_space_ids: Option<Vec<String>>,
    pub outside: Vec<OutsideSource>,
}

/// The writes of a history merge and the conversations it carries.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HistoryPlan {
    pub writes: Writes,
    pub conversations: Vec<CarriedConversation>,
}

/// Only Code records travel: local ones and those Claude runs over SSH. Remote connectors,
/// permission grants, browser access and server-owned project bindings must be established by
/// the destination account.
pub fn plan_history(
    root: &Path,
    target: &Scope,
    sources: &[Scope],
    options: &HistoryPlanOptions,
) -> Result<Writes, DesktopFileError> {
    Ok(plan_history_detailed(root, target, sources, options)?.writes)
}

/// `plan_history`, plus the conversations the merge carries and the alias each ends with.
pub fn plan_history_detailed(
    root: &Path,
    target: &Scope,
    sources: &[Scope],
    options: &HistoryPlanOptions,
) -> Result<HistoryPlan, DesktopFileError> {
    let mut writes = Writes::new();
    let mut conversations = Vec::new();
    let target_dir = scope_path("claude-code-sessions", target)?;
    let mut deleted = std::collections::HashSet::new();
    let mut all = Vec::new();
    let (records, gone) = read_sessions(root, target, true)?;
    all.extend(records);
    deleted.extend(gone);
    for source in sources {
        if source.account_uuid == target.account_uuid && source.org_id == target.org_id {
            continue;
        }
        let (records, gone) = read_sessions(root, source, false)?;
        all.extend(records);
        deleted.extend(gone);
    }
    for source in &options.outside {
        let (records, gone) = read_sessions(&source.root, &source.scope, false)?;
        all.extend(records);
        deleted.extend(gone);
    }
    for group in group_sessions(&all) {
        let group: Vec<&SessionRecord> = group.iter().map(|&i| &all[i]).collect();
        // A conversation deleted under any of its aliases stays deleted.
        if group.iter().any(|record| deleted.contains(&record.alias)) {
            continue;
        }
        let winner = newest(&group);
        conversations.push(CarriedConversation {
            target_alias: winner.alias.clone(),
            members: group
                .iter()
                .map(|record| CarriedMember {
                    alias: record.alias.clone(),
                    account_uuid: record.scope.account_uuid.clone(),
                })
                .collect(),
        });
        let existing: Vec<&SessionRecord> = group.iter().copied().filter(|r| r.is_target).collect();
        let keep = existing.iter().copied().find(|r| r.alias == winner.alias);
        // Every other destination card of the same conversation goes.
        for record in &existing {
            if keep.is_none_or(|keep| !std::ptr::eq(keep, *record)) {
                writes.insert(format!("{target_dir}/{}", record.name), None);
            }
        }
        if winner.is_target {
            continue;
        }
        let relative = format!("{target_dir}/{}", keep.map_or(&winner.name, |k| &k.name));
        // Destination choices come from its record of this alias, otherwise from its most
        // recent card of the same conversation that is being replaced.
        let own = keep
            .or_else(|| (!existing.is_empty()).then(|| newest(&existing)))
            .map(|r| &r.obj);
        let mut obj = winner.obj.clone();
        let fallbacks: [(&str, Value); 8] = [
            ("remoteMcpServersConfig", Value::Array(Vec::new())),
            ("enabledMcpTools", Value::Object(Map::new())),
            ("bridgeSessionIds", Value::Array(Vec::new())),
            ("sessionPermissionUpdates", Value::Array(Vec::new())),
            ("alwaysAllowedReasons", Value::Array(Vec::new())),
            ("chromePermissionMode", Value::String("always_ask".into())),
            ("bypassChosenInApp", Value::Bool(false)),
            ("remoteControlAutoEligible", Value::Bool(false)),
        ];
        for (key, fallback) in fallbacks {
            let value = own
                .and_then(|own| own.get(key))
                .filter(|v| !v.is_null())
                .cloned()
                .unwrap_or(fallback);
            obj.insert(key.into(), value);
        }
        // The conversation keeps its mode on the other account; Bypass is account-local.
        if forced_manual(&obj) {
            obj.insert("permissionMode".into(), Value::String("auto".into()));
        }
        let mode = obj.get("permissionMode");
        if !mode.is_some_and(Value::is_string)
            || mode.and_then(Value::as_str) == Some("bypassPermissions")
        {
            let own_mode = own.and_then(|own| own.get("permissionMode"));
            let value = match own_mode {
                Some(m) if js_truthy(m) && m.as_str() != Some("bypassPermissions") => m.clone(),
                _ => Value::String("default".into()),
            };
            obj.insert("permissionMode".into(), value);
        }
        // Context can include account-specific instructions; regenerate it in Claude.
        for key in [
            "promptAppendSnapshot",
            "pendingSystemReminder",
            "steeredByRemoteClient",
            "error",
            "errorAt",
            "priorErrorMark",
        ] {
            obj.shift_remove(key);
        }
        // Archive/pin/focus choices are local to the destination.
        if let Some(own) = own {
            for key in [
                "archived",
                "isArchived",
                "archivedAt",
                "pinned",
                "isPinned",
                "lastFocusedAt",
            ] {
                if let Some(value) = own.get(key) {
                    obj.insert(key.into(), value.clone());
                }
            }
        }
        writes.insert(relative, Some(json_bytes(&obj)));
    }
    let target_spaces = format!(
        "{}/spaces.json",
        scope_path("local-agent-mode-sessions", target)?
    );
    let own = read_object(root, &target_spaces)?;
    let mut spaces: Vec<Value> = match &own {
        Some(own) => own
            .get("spaces")
            .and_then(Value::as_array)
            .cloned()
            .ok_or(DesktopFileError::UnrecognizedProjectFormat)?,
        None => Vec::new(),
    };
    if !spaces.iter().all(valid_space) {
        return Err(DesktopFileError::UnrecognizedProjectRecord);
    }
    let space_id = |space: &Value| space["id"].as_str().unwrap_or("").to_string();
    let mut positions: std::collections::HashMap<String, usize> = spaces
        .iter()
        .enumerate()
        .map(|(index, space)| (space_id(space), index))
        .collect();
    let seen: std::collections::HashSet<&String> =
        options.seen_space_ids.iter().flatten().collect();
    let updated_at = |space: &Value| finite(space.get("updatedAt")).unwrap_or(0.0);
    let mut changed = false;
    for source in sources {
        let obj = read_object(
            root,
            &format!(
                "{}/spaces.json",
                scope_path("local-agent-mode-sessions", source)?
            ),
        )?;
        let list = match &obj {
            Some(obj) => obj
                .get("spaces")
                .and_then(Value::as_array)
                .ok_or(DesktopFileError::UnrecognizedProjectFormat)?
                .clone(),
            None => Vec::new(),
        };
        for space in list {
            if !valid_space(&space) {
                return Err(DesktopFileError::UnrecognizedProjectRecord);
            }
            let id = space_id(&space);
            let position = positions.get(&id).copied();
            if position.is_some_and(|p| updated_at(&space) <= updated_at(&spaces[p]))
                || (position.is_none() && seen.contains(&id))
            {
                continue;
            }
            // Refresh local project changes while keeping the destination's own server
            // bindings. A missing previously seen project stays deleted.
            let mut copy = space.as_object().cloned().unwrap_or_default();
            copy.shift_remove("projects");
            copy.shift_remove("migration");
            match position {
                Some(p) => {
                    for key in ["projects", "migration"] {
                        if let Some(value) = spaces[p].get(key) {
                            copy.insert(key.into(), value.clone());
                        }
                    }
                    spaces[p] = Value::Object(copy);
                }
                None => {
                    positions.insert(id, spaces.len());
                    spaces.push(Value::Object(copy));
                }
            }
            changed = true;
        }
    }
    if changed {
        let mut file = own.unwrap_or_default();
        file.insert("spaces".into(), Value::Array(spaces));
        writes.insert(target_spaces, Some(json_bytes(&file)));
    }
    Ok(HistoryPlan {
        writes,
        conversations,
    })
}

fn valid_space(space: &Value) -> bool {
    let Some(space) = space.as_object() else {
        return false;
    };
    space
        .get("id")
        .and_then(Value::as_str)
        .is_some_and(|id| !id.is_empty() && id.encode_utf16().count() <= 2048)
        && space.get("name").is_some_and(Value::is_string)
}

/// JavaScript truthiness of a JSON value.
pub fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}
