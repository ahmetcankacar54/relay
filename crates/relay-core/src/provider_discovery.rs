//! Port of `electron/core/provider-discovery.ts`: the sign-ins already on this computer, and the
//! one-click connect of a Claude or Codex account.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::clock::now_ms;
use crate::desktop_files::{directories, identity, is_uuid, read_object};
use crate::environment::{Env, process_env};
use crate::fs_util::iso_timestamp;
use crate::provider_credentials::{
    CodexCredential, CodexCredentialKind, codex_auth_files, read_codex_cli_session,
    read_open_ai_api_key, token_expiry, write_codex_credential,
};
use crate::relay_paths::{Platform, app_data_root, home_dir};
use crate::shared::types::{
    Account, AccountAuth, AccountProvider, CascadeLayerStatus, CascadeLayers, CreateAccount,
    DetectedProviderSession, OneClickCascadeResult, OneClickConnectInput,
};
use crate::store::schema::{Schema, SchemaError, StringRule, enumeration, strict, string};
use crate::store::{Store, StoreError, parse_as};

fn trimmed(min: Option<usize>, max: usize) -> Schema {
    string(StringRule {
        trim: true,
        min,
        max: Some(max),
        ..Default::default()
    })
}

/// `oneClickConnectSchema`.
pub fn one_click_connect_schema() -> Schema {
    strict(vec![
        ("provider", enumeration(["claude", "codex"])),
        ("name", trimmed(Some(1), 64)),
        ("kind", enumeration(["personal", "work"])),
        ("group", trimmed(Some(1), 64).optional()),
        // Codex only: an OpenAI API key typed by the user.
        ("apiKey", trimmed(None, 16_384).optional()),
    ])
}

/// Where `detect_providers` looks; every field defaults to this computer's.
#[derive(Debug, Clone, Default)]
pub struct ProviderDiscoveryPaths {
    pub home_dir: Option<PathBuf>,
    pub claude_desktop_root: Option<PathBuf>,
    /// The platform whose default Claude folder is used when `claude_desktop_root` is not given.
    pub platform: Option<Platform>,
    pub env: Option<Env>,
}

fn text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn session(provider: AccountProvider, detected: bool) -> DetectedProviderSession {
    DetectedProviderSession {
        provider,
        detected,
        email: None,
        name: None,
        account_uuid: None,
        org_id: None,
        org_name: None,
        plan: None,
        source: None,
        already_linked_account_id: None,
        already_linked_account_name: None,
    }
}

/// The Claude app's current sign-in and its Code workspaces, as Desktop keeps them.
fn inspect_claude(
    accounts: &[Account],
    desktop_root: &Path,
) -> (DetectedProviderSession, Vec<String>) {
    let config = read_object(desktop_root, "config.json").ok().flatten();
    let account_uuid = identity(config.as_ref());
    let oauth: Option<&Map<String, Value>> = config
        .as_ref()
        .and_then(|c| c.get("oauthAccount"))
        .and_then(Value::as_object);
    let orgs: Vec<String> = match &account_uuid {
        Some(id) => directories(desktop_root, &format!("claude-code-sessions/{id}"))
            .map(|list| list.into_iter().filter(|org| is_uuid(org)).collect())
            .unwrap_or_default(),
        None => Vec::new(),
    };
    let linked = account_uuid.as_ref().and_then(|id| {
        accounts.iter().find(|a| {
            a.provider.unwrap_or(AccountProvider::Claude) == AccountProvider::Claude
                && a.desktop
                    .as_ref()
                    .is_some_and(|d| d.account_uuid.to_lowercase() == id.to_lowercase())
        })
    });
    let field = |key: &str| oauth.and_then(|o| o.get(key));
    let mut found = session(AccountProvider::Claude, account_uuid.is_some());
    found.email = text(field("emailAddress")).or_else(|| text(field("email")));
    found.org_id = (orgs.len() == 1).then(|| orgs[0].clone());
    found.org_name = text(field("organizationName"));
    found.source = account_uuid.as_ref().map(|_| "Claude Desktop".to_owned());
    found.account_uuid = account_uuid;
    if let Some(linked) = linked {
        found.already_linked_account_id = Some(linked.id.clone());
        found.already_linked_account_name = Some(linked.name.clone());
    }
    (found, orgs)
}

fn env_lookup(env: &Env) -> impl Fn(&str) -> Option<String> + '_ {
    |key| env.get(key).cloned()
}

