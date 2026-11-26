//! The window bridge (port of electron/main/ipc/index.ts and trust.ts): the two Tauri commands
//! `relay_invoke` and `relay_send` dispatch on the Electron channel names, each argument checked
//! with the limits of the zod schemas it had.
//!
//! The UI bridge sends JavaScript `undefined` as JSON `null`, so every argument zod read as
//! `.optional()` takes `null` too (`Call::opt_*`).

mod accounts;
mod antigravity;
mod app;
mod continuation;
mod desktop;
mod diagnostics_backup;
mod proxy;
mod settings;
mod snapshots;

use std::collections::HashMap;
use std::fmt::Display;
use std::sync::LazyLock;

use relay_core::shared::feature_risk::{
    FEATURE_RISK_IDS, FeatureRiskId, acknowledge_risks, feature_risk, require_risk_ack,
};
use relay_core::store::schema::{
    self, IssueCode, NumberRule, PathKey, Schema, SchemaError, StringRule,
};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};

use crate::i18n::say_with;
use crate::state::STATE;

/// The webview a call came from (Electron's `event.sender`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Sender {
    Main,
    Panel,
    Switch,
}

impl Sender {
    pub fn from_label(label: &str) -> Option<Sender> {
        match label {
            crate::events::MAIN => Some(Sender::Main),
            crate::events::PANEL => Some(Sender::Panel),
            crate::events::SWITCH => Some(Sender::Switch),
            _ => None,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Sender::Main => crate::events::MAIN,
            Sender::Panel => crate::events::PANEL,
            Sender::Switch => crate::events::SWITCH,
        }
    }
}

/// One call: who sent it and its arguments.
pub struct Call {
    pub sender: Sender,
    pub args: Vec<Value>,
}

static NULL: Value = Value::Null;

/// What a failed call says; the bridge rejects with it as Electron's `Error.message`.
pub type IpcResult = Result<Value, String>;

/// A handler's value as the window gets it.
pub fn reply(value: impl Serialize) -> IpcResult {
    serde_json::to_value(value).map_err(|e| e.to_string())
}

/// `undefined`: what a handler that returns nothing replies.
pub fn done() -> IpcResult {
    Ok(Value::Null)
}

/// Any error as the message the window shows.
pub trait OrMessage<T> {
    fn msg(self) -> Result<T, String>;
}

impl<T, E: Display> OrMessage<T> for Result<T, E> {
    fn msg(self) -> Result<T, String> {
        self.map_err(|e| e.to_string())
    }
}

/// zod's `ZodError.message`: its issues as pretty JSON.
pub fn zod_message(error: &SchemaError) -> String {
    let issues: Vec<Value> = error
        .issues
        .iter()
        .map(|issue| {
            let mut out = Map::new();
            let code = match &issue.code {
                IssueCode::InvalidType => "invalid_type",
                IssueCode::InvalidValue => "invalid_value",
                IssueCode::InvalidUnion => "invalid_union",
                IssueCode::InvalidFormat => "invalid_format",
                IssueCode::InvalidKey => "invalid_key",
                IssueCode::TooSmall => "too_small",
                IssueCode::TooBig => "too_big",
                IssueCode::Custom => "custom",
                IssueCode::UnrecognizedKeys(_) => "unrecognized_keys",
            };
            out.insert("code".into(), json!(code));
            if let IssueCode::UnrecognizedKeys(keys) = &issue.code {
                out.insert("keys".into(), json!(keys));
            }
            let path: Vec<Value> = issue
                .path
                .iter()
                .map(|key| match key {
                    PathKey::Key(key) => json!(key),
                    PathKey::Index(index) => json!(index),
                })
                .collect();
            out.insert("path".into(), Value::Array(path));
            out.insert("message".into(), json!(issue.message));
            Value::Object(out)
        })
        .collect();
    serde_json::to_string_pretty(&issues).unwrap_or_else(|_| error.to_string())
}

/// `z.uuid()`: an account, run or sign-in attempt id.
pub fn id_schema() -> Schema {
    schema::uuid()
}

