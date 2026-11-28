//! Port of electron/core/proxy-clients.ts: points Claude Code, Codex and omp at the gateway by
//! writing their own settings, and takes it back.
//!
//! Claude Code: `env.ANTHROPIC_BASE_URL` and `env.ANTHROPIC_AUTH_TOKEN` in ~/.claude/settings.json;
//! the values there before are kept in Relay's settings and put back on unbind. Two more env
//! values are added only when the user has not set them (`CLAUDE_EXTRAS`). Codex: a provider
//! table and a top-level `model_provider` in ~/.codex/config.toml, each between Relay's marker
//! lines; an existing top-level `model_provider` is commented out with Relay's prefix and
//! restored on unbind. omp: its own `anthropic` and `openai-codex` providers in
//! ~/.omp/agent/models.yml get the gateway's address and key, between Relay's marker lines
//! (relay_gateway::omp_models); a file Relay created is removed again on unbind.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use relay_core::shared::proxy_types::{ClientBindings, ProxyClientId};
use relay_core::shared::proxy_url::is_tailscale_ipv4;
use relay_core::shared::types::js::JsMap;
use relay_gateway::omp_models::{
    OmpBlock, OmpTarget, omp_agent_dir, omp_blocked, omp_bound, omp_bound_to, omp_legacy_json,
    omp_marked, omp_models_file, omp_relay_only, omp_unbound,
};
use serde_json::{Map, Value, json};

/// What Relay keeps for a bound client: the values it replaced (`null`: there was none).
pub type SavedValues = JsMap<Option<String>>;

pub const PROXY_CLIENTS: [ProxyClientId; 3] = [
    ProxyClientId::ClaudeCode,
    ProxyClientId::Codex,
    ProxyClientId::Omp,
];

const CLAUDE_KEYS: [&str; 2] = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"];
/// Behind a gateway key Claude Code counts itself an API-key session and caches the
/// conversation for 5 minutes, not the subscription's hour; the hint headers name each
/// request's class for the gateway. A value the user set is theirs and stays; one Relay added
/// is removed on unbind.
pub const CLAUDE_EXTRAS: [(&str, &str); 2] = [
    ("CLAUDE_CODE_PROMPT_CACHE_TTL", "1h"),
    ("CLAUDE_CODE_GATEWAY_HINT_HEADERS", "1"),
];
const TOP_START: &str = "# >>> relay gateway (written by Relay; remove it from Relay's Proxy page)";
const TOP_END: &str = "# <<< relay gateway";
const TABLE_START: &str = "# >>> relay gateway provider";
const TABLE_END: &str = "# <<< relay gateway provider";
const DISABLED_PREFIX: &str = "# relay-disabled: ";

/// Where a client dials the gateway (without /v1) and the key it sends.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClientTarget {
    pub url: String,
    pub key: String,
}

/// `os.homedir()`.
pub fn home() -> PathBuf {
    relay_core::relay_paths::home_dir()
}

fn claude_dir(home: &Path) -> PathBuf {
    home.join(".claude")
}

fn claude_file(home: &Path) -> PathBuf {
    claude_dir(home).join("settings.json")
}

fn codex_dir(home: &Path) -> PathBuf {
    home.join(".codex")
}

fn codex_file(home: &Path) -> PathBuf {
    codex_dir(home).join("config.toml")
}

pub fn client_file(id: ProxyClientId, home: &Path) -> PathBuf {
    match id {
        ProxyClientId::ClaudeCode => claude_file(home),
        ProxyClientId::Omp => omp_models_file(home),
        ProxyClientId::Codex => codex_file(home),
    }
}

fn client_dir(id: ProxyClientId, home: &Path) -> PathBuf {
    match id {
        ProxyClientId::ClaudeCode => claude_dir(home),
        ProxyClientId::Omp => omp_agent_dir(home),
        ProxyClientId::Codex => codex_dir(home),
    }
}