/// The Codex CLI's sign-in, or an OpenAI API key it or the environment holds.
fn inspect_codex(accounts: &[Account], home: &Path, env: &Env) -> DetectedProviderSession {
    let files = codex_auth_files(Some(home));
    let home_text = home.to_string_lossy();
    let tilde = |file: &Path| {
        let file = file.to_string_lossy();
        match file.strip_prefix(home_text.as_ref()) {
            Some(rest) => format!("~{rest}"),
            None => file.into_owned(),
        }
    };
    if let Some(cli) = read_codex_cli_session(&files) {
        let expires_at = token_expiry(&cli.access_token);
        let usable = expires_at.is_none_or(|at| at > now_ms() as f64);
        let linked = accounts.iter().find(|a| {
            a.provider == Some(AccountProvider::Codex)
                && (cli.account_id.as_ref().is_some_and(|id| {
                    a.auth.as_ref().and_then(|x| x.account_uuid.as_ref()) == Some(id)
                }) || cli.email.as_ref().is_some_and(|email| {
                    a.auth
                        .as_ref()
                        .and_then(|x| x.email.as_ref())
                        .is_some_and(|e| e.to_lowercase() == email.to_lowercase())
                }))
        });
        let mut found = session(AccountProvider::Codex, usable);
        found.email = cli.email;
        found.plan = cli.plan;
        found.source = Some(tilde(&files[0]));
        if let Some(linked) = linked {
            found.already_linked_account_id = Some(linked.id.clone());
            found.already_linked_account_name = Some(linked.name.clone());
        }
        return found;
    }
    let key = read_open_ai_api_key(&files, &env_lookup(env));
    let mut found = session(AccountProvider::Codex, key.is_some());
    if let Some(key) = key {
        found.plan = Some("API key".into());
        found.source = Some(
            if env.get("OPENAI_API_KEY").map(|k| k.trim()) == Some(key.as_str()) {
                "OPENAI_API_KEY".into()
            } else {
                tilde(&files[0])
            },
        );
    }
    found
}

/// Claude, Codex and Antigravity, in that order: what each has signed in on this computer.
pub fn detect_providers(
    accounts: &[Account],
    paths: &ProviderDiscoveryPaths,
) -> Vec<DetectedProviderSession> {
    let home = paths.home_dir.clone().unwrap_or_else(home_dir);
    let desktop_root = paths.claude_desktop_root.clone().unwrap_or_else(|| {
        let lookup = |key: &str| -> Option<OsString> {
            match &paths.env {
                Some(env) => env.get(key).map(OsString::from),
                None => std::env::var_os(key),
            }
        };
        app_data_root(
            paths.platform.unwrap_or(Platform::current()),
            &home,
            &lookup,
        )
        .join("Claude")
    });
    let env = paths.env.clone().unwrap_or_else(process_env);
    let (claude, _orgs) = inspect_claude(accounts, &desktop_root);
    let codex = inspect_codex(accounts, &home, &env);
    vec![claude, codex, session(AccountProvider::Antigravity, false)]
}

/// What OpenAI said about an API key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OpenAiKeyCheck {
    Ok,
    Rejected,
    Unreachable,
}

/// Asks OpenAI whether an API key works: one cheap model list.
pub fn check_open_ai_key(key: &str) -> OpenAiKeyCheck {
    let response = crate::usage::http_client()
        .get("https://api.openai.com/v1/models")
        .header("authorization", format!("Bearer {key}"))
        .timeout(Duration::from_secs(10))
        .send();
    match response {
        Ok(res) if res.status().is_success() => OpenAiKeyCheck::Ok,
        Ok(res) if matches!(res.status().as_u16(), 401 | 403) => OpenAiKeyCheck::Rejected,
        _ => OpenAiKeyCheck::Unreachable,
    }
}

/// An error a caller-supplied step failed with.
pub type HookError = Box<dyn std::error::Error + Send + Sync>;
/// A caller-supplied step that may fail, given the new account's id (and, for a capture, the
/// workspace's org id).
pub type AccountStep<'a> = &'a dyn Fn(&str) -> Result<(), HookError>;
pub type CaptureStep<'a> = &'a dyn Fn(&str, &str) -> Result<(), HookError>;

/// What `execute_one_click_cascade` drives besides the registry.
pub struct OneClickCascadeDeps<'a> {
    pub store: &'a Store,
    pub desktop_root: PathBuf,
    pub home_dir: Option<PathBuf>,
    pub env: Option<Env>,
    /// Saves the Claude app's current sign-in (and the workspace) into the profile.
    pub capture_desktop: Option<CaptureStep<'a>>,
    /// Starts a Claude app sign-in for the profile: Claude quits and opens signed out.
    pub begin_desktop_login: Option<AccountStep<'a>>,
    /// Saves the sign-in by itself once it and a Code workspace are there.
    pub arm_auto_capture: Option<&'a dyn Fn(&str)>,
    /// Failures of these three are ignored, as the TS catches them.
    pub check_terminal: Option<&'a dyn Fn()>,
    pub check_extension: Option<&'a dyn Fn(&str)>,
    pub refresh_usage: Option<&'a dyn Fn(&str)>,
    pub check_open_ai_key: Option<&'a dyn Fn(&str) -> OpenAiKeyCheck>,
    /// Epoch ms.
    pub now: Option<&'a dyn Fn() -> i64>,
}