/// `z.string().min(1).max(100)`: a Claude Code session key.
pub fn key_schema() -> Schema {
    string(1, 100)
}

/// `z.string().min(min).max(max)`.
pub fn string(min: usize, max: usize) -> Schema {
    schema::string(StringRule {
        min: Some(min),
        max: Some(max),
        ..StringRule::default()
    })
}

/// `z.number().int().min(min).max(max)`.
pub fn int(min: f64, max: f64) -> Schema {
    schema::number(NumberRule {
        int: true,
        min: Some(min),
        max: Some(max),
    })
}

impl Call {
    pub fn new(sender: Sender, args: Vec<Value>) -> Call {
        Call { sender, args }
    }

    /// The argument at `index`; a missing one is `undefined` (null).
    pub fn arg(&self, index: usize) -> &Value {
        self.args.get(index).unwrap_or(&NULL)
    }

    /// Whether the argument is `undefined` (null or missing).
    pub fn absent(&self, index: usize) -> bool {
        self.arg(index).is_null()
    }

    /// `schema.parse(arg)`: the parsed JSON (defaults applied, unknown keys stripped).
    pub fn value(&self, index: usize, schema: &Schema) -> Result<Value, String> {
        schema.parse(self.arg(index)).map_err(|e| zod_message(&e))
    }

    /// `schema.optional().parse(arg)`: `None` for `undefined`.
    pub fn opt_value(&self, index: usize, schema: &Schema) -> Result<Option<Value>, String> {
        if self.absent(index) {
            return Ok(None);
        }
        self.value(index, schema).map(Some)
    }

    /// `schema.parse(arg)` into a typed value.
    pub fn parse<T: DeserializeOwned>(&self, index: usize, schema: &Schema) -> Result<T, String> {
        let value = self.value(index, schema)?;
        serde_json::from_value(value).msg()
    }

    pub fn opt_parse<T: DeserializeOwned>(
        &self,
        index: usize,
        schema: &Schema,
    ) -> Result<Option<T>, String> {
        match self.opt_value(index, schema)? {
            Some(value) => serde_json::from_value(value).msg().map(Some),
            None => Ok(None),
        }
    }

    /// `id.parse(arg)`: a UUID.
    pub fn id(&self, index: usize) -> Result<String, String> {
        self.parse(index, &id_schema())
    }

    /// `id.optional().parse(arg)`.
    pub fn opt_id(&self, index: usize) -> Result<Option<String>, String> {
        self.opt_parse(index, &id_schema())
    }

    /// `key.parse(arg)`: a session key.
    pub fn key(&self, index: usize) -> Result<String, String> {
        self.parse(index, &key_schema())
    }

    /// `z.boolean().parse(arg)`.
    pub fn bool(&self, index: usize) -> Result<bool, String> {
        self.parse(index, &schema::boolean())
    }

    /// `z.string().min(min).max(max).parse(arg)`.
    pub fn string(&self, index: usize, min: usize, max: usize) -> Result<String, String> {
        self.parse(index, &string(min, max))
    }

    /// `z.number().int().min(min).max(max).parse(arg)`.
    pub fn int(&self, index: usize, min: f64, max: f64) -> Result<i64, String> {
        let value: f64 = self.parse(index, &int(min, max))?;
        Ok(value as i64)
    }

    /// `z.enum(values).parse(arg)`.
    pub fn one_of(&self, index: usize, values: &[&str]) -> Result<String, String> {
        self.parse(index, &schema::enumeration(values.iter().copied()))
    }

    /// `z.enum(values).optional().parse(arg)`.
    pub fn opt_one_of(&self, index: usize, values: &[&str]) -> Result<Option<String>, String> {
        self.opt_parse(index, &schema::enumeration(values.iter().copied()))
    }
}

/// Refuses a risky feature until the user has accepted its risk text in the window (or the
/// CLI's --yes).
pub fn require_risk(ids: &[FeatureRiskId]) -> Result<(), String> {
    let acks = STATE.settings().risk_acknowledged;
    require_risk_ack(Some(&acks), ids, |pending| {
        let features = pending
            .iter()
            .map(|risk| crate::i18n::say(feature_risk(*risk).title))
            .collect::<Vec<_>>()
            .join(", ");
        say_with(
            "featureRisk.acceptFirst",
            &relay_i18n::Args::new().set("features", features),
        )
    })
    .msg()
}