/// The file's text; `None` when it is not there.
fn read_text(file: &Path) -> io::Result<Option<String>> {
    match fs::read(file) {
        Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

/// Writes through a temporary file, so a crash never leaves half a settings file. Every file
/// written here holds the gateway key, or held it and may hold the user's own token put back:
/// owner-only (0600) whatever mode it had, set again after the write since the umask may
/// narrow it.
fn write_atomic(file: &Path, text: &str) -> io::Result<()> {
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir)?;
    }
    let temp = PathBuf::from(format!(
        "{}.relay-{}-{}.tmp",
        file.display(),
        std::process::id(),
        relay_core::clock::now_ms()
    ));
    super::write_private(&temp, text.as_bytes())?;
    fs::rename(&temp, file)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(file, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

/// A parsed JSON value as `JSON.stringify` writes it back: whole floats without `.0` and
/// array-index keys first, ascending, as a plain object lists them.
fn js_json(value: &Value) -> Value {
    match value {
        Value::Number(number) if !number.is_i64() && !number.is_u64() => match number.as_f64() {
            Some(v) if v.fract() == 0.0 && v.abs() < 9.007_199_254_740_992e15 => {
                Value::from(v as i64)
            }
            _ => value.clone(),
        },
        Value::Array(items) => Value::Array(items.iter().map(js_json).collect()),
        Value::Object(map) => {
            let index = |key: &str| -> Option<u32> {
                if key.is_empty()
                    || (key.len() > 1 && key.starts_with('0'))
                    || !key.bytes().all(|b| b.is_ascii_digit())
                {
                    return None;
                }
                key.parse::<u32>().ok().filter(|n| *n != u32::MAX)
            };
            let mut indexed: Vec<(u32, &String, &Value)> = map
                .iter()
                .filter_map(|(key, value)| index(key).map(|i| (i, key, value)))
                .collect();
            indexed.sort_by_key(|(i, _, _)| *i);
            let mut out = Map::new();
            for (_, key, value) in indexed {
                out.insert(key.clone(), js_json(value));
            }
            for (key, value) in map.iter().filter(|(key, _)| index(key).is_none()) {
                out.insert(key.clone(), js_json(value));
            }
            Value::Object(out)
        }
        _ => value.clone(),
    }
}

/// `JSON.stringify(value, null, 2)` plus the newline the TS adds.
fn pretty(value: Map<String, Value>) -> String {
    let text = serde_json::to_string_pretty(&js_json(&Value::Object(value))).unwrap_or_default();
    format!("{text}\n")
}

fn read_claude_settings(home: &Path) -> Result<Map<String, Value>, String> {
    let Some(text) = read_text(&claude_file(home)).map_err(|e| e.to_string())? else {
        return Ok(Map::new());
    };
    if text.trim().is_empty() {
        return Ok(Map::new());
    }
    match serde_json::from_str::<Value>(&text).map_err(|e| e.to_string())? {
        Value::Object(map) => Ok(map),
        _ => Err("settings.json is not an object".into()),
    }
}

fn env_of(settings: &Map<String, Value>) -> Map<String, Value> {
    match settings.get("env") {
        Some(Value::Object(env)) => env.clone(),
        _ => Map::new(),
    }
}

fn lines_of(text: &str) -> impl Iterator<Item = &str> {
    text.split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
}

/// Lines outside Relay's own marker blocks, with the blocks removed.
fn without_relay_blocks(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut inside = false;
    for line in lines_of(text) {
        if line == TOP_START || line == TABLE_START {
            inside = true;
        } else if line == TOP_END || line == TABLE_END {
            inside = false;
        } else if !inside {
            out.push(line.to_string());
        }
    }
    out
}

fn toml_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

/// `^<name>\s*=\s*"((?:[^"\\]|\\.)*)"` on one line: the quoted value, unescaped as JSON.
fn quoted_value(line: &str, name: &str) -> Option<String> {
    let rest = line.strip_prefix(name)?.trim_start();
    let rest = rest.strip_prefix('=')?.trim_start();
    let rest = rest.strip_prefix('"')?;
    let mut escaped = false;
    for (at, c) in rest.char_indices() {
        if escaped {
            escaped = false;
        } else if c == '\\' {
            escaped = true;
        } else if c == '"' {
            return serde_json::from_str(&format!("\"{}\"", &rest[..at])).ok();
        }
    }
    None
}

/// The values a Relay table in config.toml holds: base_url and the bearer token.
fn codex_relay_values(text: &str) -> (Option<String>, Option<String>) {
    let (Some(start), Some(end)) = (text.find(TABLE_START), text.find(TABLE_END)) else {
        return (None, None);
    };
    if end < start {
        return (None, None);
    }
    let block = &text[start..end];
    let value = |name: &str| lines_of(block).find_map(|line| quoted_value(line, name));
    let url =
        value("base_url").map(|url| url.strip_suffix("/v1").map_or(url.clone(), str::to_string));
    (url, value("experimental_bearer_token"))
}

/// Index of the first table header: top-level keys must come before it.
fn first_table(lines: &[String]) -> usize {
    lines
        .iter()
        .position(|line| line.trim_start().starts_with('['))
        .unwrap_or(lines.len())
}

fn status(
    id: ProxyClientId,
    installed: bool,
    file: &Path,
    bound: bool,
    stale: bool,
    blocked: Option<&str>,
) -> Value {
    let mut out = json!({
        "id": id.as_str(),
        "installed": installed,
        "file": file.to_string_lossy(),
        "bound": bound,
        "stale": stale,
    });
    if let (Some(blocked), Value::Object(map)) = (blocked, &mut out) {
        map.insert("blocked".into(), json!(blocked));
    }
    out
}

/// Where each client stands against the gateway now (`ProxyClientStatus[]`).
pub fn client_statuses(
    target: Option<&ClientTarget>,
    bindings: Option<&ClientBindings>,
    home: &Path,
) -> Vec<Value> {
    PROXY_CLIENTS
        .iter()
        .map(|&id| {
            let file = client_file(id, home);
            let installed = client_dir(id, home).exists();
            let relay_bound = bindings.is_some_and(|b| b.contains_key(&id));
            let read = || -> Result<Value, String> {
                match id {
                    ProxyClientId::ClaudeCode => {
                        let env = env_of(&read_claude_settings(home)?);
                        let url = env.get("ANTHROPIC_BASE_URL").and_then(Value::as_str);
                        let key = env.get("ANTHROPIC_AUTH_TOKEN").and_then(Value::as_str);
                        // A binding written before Relay added the extras is out of date until
                        // written again.
                        let current = CLAUDE_EXTRAS
                            .iter()
                            .all(|(name, _)| env.get(*name).is_some_and(Value::is_string));
                        let bound = target.is_some_and(|t| {
                            url == Some(t.url.as_str()) && key == Some(t.key.as_str())
                        }) && current;
                        Ok(status(
                            id,
                            installed,
                            &file,
                            bound,
                            relay_bound && !bound,
                            None,
                        ))
                    }
                    ProxyClientId::Omp => {
                        let text = read_text(&file)
                            .map_err(|e| e.to_string())?
                            .unwrap_or_default();
                        let bound = target.is_some_and(|t| {
                            omp_bound_to(
                                &text,
                                &OmpTarget {
                                    url: t.url.clone(),
                                    key: t.key.clone(),
                                },
                            )
                        });
                        let stale = (relay_bound || omp_marked(&text)) && !bound;
                        // Also while bound: an edit since can leave a file omp cannot read. A
                        // binding that cannot be written again can still be taken away.
                        let blocked = if omp_legacy_json(home) {
                            Some(OmpBlock::LegacyJson)
                        } else {
                            omp_blocked(&text)
                        };
                        Ok(status(
                            id,
                            installed,
                            &file,
                            bound,
                            stale,
                            blocked.map(OmpBlock::as_str),
                        ))
                    }
                    ProxyClientId::Codex => {
                        let text = read_text(&file)
                            .map_err(|e| e.to_string())?
                            .unwrap_or_default();
                        let (url, key) = codex_relay_values(&text);
                        let marked = text.contains(TABLE_START);
                        let bound = target.is_some_and(|t| {
                            marked
                                && url.as_deref() == Some(t.url.as_str())
                                && key.as_deref() == Some(t.key.as_str())
                        });
                        Ok(status(
                            id,
                            installed,
                            &file,
                            bound,
                            (relay_bound || marked) && !bound,
                            None,
                        ))
                    }
                }
            };
            read().unwrap_or_else(|_| {
                let blocked = if id == ProxyClientId::ClaudeCode {
                    "unreadable-settings"
                } else {
                    "unreadable-config"
                };
                status(id, installed, &file, false, false, Some(blocked))
            })
        })
        .collect()
}

/// A value only Relay writes: the gateway's own address or a Relay client key.
fn is_relay_value(name: &str, value: &str, target: &ClientTarget) -> bool {
    match name {
        "ANTHROPIC_AUTH_TOKEN" => value == target.key || value.starts_with("relay-sec-"),
        "ANTHROPIC_BASE_URL" => value == target.url,
        _ => false,
    }
}

/// Points the client at the gateway. Returns what to keep in `clientBindings` for it: the
/// values replaced, so unbinding can restore them. A rebind keeps the first saved values.
pub fn bind_client(
    id: ProxyClientId,
    target: &ClientTarget,
    previous: Option<&SavedValues>,
    home: &Path,
) -> Result<SavedValues, String> {
    match id {
        ProxyClientId::ClaudeCode => {
            let file = claude_file(home);
            let text = read_text(&file).map_err(|e| e.to_string())?;
            let mut settings = read_claude_settings(home)?;
            let mut env = env_of(&settings);
            let mut saved = previous.cloned().unwrap_or_default();
            let mut written = vec![
                ("ANTHROPIC_BASE_URL", target.url.clone()),
                ("ANTHROPIC_AUTH_TOKEN", target.key.clone()),
            ];
            for name in CLAUDE_KEYS {
                if saved.contains_key(name) {
                    continue;
                }
                let value = env.get(name).and_then(Value::as_str).map(str::to_string);
                // A file Relay left bound (it quit without restoring) holds Relay's own value:
                // not the user's.
                let kept = value.filter(|v| !is_relay_value(name, v, target));
                saved.insert(name, kept);
            }
            // Written only where there is no value: one the user set, before or since, stays.
            for (name, value) in CLAUDE_EXTRAS {
                if env.get(name).is_some_and(Value::is_string) {
                    continue;
                }
                if saved.get(name).is_none_or(Option::is_none) {
                    saved.insert(name, None);
                    written.push((name, value.to_string()));
                }
            }
            for (name, value) in written {
                env.insert(name.to_string(), Value::String(value));
            }
            settings.insert("env".into(), Value::Object(env));
            let next = pretty(settings);
            if text.as_deref() != Some(next.as_str()) {
                write_atomic(&file, &next).map_err(|e| e.to_string())?;
            }
            Ok(saved)
        }
        ProxyClientId::Omp => {
            if omp_legacy_json(home) {
                return Err("omp has not moved its models.json to models.yml yet".into());
            }
            let file = omp_target(home);
            let text = read_text(&file).map_err(|e| e.to_string())?;
            if let Some(blocked) = omp_blocked(text.as_deref().unwrap_or("")) {
                let name = file
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                return Err(format!(
                    "Relay cannot add its providers to omp's {name} ({})",
                    blocked.as_str()
                ));
            }
            // Read again at every bind (a start rebinds too): a file that is not there, or
            // holds only Relay's block, is Relay's, and unbinding removes it. A file of the
            // user's stays.
            let created = match text.as_deref() {
                None => Some("1".to_string()),
                Some(text) if omp_relay_only(text) => Some("1".to_string()),
                Some(_) => None,
            };
            let next = omp_bound(
                text.as_deref().unwrap_or(""),
                &OmpTarget {
                    url: target.url.clone(),
                    key: target.key.clone(),
                },
            );
            if text.as_deref() != Some(next.as_str()) {
                write_atomic(&file, &next).map_err(|e| e.to_string())?;
            }
            let mut saved = previous.cloned().unwrap_or_default();
            saved.insert("created", created);
            Ok(saved)
        }
        ProxyClientId::Codex => {
            let file = codex_file(home);
            let text = read_text(&file).map_err(|e| e.to_string())?;
            let mut lines = without_relay_blocks(text.as_deref().unwrap_or(""));
            let top = first_table(&lines);
            // Another provider chosen at the top level would clash with Relay's: it waits,
            // commented out.
            for line in lines.iter_mut().take(top) {
                let rest = line.trim_start();
                if rest
                    .strip_prefix("model_provider")
                    .is_some_and(|r| r.trim_start().starts_with('='))
                {
                    *line = format!("{DISABLED_PREFIX}{line}");
                }
            }
            while lines.last().is_some_and(|l| l.trim().is_empty()) {
                lines.pop();
            }
            let mut out: Vec<String> = vec![
                TOP_START.into(),
                "model_provider = \"relay\"".into(),
                TOP_END.into(),
            ];
            out.extend(lines);
            out.extend([
                String::new(),
                TABLE_START.into(),
                "[model_providers.relay]".into(),
                "name = \"Relay\"".into(),
                format!("base_url = {}", toml_string(&format!("{}/v1", target.url))),
                "wire_api = \"responses\"".into(),
                format!("experimental_bearer_token = {}", toml_string(&target.key)),
                TABLE_END.into(),
                String::new(),
            ]);
            write_atomic(&file, &out.join("\n")).map_err(|e| e.to_string())?;
            Ok(previous.cloned().unwrap_or_default())
        }
    }
}

/// Takes the gateway out of the client's settings and puts back what was there.
pub fn unbind_client(
    id: ProxyClientId,
    previous: Option<&SavedValues>,
    home: &Path,
) -> Result<(), String> {
    match id {
        ProxyClientId::ClaudeCode => {
            let file = claude_file(home);
            if !file.exists() {
                return Ok(());
            }
            let next = claude_unbound(home, previous)?;
            write_atomic(&file, &next).map_err(|e| e.to_string())
        }
        ProxyClientId::Omp => {
            let file = omp_target(home);
            let Some(text) = read_text(&file).map_err(|e| e.to_string())? else {
                return Ok(());
            };
            if omp_removable(&text, previous) {
                match fs::remove_file(&file) {
                    Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error.to_string()),
                    _ => Ok(()),
                }
            } else {
                let next = omp_unbound(&text);
                if next != text {
                    write_atomic(&file, &next).map_err(|e| e.to_string())?;
                }
                Ok(())
            }
        }
        ProxyClientId::Codex => {
            let file = codex_file(home);
            let Some(text) = read_text(&file).map_err(|e| e.to_string())? else {
                return Ok(());
            };
            write_atomic(&file, &codex_unbound(&text)).map_err(|e| e.to_string())
        }
    }
}

/// config.toml without Relay's blocks, with a provider line Relay parked put back.
fn codex_unbound(text: &str) -> String {
    let mut lines: Vec<String> = without_relay_blocks(text)
        .into_iter()
        .map(|line| match line.strip_prefix(DISABLED_PREFIX) {
            Some(rest) => rest.to_string(),
            None => line,
        })
        .collect();
    while lines.last().is_some_and(|l| l.trim().is_empty()) {
        lines.pop();
    }
    if lines.is_empty() {
        String::new()
    } else {
        format!("{}\n", lines.join("\n"))
    }
}

/// The file to write for omp: where a symlinked models.yml points (dotfiles setups), so
/// writing through a temporary file keeps the link instead of replacing it with a copy.
fn omp_target(home: &Path) -> PathBuf {
    let file = omp_models_file(home);
    fs::canonicalize(&file).unwrap_or(file)
}

/// Whether unbinding removes omp's file: it holds only Relay's block, and Relay did not find
/// it there as the user's own (empty) file. A binding with nothing saved counts as Relay's.
fn omp_removable(text: &str, previous: Option<&SavedValues>) -> bool {
    omp_relay_only(text) && !matches!(previous.and_then(|p| p.get("created")), Some(None))
}

/// settings.json with the gateway taken out and what was there before put back.
fn claude_unbound(home: &Path, previous: Option<&SavedValues>) -> Result<String, String> {
    let mut settings = read_claude_settings(home)?;
    let mut env = env_of(&settings);
    for name in CLAUDE_KEYS {
        match previous.and_then(|p| p.get(name)) {
            Some(Some(value)) => {
                env.insert(name.into(), Value::String(value.clone()));
            }
            _ => {
                env.shift_remove(name);
            }
        }
    }
    // An extra Relay added goes, unless the user has changed it since.
    for (name, value) in CLAUDE_EXTRAS {
        if matches!(previous.and_then(|p| p.get(name)), Some(None))
            && env.get(name).and_then(Value::as_str) == Some(value)
        {
            env.shift_remove(name);
        }
    }
    if env.is_empty() {
        settings.shift_remove("env");
    } else {
        settings.insert("env".into(), Value::Object(env));
    }
    Ok(pretty(settings))
}

/// Puts a bound client's settings back while Relay quits: with the gateway gone, a client
/// still pointed at it could not answer at all. The binding stays saved, so the next start
/// points the client at the gateway again.
pub fn release_client_sync(id: ProxyClientId, previous: Option<&SavedValues>, home: &Path) {
    // Quitting goes on; the page says the client is not connected at the next start.
    let _ = unbind_client(id, previous, home);
}

/// This computer's Tailscale IPv4 address, when one of its interfaces is on a tailnet.
pub fn tailscale_address() -> Option<String> {
    let networks = sysinfo::Networks::new_with_refreshed_list();
    networks.iter().find_map(|(_, data)| {
        data.ip_networks()
            .iter()
            .find_map(|network| match network.addr {
                std::net::IpAddr::V4(v4) if !v4.is_loopback() => {
                    let text = v4.to_string();
                    is_tailscale_ipv4(&text).then_some(text)
                }
                _ => None,
            })
    })
}