impl<'a> OneClickCascadeDeps<'a> {
    /// Only the registry and the Claude app's folder; every step left out.
    pub fn new(store: &'a Store, desktop_root: impl Into<PathBuf>) -> Self {
        OneClickCascadeDeps {
            store,
            desktop_root: desktop_root.into(),
            home_dir: None,
            env: None,
            capture_desktop: None,
            begin_desktop_login: None,
            arm_auto_capture: None,
            check_terminal: None,
            check_extension: None,
            refresh_usage: None,
            check_open_ai_key: None,
            now: None,
        }
    }
}

/// Thrown before anything is saved: the credential does not work or is already an account.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct ConnectError(pub String);

#[derive(Debug, thiserror::Error)]
pub enum OneClickError {
    /// The input failed `one_click_connect_schema` (`ZodError`).
    #[error(transparent)]
    Invalid(#[from] SchemaError),
    #[error(transparent)]
    Connect(#[from] ConnectError),
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    /// `begin_desktop_login` failed; the new account was removed.
    #[error(transparent)]
    DesktopLogin(HookError),
}

fn remove_account(store: &Store, id: &str) -> Result<(), StoreError> {
    store.update(|s| s.accounts.retain(|a| a.id != id))
}

/// Adds a Claude or Codex account in one step.
///
/// Claude: the Claude app's current sign-in is saved when it is not an account yet (straight
/// away with one Code workspace, otherwise once the user opens Code or picks one); otherwise a
/// new Claude app sign-in starts. Nothing is copied from the Claude Code CLI: its refresh token
/// rotates, and a second holder would log it out. The sign-in state comes from the capture.
///
/// Codex: a typed or detected OpenAI API key is checked with OpenAI first; a Codex CLI ChatGPT
/// sign-in is used while it has not expired, without its refresh token. The account is only
/// marked signed in with a credential that passed, and the plan is only what the token says.
pub fn execute_one_click_cascade(
    raw_input: &Value,
    deps: &OneClickCascadeDeps,
) -> Result<OneClickCascadeResult, OneClickError> {
    let input: OneClickConnectInput = parse_as(&one_click_connect_schema(), raw_input)?;
    let home = deps.home_dir.clone().unwrap_or_else(home_dir);
    let now = || deps.now.map_or_else(now_ms, |now| now());
    let store = deps.store;

    if input.provider == AccountProvider::Claude {
        let accounts = store.with_state(|s| s.accounts.clone());
        let (current, orgs) = inspect_claude(&accounts, &deps.desktop_root);
        let account = store.create(&CreateAccount {
            name: input.name,
            kind: input.kind,
            group: input.group,
            provider: Some(AccountProvider::Claude),
        })?;
        let unsaved = current.account_uuid.is_some() && current.already_linked_account_id.is_none();
        let mut desktop = CascadeLayerStatus::Pending;
        let mut needs_sign_in = false;
        let arm = || {
            if let Some(arm) = deps.arm_auto_capture {
                arm(&account.id);
            }
        };
        if let (true, 1, Some(capture)) = (unsaved, orgs.len(), deps.capture_desktop) {
            match capture(&account.id, &orgs[0]) {
                Ok(()) => desktop = CascadeLayerStatus::Done,
                Err(_) => arm(),
            }
        } else if unsaved {
            // Code not opened yet, or several workspaces: saved once it is there or one is picked.
            arm();
        } else if let Some(begin) = deps.begin_desktop_login {
            if let Err(error) = begin(&account.id) {
                // Claude could not start the sign-in (busy, refused to quit): no empty account is left.
                remove_account(store, &account.id)?;
                return Err(OneClickError::DesktopLogin(error));
            }
            arm();
            needs_sign_in = true;
        }

        if let Some(check) = deps.check_terminal {
            check();
        }
        if let Some(check) = deps.check_extension {
            check(&account.id);
        }
        if desktop == CascadeLayerStatus::Done
            && let Some(refresh) = deps.refresh_usage
        {
            refresh(&account.id);
        }

        let updated = store.account(&account.id)?;
        let linked = updated.desktop.is_some();
        let layer = |status| {
            if linked {
                CascadeLayerStatus::Done
            } else {
                status
            }
        };
        return Ok(OneClickCascadeResult {
            account: updated,
            layers: CascadeLayers {
                desktop: layer(desktop),
                usage: layer(CascadeLayerStatus::Pending),
                terminal: layer(CascadeLayerStatus::Pending),
                extension_and_proxy: layer(CascadeLayerStatus::Pending),
            },
            needs_sign_in: needs_sign_in.then_some(true),
        });
    }

    let files = codex_auth_files(Some(&home));
    let typed = input
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|k| !k.is_empty());
    let cli = if typed.is_some() {
        None
    } else {
        read_codex_cli_session(&files)
    };
    let cli_expiry = cli.as_ref().and_then(|s| token_expiry(&s.access_token));
    let credential: CodexCredential;
    let mut email: Option<String> = None;
    let plan: Option<String>;
    match &cli {
        Some(cli) if cli_expiry.is_none_or(|at| at > now() as f64) => {
            credential = CodexCredential {
                kind: CodexCredentialKind::Chatgpt,
                access_token: cli.access_token.clone(),
                expires_at: cli_expiry.filter(|at| *at != 0.0),
                account_id: cli.account_id.clone(),
            };
            email = cli.email.clone();
            plan = cli.plan.clone();
        }
        _ => {
            let env = deps.env.clone().unwrap_or_else(process_env);
            let key = typed
                .map(str::to_owned)
                .or_else(|| read_open_ai_api_key(&files, &env_lookup(&env)));
            let Some(key) = key else {
                return Err(ConnectError(
                    if cli.is_some() {
                        "The Codex CLI sign-in has expired. Run codex once to renew it, or enter an OpenAI API key."
                    } else {
                        "No usable credential found for this provider"
                    }
                    .into(),
                )
                .into());
            };
            if !key.starts_with("sk-") {
                return Err(ConnectError("An OpenAI API key starts with sk-.".into()).into());
            }
            let verdict = match deps.check_open_ai_key {
                Some(check) => check(&key),
                None => check_open_ai_key(&key),
            };
            match verdict {
                OpenAiKeyCheck::Rejected => {
                    return Err(ConnectError("OpenAI rejected this API key.".into()).into());
                }
                OpenAiKeyCheck::Unreachable => {
                    return Err(ConnectError(
                        "OpenAI could not be reached to check the key. Try again.".into(),
                    )
                    .into());
                }
                OpenAiKeyCheck::Ok => {}
            }
            credential = CodexCredential {
                kind: CodexCredentialKind::ApiKey,
                access_token: key,
                expires_at: None,
                account_id: None,
            };
            plan = Some("API key".into());
        }
    }

    let existing =
        store.with_state(|s| {
            s.accounts
                .iter()
                .find(|a| {
                    let auth = a.auth.as_ref();
                    a.provider == Some(AccountProvider::Codex)
                        && (credential.account_id.as_ref().is_some_and(|id| {
                            auth.and_then(|x| x.account_uuid.as_ref()) == Some(id)
                        }) || (credential.kind == CodexCredentialKind::Chatgpt
                            && email.as_ref().is_some_and(|email| {
                                auth.and_then(|x| x.email.as_ref())
                                    .is_some_and(|e| e.to_lowercase() == email.to_lowercase())
                            })))
                })
                .map(|a| a.name.clone())
        });
    if let Some(name) = existing {
        return Err(ConnectError(format!("This sign-in is already the account {name}.")).into());
    }

    let account = store.create(&CreateAccount {
        name: input.name,
        kind: input.kind,
        group: input.group,
        provider: Some(AccountProvider::Codex),
    })?;
    if let Err(error) = write_codex_credential(&store.profile(&account.id)?, &credential) {
        remove_account(store, &account.id)?;
        return Err(error.into());
    }
    let account_uuid = credential.account_id.clone().filter(|id| is_uuid(id));
    let checked_at = iso_timestamp(now());
    store.update(|s| {
        let Some(stored) = s.accounts.iter_mut().find(|a| a.id == account.id) else {
            return;
        };
        stored.auth = Some(AccountAuth {
            logged_in: true,
            checked_at,
            email,
            account_uuid,
            subscription: plan,
            ..Default::default()
        });
    })?;

    Ok(OneClickCascadeResult {
        account: store.account(&account.id)?,
        layers: CascadeLayers {
            desktop: CascadeLayerStatus::Skipped,
            usage: CascadeLayerStatus::Skipped,
            terminal: CascadeLayerStatus::Skipped,
            extension_and_proxy: CascadeLayerStatus::Done,
        },
        needs_sign_in: None,
    })
}