pub type Handler = fn(&Call) -> IpcResult;
pub type SendHandler = fn(&Call) -> Result<(), String>;

/// Which windows may make a call.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Callers {
    /// The main window and the menu bar panel showing Relay's own pages (`trusted`).
    Relay,
    /// The panel only (`fromPanel`).
    Panel,
    /// The switch window only.
    Switch,
}

impl Callers {
    fn admits(self, sender: Sender) -> bool {
        match self {
            Callers::Relay => matches!(sender, Sender::Main | Sender::Panel),
            Callers::Panel => sender == Sender::Panel,
            Callers::Switch => sender == Sender::Switch,
        }
    }
}

/// Every channel's handler, by its name without the `relay:` prefix.
#[derive(Default)]
pub struct Registry {
    invoke: HashMap<&'static str, Handler>,
    send: HashMap<&'static str, (Callers, SendHandler)>,
}

impl Registry {
    /// Registers `relay:<name>` for the main window and the menu bar panel.
    pub fn handle(&mut self, name: &'static str, handler: Handler) {
        let replaced = self.invoke.insert(name, handler);
        debug_assert!(replaced.is_none(), "relay:{name} registered twice");
    }

    /// Registers the one-way `relay:<name>` for `callers`.
    pub fn on(&mut self, name: &'static str, callers: Callers, handler: SendHandler) {
        let replaced = self.send.insert(name, (callers, handler));
        debug_assert!(replaced.is_none(), "relay:{name} registered twice");
    }
}

static REGISTRY: LazyLock<Registry> = LazyLock::new(|| {
    let mut registry = Registry::default();
    registry.handle("acknowledge-risk", acknowledge_risk);
    registry.handle("legacy-ui-storage", legacy_ui_storage);
    continuation::register(&mut registry);
    diagnostics_backup::register(&mut registry);
    app::register(&mut registry);
    accounts::register(&mut registry);
    desktop::register(&mut registry);
    proxy::register(&mut registry);
    antigravity::register(&mut registry);
    settings::register(&mut registry);
    snapshots::register(&mut registry);
    registry
});

/// Every request channel, `relay:`-prefixed and sorted.
pub fn invoke_channels() -> Vec<String> {
    let mut names: Vec<String> = REGISTRY
        .invoke
        .keys()
        .map(|name| format!("relay:{name}"))
        .collect();
    names.sort();
    names
}

/// Every one-way channel, `relay:`-prefixed and sorted.
pub fn send_channels() -> Vec<String> {
    let mut names: Vec<String> = REGISTRY
        .send
        .keys()
        .map(|name| format!("relay:{name}"))
        .collect();
    names.sort();
    names
}

const INVALID_SOURCE: &str = "Invalid IPC source.";

/// Runs a request channel. Only the main window and the panel may call; a channel nobody
/// registered answers as Electron's `ipcRenderer.invoke` did.
pub fn dispatch(channel: &str, call: &Call) -> IpcResult {
    if !Callers::Relay.admits(call.sender) {
        return Err(INVALID_SOURCE.into());
    }
    let handler = channel
        .strip_prefix("relay:")
        .and_then(|name| REGISTRY.invoke.get(name))
        .ok_or_else(|| format!("No handler registered for '{channel}'"))?;
    if !STATE.initialized() {
        return Err("Relay is still starting.".into());
    }
    let result = handler(call);
    // A smoke run says which call failed; the window has no console to show.
    #[cfg(feature = "smoke")]
    if let Err(error) = &result {
        eprintln!(
            "relay smoke: {channel} from {:?} failed: {error}",
            call.sender
        );
    }
    #[cfg(feature = "smoke")]
    if call.sender == Sender::Main
        && let Ok(value) = &result
    {
        match channel {
            "relay:panel-snapshot" => crate::smoke::page_ready(),
            "relay:snapshot" => crate::smoke::snapshot_called(value, call.arg(0)),
            _ => {}
        }
    }
    result
}

/// Runs a one-way channel; a refused or failed message is dropped, as Electron ignored it.
pub fn dispatch_send(channel: &str, call: &Call) -> Result<(), String> {
    let (callers, handler) = channel
        .strip_prefix("relay:")
        .and_then(|name| REGISTRY.send.get(name))
        .ok_or_else(|| format!("No handler registered for '{channel}'"))?;
    if !callers.admits(call.sender) {
        return Err(INVALID_SOURCE.into());
    }
    if !STATE.initialized() {
        return Ok(());
    }
    handler(call)
}

fn acknowledge_risk(call: &Call) -> IpcResult {
    let ids: Vec<FeatureRiskId> = call.parse(
        0,
        &schema::array(
            schema::enumeration(FEATURE_RISK_IDS.iter().map(|id| id.as_str())),
            Some(FEATURE_RISK_IDS.len()),
        ),
    )?;
    if ids.is_empty() {
        return Err(zod_message(&SchemaError {
            issues: vec![schema::Issue {
                code: IssueCode::TooSmall,
                path: Vec::new(),
                message: "Too small: expected array to have >=1 items".into(),
                continues: true,
            }],
        }));
    }
    let store = &STATE.service().store;
    store
        .update(|state| {
            state.settings.risk_acknowledged =
                acknowledge_risks(Some(&state.settings.risk_acknowledged), &ids);
        })
        .msg()?;
    crate::events::changed();
    reply(STATE.settings())
}

/// Electron's localStorage, handed to the new webview once (crate::legacy_storage).
fn legacy_ui_storage(_call: &Call) -> IpcResult {
    let data = STATE.paths().data_dir();
    reply(crate::legacy_storage::legacy_ui_storage(&data))
}

/// The Tauri commands the bundled pages call (capabilities/default.json).
pub mod commands {
    use super::{Call, Sender, dispatch, dispatch_send};
    use serde_json::Value;

    fn sender(webview: &tauri::Webview) -> Result<Sender, String> {
        let sender = Sender::from_label(webview.label()).ok_or(super::INVALID_SOURCE)?;
        let url = webview.url().map_err(|e| e.to_string())?;
        if !crate::host::relay_page(&url) {
            #[cfg(feature = "smoke")]
            eprintln!(
                "relay smoke: refused a call from {} at {url}",
                webview.label()
            );
            return Err(super::INVALID_SOURCE.into());
        }
        Ok(sender)
    }

    #[tauri::command]
    pub async fn relay_invoke(
        webview: tauri::Webview,
        channel: String,
        args: Vec<Value>,
    ) -> Result<Value, String> {
        let call = Call::new(sender(&webview)?, args);
        tauri::async_runtime::spawn_blocking(move || dispatch(&channel, &call))
            .await
            .map_err(|e| e.to_string())?
    }

    /// One-way messages run one after the other in the order the page sent them (keystrokes
    /// to a terminal): this synchronous command only queues; one worker thread runs them.
    #[tauri::command]
    pub fn relay_send(
        webview: tauri::Webview,
        channel: String,
        args: Vec<Value>,
    ) -> Result<(), String> {
        let call = Call::new(sender(&webview)?, args);
        SENDS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .send((channel, call))
            .map_err(|e| e.to_string())
    }

    type Queued = (String, Call);

    static SENDS: std::sync::LazyLock<std::sync::Mutex<std::sync::mpsc::Sender<Queued>>> =
        std::sync::LazyLock::new(|| {
            let (queue, messages) = std::sync::mpsc::channel::<Queued>();
            std::thread::Builder::new()
                .name("relay-send".into())
                .spawn(move || {
                    for (channel, call) in messages {
                        // Electron ignored a refused or invalid one-way message.
                        let _ = dispatch_send(&channel, &call);
                    }
                })
                .expect("the one-way message thread starts");
            std::sync::Mutex::new(queue)
        });
}
