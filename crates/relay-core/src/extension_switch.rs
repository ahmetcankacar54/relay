//! Port of `electron/core/extension-switch.ts`: keeps the Claude extension's sign-in, and the
//! browser profile's claude.ai login it signs in with, with the account at a switch.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use indexmap::IndexMap;

use crate::browser_system::{
    BrowserSystem, QUIT_WAIT_MS, browser_running, data_dir, extension_instances,
    extension_storage_dir, quit_browser,
};
use crate::cookie_store::{
    CookieSnapshot, CookieStorage, CookieStoreError, CookieStoreReason, backup_cookie_files,
    has_web_login, org_fingerprint, restore_cookie_files, same_login, session_created_ms,
    session_expires_ms,
};
use crate::cookie_vault::CookieVault;
use crate::draft_vault::Clock;
use crate::extension_storage::{
    ExtensionStorage, StorageError, StorageReason, backup_folder, clear_scratch, keep_scratch,
    remove_backup, restore_folder,
};
use crate::extension_vault::ExtensionVault;
use crate::fs_util::iso_timestamp;
use crate::shared::browser_extension::{
    ExtensionCurrent, ExtensionInstance, ExtensionMode, ExtensionOutcome, ExtensionReason,
    ExtensionResult, ExtensionSetting, choose_instance,
};
use crate::shared::extension_auth::{FAILURE_KEYS, SignIn, pick_sign_in, session_expired};

/// Why a claude.ai login is not kept as an account's: it is another account's login, it is on
/// another account's organization, or the extension already failed to sign in with it there.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ForeignWhy {
    SameLogin,
    OtherOrg,
    Rejected,
}

impl ForeignWhy {
    pub const fn as_str(self) -> &'static str {
        match self {
            ForeignWhy::SameLogin => "same-login",
            ForeignWhy::OtherOrg => "other-org",
            ForeignWhy::Rejected => "rejected",
        }
    }
}

type Hook<T> = Option<Box<T>>;
/// Told key names (`on_unknown_layout`).
pub type NamesHook = dyn Fn(&[String]) + Send + Sync;
/// Told a cookie layout detail (`on_cookie_layout`).
pub type DetailHook = dyn Fn(&IndexMap<String, String>) + Send + Sync;
/// Told `account`, `other` and why (`on_foreign_login`).
pub type ForeignHook = dyn Fn(&str, &str, ForeignWhy) + Send + Sync;
/// Told `account` and `from` (`on_fresh_login`).
pub type FreshHook = dyn Fn(&str, &str) + Send + Sync;

/// What the switcher reads and writes, and who it tells.
pub struct ExtensionPorts {
    pub system: Arc<dyn BrowserSystem>,
    pub storage: Arc<dyn ExtensionStorage>,
    pub vault: Arc<ExtensionVault>,
    /// The browser's cookie database and the sealed claude.ai logins. The extension signs in
    /// through the profile's claude.ai login, so the modes that change the extension's account
    /// swap that login with the extension's hints; without these a step reports itself
    /// unavailable.
    pub cookies: Option<Arc<dyn CookieStorage>>,
    pub cookie_vault: Option<Arc<CookieVault>>,
    /// Where a step keeps the backup of the cookie files while it runs; `<scratch>-cookies` when
    /// None.
    pub cookie_scratch: Option<PathBuf>,
    /// Where a step keeps the backup of the extension's folder while it runs.
    pub scratch: PathBuf,
    /// Where a check keeps its copy of the extension's folder; `<scratch>-peek` when None.
    pub peek_scratch: Option<PathBuf>,
    /// Told the key names (never values) a check saw when it found no account of Relay's.
    pub on_unknown_layout: Hook<NamesHook>,
    /// Told why a saved claude.ai login could not be used: the browser holds login-like cookies
    /// this build does not know (their names), or its cookie database differs from the saved one.
    pub on_cookie_layout: Hook<DetailHook>,
    /// Told when the profile's claude.ai login was not kept for `account` (`account`, `other`).
    pub on_foreign_login: Hook<ForeignHook>,
    /// Told when a newer claude.ai login was kept for `account` (`account`, `from`).
    pub on_fresh_login: Hook<FreshHook>,
    pub now: Option<Clock>,
}

impl ExtensionPorts {
    /// Ports without the cookie pair, hooks or clock; set the fields to add them.
    pub fn new(
        system: Arc<dyn BrowserSystem>,
        storage: Arc<dyn ExtensionStorage>,
        vault: Arc<ExtensionVault>,
        scratch: impl Into<PathBuf>,
    ) -> ExtensionPorts {
        ExtensionPorts {
            system,
            storage,
            vault,
            cookies: None,
            cookie_vault: None,
            cookie_scratch: None,
            scratch: scratch.into(),
            peek_scratch: None,
            on_unknown_layout: None,
            on_cookie_layout: None,
            on_foreign_login: None,
            on_fresh_login: None,
            now: None,
        }
    }
}

/// A switch's extension step.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtensionRequest {
    pub setting: ExtensionSetting,
    /// May quit a running browser; false for a switch that keeps Claude closed.
    pub may_quit: bool,
    /// The account to put in place: its Desktop uuid and its own, any that exist.
    pub target: Vec<String>,
    /// Every Relay account's uuids: the only extension sign-ins ever kept or replaced.
    pub known: Vec<String>,
    /// Each account uuid's organization, as Relay knows it (lower case), where it knows one.
    pub orgs: Option<HashMap<String, String>>,
    /// Each Relay account's uuids (lower case): two uuids of one account are never "another".
    pub groups: Option<Vec<Vec<String>>>,
}

/// A check's request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckRequest {
    pub setting: ExtensionSetting,
    pub known: Vec<String>,
    pub orgs: Option<HashMap<String, String>>,
    pub groups: Option<Vec<Vec<String>>>,
    /// The account the user says the extension is signed in to, for data that names none.
    pub claim: Option<String>,
}

/// A login that is not `account`'s: why, whose, and the one account it can be kept for.
struct Foreign {
    why: ForeignWhy,
    /// "other-org" on the organization of exactly one other account: that account's login.
    owner: Option<String>,
}

/// The part of an outcome a step decides.
struct Core {
    result: ExtensionResult,
    reason: Option<ExtensionReason>,
    saved: bool,
    cleared: Option<bool>,
    current: Option<ExtensionCurrent>,
}

impl Core {
    fn new(result: ExtensionResult, reason: ExtensionReason, saved: bool) -> Core {
        Core {
            result,
            reason: Some(reason),
            saved,
            cleared: None,
            current: None,
        }
    }
    fn skipped(reason: ExtensionReason, saved: bool) -> Core {
        Core::new(ExtensionResult::Skipped, reason, saved)
    }
    fn failed(reason: ExtensionReason, saved: bool) -> Core {
        Core::new(ExtensionResult::Failed, reason, saved)
    }
    fn with_current(mut self, current: ExtensionCurrent) -> Core {
        self.current = Some(current);
        self
    }
}

fn lower(list: &[String]) -> Vec<String> {
    list.iter().map(|value| value.to_lowercase()).collect()
}

/// Whether `a` is a later web login than `b`: another login, created after it.
fn newer(a: &CookieSnapshot, b: &CookieSnapshot) -> bool {
    if same_login(a, b) {
        return false;
    }
    match (session_created_ms(a), session_created_ms(b)) {
        (Some(x), Some(y)) => x > y,
        (Some(_), None) => true,
        _ => false,
    }
}

/// The web login may be created this long after the extension's hints were last written and
/// still count as the same sign-in.
const OWNER_SLACK_MS: f64 = 5.0 * 60_000.0;

/// Why a cookie-database failure ended a step.
fn cookie_reason(error: &CookieStoreError) -> ExtensionReason {
    match error.reason {
        CookieStoreReason::Locked => ExtensionReason::Locked,
        CookieStoreReason::SchemaChanged => ExtensionReason::SchemaChanged,
        CookieStoreReason::JournalPending => ExtensionReason::JournalPending,
        CookieStoreReason::Mismatch => ExtensionReason::VerifyFailed,
        CookieStoreReason::Missing => ExtensionReason::Unreadable,
        CookieStoreReason::Failed => ExtensionReason::WriteFailed,
    }
}

/// What a write in a swap failed with.
enum WriteFailure {
    Storage(StorageError),
    Cookie(CookieStoreError),
    Other,
}

fn entry_refs(entries: &[(String, String)]) -> impl Iterator<Item = (&str, Option<&str>)> {
    entries.iter().map(|(k, v)| (k.as_str(), Some(v.as_str())))
}

fn text(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn suffixed(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

/// Keeps the Claude extension's sign-in with the account. At a switch it saves the sign-in the
/// extension holds, into the vault under the account the extension says it is, and puts the
/// target's saved one in place. The extension's LevelDB can only be used while the browser is
/// closed, so a running browser is quit first (in mode "restart", when the caller allows it) and
/// opened again afterwards. Never fails.
pub struct ExtensionSwitcher {
    ports: ExtensionPorts,
}

impl ExtensionSwitcher {
    pub fn new(ports: ExtensionPorts) -> ExtensionSwitcher {
        ExtensionSwitcher { ports }
    }

    pub fn ports(&self) -> &ExtensionPorts {
        &self.ports
    }

    fn now(&self) -> i64 {
        self.ports
            .now
            .as_ref()
            .map_or_else(crate::clock::now_ms, |now| now())
    }

    /// Browser profiles that have the extension, opened or not.
    pub fn instances(&self) -> Vec<ExtensionInstance> {
        extension_instances(self.ports.system.as_ref())
    }

    pub fn run(&self, request: &ExtensionRequest) -> ExtensionOutcome {
        let at = iso_timestamp(self.now());
        let done = |core: Core, restarted: bool, reopened: Option<bool>| ExtensionOutcome {
            result: core.result,
            reason: core.reason,
            saved: core.saved,
            cleared: core.cleared,
            current: core.current,
            at: at.clone(),
            restarted,
            reopened,
        };
        match self.run_core(request) {
            Ok((core, restarted, reopened)) => done(core, restarted, reopened),
            Err(_) => done(
                Core::failed(ExtensionReason::Unreadable, false),
                false,
                None,
            ),
        }
    }

    fn run_core(&self, request: &ExtensionRequest) -> Result<(Core, bool, Option<bool>), String> {
        let system = self.ports.system.as_ref();
        let skipped = |reason| Ok((Core::skipped(reason, false), false, None));
        if request.setting.mode == ExtensionMode::Off {
            return skipped(ExtensionReason::Off);
        }
        let instances = self.instances();
        if instances.is_empty() {
            return skipped(ExtensionReason::NotInstalled);
        }
        let Some(instance) = choose_instance(&instances, request.setting.browser.as_ref()) else {
            return skipped(ExtensionReason::ChooseInstance);
        };
        // Before any browser is quit: without the library nothing could be read or written.
        if !self.ports.storage.available() {
            return skipped(ExtensionReason::Unavailable);
        }
        if request.setting.mode == ExtensionMode::Guide {
            return Ok((self.guide(request), false, None));
        }
        // Never opened: no storage to save or write; it gets one once the user opens it.
        if !instance.opened {
            return skipped(ExtensionReason::NotOpened);
        }
        if !self.pair_ready() {
            return skipped(ExtensionReason::Unavailable);
        }
        let mut restarted = false;
        if browser_running(system, instance.app)? {
            if request.setting.mode != ExtensionMode::Restart || !request.may_quit {
                return skipped(ExtensionReason::BrowserRunning);
            }
            if !quit_browser(system, instance.app, QUIT_WAIT_MS)? {
                return skipped(ExtensionReason::BrowserDidNotQuit);
            }
            restarted = true;
        }
        // The database is opened only while no browser runs; asked once more right before.
        let core = match browser_running(system, instance.app) {
            Ok(true) => Core::skipped(ExtensionReason::BrowserRunning, false),
            Ok(false) => self
                .swap(instance, request)
                .unwrap_or_else(|_| Core::failed(ExtensionReason::Unreadable, false)),
            Err(_) => Core::failed(ExtensionReason::Unreadable, false),
        };
        if !restarted {
            return Ok((core, false, None));
        }
        let reopened = system.launch(instance.app).is_ok();
        Ok((core, true, Some(reopened)))
    }

    /// Whether the cookie database can be used here: SQLite loads and the vault is wired.
    fn pair_ready(&self) -> bool {
        match (&self.ports.cookies, &self.ports.cookie_vault) {
            (Some(cookies), Some(_)) => cookies.available(),
            _ => false,
        }
    }

    /// Mode "guide": nothing is written and no browser is quit. Looks at who the extension is
    /// signed in to (a check, which also keeps what it sees) and says when it is not on the target.
    fn guide(&self, request: &ExtensionRequest) -> Core {
        let check = CheckRequest {
            setting: request.setting.clone(),
            known: request.known.clone(),
            orgs: None,
            groups: None,
            claim: None,
        };
        let Some(current) = self.check(&check) else {
            return Core::failed(ExtensionReason::Unreadable, false);
        };
        match &current {
            ExtensionCurrent::Unreadable { .. } => {
                Core::failed(ExtensionReason::Unreadable, false).with_current(current)
            }
            ExtensionCurrent::SignedOut {
                unopened: Some(true),
                ..
            } => Core::skipped(ExtensionReason::NotOpened, false).with_current(current),
            ExtensionCurrent::SignedIn {
                account_uuid,
                known,
                ..
            } => {
                let saved = *known;
                if account_uuid
                    .as_ref()
                    .is_some_and(|a| lower(&request.target).contains(a))
                {
                    Core::new(
                        ExtensionResult::Unchanged,
                        ExtensionReason::AlreadyThere,
                        saved,
                    )
                    .with_current(current)
                } else {
                    Core::skipped(ExtensionReason::GuideMismatch, saved).with_current(current)
                }
            }
            ExtensionCurrent::SignedOut { .. } => {
                Core::skipped(ExtensionReason::GuideMismatch, false).with_current(current)
            }
        }
    }

    /// Who the extension is signed in to, read from a copy of its folder so a running browser is
    /// neither quit nor disturbed; the copy is removed before this returns. A sign-in of one of
    /// Relay's accounts is saved into the vault: signing in to the extension once and checking is
    /// how an account is linked, with no switch. None when the step would not run (mode off, no
    /// extension, no library). Never fails.
    pub fn check(&self, request: &CheckRequest) -> Option<ExtensionCurrent> {
        let at = iso_timestamp(self.now());
        let peek = self
            .ports
            .peek_scratch
            .clone()
            .unwrap_or_else(|| suffixed(&self.ports.scratch, "-peek"));
        if request.setting.mode == ExtensionMode::Off {
            return None;
        }
        let instances = self.instances();
        let instance = choose_instance(&instances, request.setting.browser.as_ref())?;
        let current = self
            .peek(instance, request, &peek, &at)
            .unwrap_or_else(|_| Some(ExtensionCurrent::Unreadable { at: at.clone() }));
        clear_scratch(&peek);
        current
    }

    fn peek(
        &self,
        instance: &ExtensionInstance,
        request: &CheckRequest,
        peek: &Path,
        at: &str,
    ) -> Result<Option<ExtensionCurrent>, String> {
        let system = self.ports.system.as_ref();
        let at = at.to_owned();
        if !self.ports.storage.available() {
            return Ok(None);
        }
        // Installed, never opened: nobody has signed in to it in this profile.
        if !instance.opened {
            return Ok(Some(ExtensionCurrent::SignedOut {
                unopened: Some(true),
                at,
            }));
        }
        clear_scratch(peek);
        let copy = backup_folder(
            &extension_storage_dir(system, instance.app, &instance.profile)?,
            peek,
        )
        .map_err(text)?;
        let entries = self.ports.storage.read(&copy).map_err(text)?;
        let reading = pick_sign_in(entry_refs(&entries), &request.known);
        if reading.as_ref().is_none_or(|r| r.account.is_none())
            && let Some(hook) = &self.ports.on_unknown_layout
        {
            let names: Vec<String> = entries.iter().map(|(k, _)| k.clone()).collect();
            hook(&names);
        }
        let Some(reading) = reading else {
            return Ok(Some(ExtensionCurrent::SignedOut { unopened: None, at }));
        };
        let expired = session_expired(entry_refs(&entries)).then_some(true);
        let claim = request.claim.as_ref().map(|c| c.to_lowercase());
        let account = match reading.account.clone() {
            Some(account) => Some(account),
            None if reading.other => None,
            None => match claim {
                Some(claim) if lower(&request.known).contains(&claim) => Some(claim),
                _ => self.owner(&request.known),
            },
        };
        let Some(account) = account else {
            return Ok(Some(ExtensionCurrent::SignedIn {
                account_uuid: None,
                known: false,
                other: reading.other.then_some(true),
                expired,
                at,
            }));
        };
        self.ports
            .vault
            .save(&account, &reading.sign_in)
            .map_err(text)?;
        self.ports.vault.set_owner(&account).map_err(text)?;
        self.keep_web_login(
            &account,
            instance,
            peek,
            request.orgs.as_ref(),
            request.groups.as_deref(),
            expired.is_none(),
        );
        Ok(Some(ExtensionCurrent::SignedIn {
            account_uuid: Some(account),
            known: true,
            other: None,
            expired,
            at,
        }))
    }

    /// Keeps the profile's claude.ai login for `account` from a copy of the cookie files. A copy
    /// of a running browser's database can lag its memory, so a saved login is replaced only by a
    /// newer one the extension works with (`healthy`). A login of another account's organization
    /// is kept for that account instead (see `adopt`). Never fails.
    fn keep_web_login(
        &self,
        account: &str,
        instance: &ExtensionInstance,
        peek: &Path,
        orgs: Option<&HashMap<String, String>>,
        groups: Option<&[Vec<String>]>,
        healthy: bool,
    ) {
        let (Some(cookies), Some(cookie_vault)) = (&self.ports.cookies, &self.ports.cookie_vault)
        else {
            return;
        };
        if !cookies.available() {
            return;
        }
        let system = self.ports.system.as_ref();
        // Errors end the step quietly: the hints are saved; the login is kept at the next check.
        let _ = (|| -> Result<(), String> {
            let me = [account.to_owned()];
            let kept = cookie_vault.load(&me).ok().flatten();
            let listed = cookie_vault
                .list()
                .iter()
                .any(|x| x.account_uuid == account);
            let profile = data_dir(system, instance.app).join(&instance.profile);
            let copy = backup_cookie_files(&profile, peek).map_err(text)?;
            let web = cookies.read(&copy).map_err(text)?;
            if !has_web_login(&web) || !web.unlisted.is_empty() {
                return Ok(());
            }
            if let Some(found) = self.foreign_login(account, &web, orgs, groups) {
                self.adopt(account, &found, &web);
                return Ok(());
            }
            if listed && (!healthy || kept.as_ref().is_none_or(|kept| !newer(&web, kept))) {
                return Ok(());
            }
            let hints_at = system.modified_at(&extension_storage_dir(
                system,
                instance.app,
                &instance.profile,
            )?);
            if let (Some(created), Some(hints_at)) = (session_created_ms(&web), hints_at)
                && created as f64 > hints_at + OWNER_SLACK_MS
            {
                return Ok(());
            }
            cookie_vault.save(account, &web).map_err(text)?;
            if listed && let Some(hook) = &self.ports.on_fresh_login {
                hook(account, account);
            }
            Ok(())
        })();
    }

    /// Keeps a login found while the extension was on `account` for the account it belongs to: on
    /// the organization of exactly one other account (`Foreign.owner`), newer than the login saved
    /// for it, and never one the extension already failed with there. Never fails.
    fn adopt(&self, account: &str, found: &Foreign, web: &CookieSnapshot) {
        let Some(cookie_vault) = &self.ports.cookie_vault else {
            return;
        };
        let (ForeignWhy::OtherOrg, Some(owner)) = (found.why, &found.owner) else {
            return;
        };
        if cookie_vault.is_rejected(owner, web) {
            return;
        }
        let theirs = cookie_vault
            .load(std::slice::from_ref(owner))
            .ok()
            .flatten();
        if theirs.as_ref().is_some_and(|theirs| !newer(web, theirs)) {
            return;
        }
        // Kept at the next check or switch.
        if cookie_vault.save(owner, web).is_ok()
            && let Some(hook) = &self.ports.on_fresh_login
        {
            hook(owner, account);
        }
    }

    /// Whether the profile's claude.ai login is another account's, so it must not be kept as
    /// `account`'s: it is the login saved for another account, or it is on the organization of
    /// another account's saved login while the two accounts' organizations differ. A login the
    /// extension already failed to sign in to `account` with is never kept again either. Told to
    /// `on_foreign_login`. The organization of an account whose login was forgotten still counts
    /// (`CookieVault::orgs`).
    fn foreign_login(
        &self,
        account: &str,
        web: &CookieSnapshot,
        orgs: Option<&HashMap<String, String>>,
        groups: Option<&[Vec<String>]>,
    ) -> Option<Foreign> {
        let cookie_vault = self.ports.cookie_vault.as_ref()?;
        let found = |why: ForeignWhy, other: &str, owner: Option<String>| {
            if let Some(hook) = &self.ports.on_foreign_login {
                hook(account, other, why);
            }
            Some(Foreign { why, owner })
        };
        if cookie_vault.is_rejected(account, web) {
            return found(ForeignWhy::Rejected, account, None);
        }
        let group_of = |uuid: &str| -> Vec<String> {
            groups
                .and_then(|groups| groups.iter().find(|g| g.iter().any(|u| u == uuid)))
                .cloned()
                .unwrap_or_else(|| vec![uuid.to_owned()])
        };
        let me = group_of(account);
        // Saved logins' organizations, over those remembered.
        let mut known = cookie_vault.orgs();
        for saved in cookie_vault.list() {
            let other = saved.account_uuid;
            if me.contains(&other) {
                continue;
            }
            let Some(theirs) = cookie_vault
                .load(std::slice::from_ref(&other))
                .ok()
                .flatten()
            else {
                continue;
            };
            if same_login(web, &theirs) {
                return found(ForeignWhy::SameLogin, &other, None);
            }
            if let Some(org) = org_fingerprint(&theirs) {
                known.insert(other, org);
            }
        }
        let mine = orgs.and_then(|orgs| orgs.get(account))?;
        let fingerprint = org_fingerprint(web)?;
        let matches: Vec<&String> = known
            .iter()
            .filter(|(other, org)| {
                let theirs = orgs.and_then(|orgs| orgs.get(*other));
                **org == fingerprint
                    && !me.contains(other)
                    && theirs.is_some_and(|t| !t.is_empty() && t != mine)
            })
            .map(|(other, _)| other)
            .collect();
        let first = (*matches.first()?).clone();
        // One account (any of its uuids) on that organization: the login is that account's.
        let owners: HashSet<String> = matches
            .iter()
            .map(|uuid| group_of(uuid).join(" "))
            .collect();
        let owner = (owners.len() == 1).then(|| first.clone());
        found(ForeignWhy::OtherOrg, &first, owner)
    }

    /// The owner Relay remembers, when it is still one of its accounts.
    fn owner(&self, known: &[String]) -> Option<String> {
        let owner = self.ports.vault.owner().ok().flatten()?;
        lower(known).contains(&owner).then_some(owner)
    }

    /// The browser is closed. Backs up the extension's folder and the cookie files, saves the pair
    /// the profile holds (the extension's hints and its claude.ai login) for the account the hints
    /// name, and puts the target's pair in place. Both or neither: the extension refuses a web
    /// login that disagrees with its hints, so a half swap would leave it signed out.
    fn swap(
        &self,
        instance: &ExtensionInstance,
        request: &ExtensionRequest,
    ) -> Result<Core, String> {
        let system = self.ports.system.as_ref();
        let scratch = &self.ports.scratch;
        let cookie_scratch = self
            .ports
            .cookie_scratch
            .clone()
            .unwrap_or_else(|| suffixed(scratch, "-cookies"));
        let dir = extension_storage_dir(system, instance.app, &instance.profile)?;
        let profile = data_dir(system, instance.app).join(&instance.profile);
        clear_scratch(scratch);
        clear_scratch(&cookie_scratch);
        let mut keep_backup = false;
        let mut own: Vec<PathBuf> = Vec::new();
        // When the extension last wrote its hints: read before anything here opens its database,
        // which touches the folder and would make it "now".
        let hints_at = system.modified_at(&dir);
        let result = self.swap_inner(
            request,
            &dir,
            &profile,
            &cookie_scratch,
            hints_at,
            &mut own,
            &mut keep_backup,
        );
        if !keep_backup {
            // Only this run's backups go; those of an earlier failed restore stay (clear_scratch).
            for backup in &own {
                remove_backup(backup);
            }
            clear_scratch(scratch);
            clear_scratch(&cookie_scratch);
        }
        result
    }

    #[allow(clippy::too_many_arguments)]
    fn swap_inner(
        &self,
        request: &ExtensionRequest,
        dir: &Path,
        profile: &Path,
        cookie_scratch: &Path,
        hints_at: Option<f64>,
        own: &mut Vec<PathBuf>,
        keep_backup: &mut bool,
    ) -> Result<Core, String> {
        let ports = &self.ports;
        let (storage, vault, scratch) =
            (ports.storage.as_ref(), ports.vault.as_ref(), &ports.scratch);
        let cookies = ports.cookies.as_ref().ok_or("no cookie storage")?.as_ref();
        let cookie_vault = ports
            .cookie_vault
            .as_ref()
            .ok_or("no cookie vault")?
            .as_ref();
        let backup = backup_folder(dir, scratch).map_err(text)?;
        own.push(backup.clone());
        let cookie_backup = backup_cookie_files(profile, cookie_scratch).map_err(text)?;
        own.push(cookie_backup.clone());
        let mut saved = false;
        let entries = match storage.read(dir) {
            Ok(entries) => entries,
            Err(error) => {
                let reason = if error.reason == StorageReason::Locked {
                    ExtensionReason::Locked
                } else {
                    ExtensionReason::Unreadable
                };
                return Ok(Core::failed(reason, saved));
            }
        };
        let web = match cookies.read(profile) {
            Ok(web) => web,
            Err(error) => {
                let reason = match cookie_reason(&error) {
                    ExtensionReason::WriteFailed => ExtensionReason::Unreadable,
                    reason => reason,
                };
                return Ok(Core::failed(reason, saved));
            }
        };
        // A login cookie this build does not know: the layout changed, nothing is guessed.
        if !web.unlisted.is_empty() {
            if let Some(hook) = &ports.on_cookie_layout {
                let detail = IndexMap::from([
                    ("why".to_owned(), "unlisted".to_owned()),
                    ("names".to_owned(), web.unlisted.join(" ")),
                ]);
                hook(&detail);
            }
            return Ok(Core::skipped(ExtensionReason::SchemaChanged, saved));
        }
        let current = pick_sign_in(entry_refs(&entries), &request.known);
        // Data that names no account is the one Relay last knew the extension to be on.
        let account = current.as_ref().and_then(|current| match &current.account {
            Some(account) => Some(account.clone()),
            None if current.other => None,
            None => self.owner(&request.known),
        });
        if current.is_some() && account.is_none() {
            return Ok(Core::skipped(ExtensionReason::UnknownAccount, saved));
        }
        // An earlier swap stopped between its two writes: the hints and the login may be two
        // accounts', so nothing is saved from the profile; putting the target's pair in place
        // mends it.
        let interrupted = vault.swap_interrupted();
        // A web login nobody can name would be lost by the swap: its cookies are not saved anywhere.
        let web_login = has_web_login(&web);
        if web_login && account.is_none() {
            return Ok(Core::skipped(ExtensionReason::UnknownAccount, saved));
        }
        // A pair the extension already failed to sign in with is dead: saving it would put a login
        // back that expires again at the next switch to its account.
        let failed = session_expired(entry_refs(&entries));
        if let (Some(current), Some(account), false) = (&current, &account, interrupted) {
            // Another account's login is kept for that account, even when the extension failed
            // with it here: failing is what a login of another account does.
            let foreign = if web_login {
                self.foreign_login(
                    account,
                    &web,
                    request.orgs.as_ref(),
                    request.groups.as_deref(),
                )
            } else {
                None
            };
            if let Some(foreign) = &foreign {
                self.adopt(account, foreign, &web);
            }
            if !failed {
                // The web login belongs to the hints' account unless it is newer than the hints:
                // the user signed in to claude.ai again without the extension following. A login
                // named as another account's is not lost by the swap; one on an organization two
                // accounts share is nobody's for certain, so it still holds the swap.
                let named = foreign
                    .as_ref()
                    .is_some_and(|f| f.why != ForeignWhy::OtherOrg || f.owner.is_some());
                if web_login
                    && !named
                    && let (Some(created), Some(hints_at)) = (session_created_ms(&web), hints_at)
                    && created as f64 > hints_at + OWNER_SLACK_MS
                {
                    return Ok(Core::skipped(ExtensionReason::AmbiguousOwner, saved));
                }
                vault.save(account, &current.sign_in).map_err(text)?;
                vault.set_owner(account).map_err(text)?;
                // The hints are the account's; the login is kept only when it is not another
                // account's.
                if web_login && foreign.is_none() {
                    cookie_vault.save(account, &web).map_err(text)?;
                }
                saved = true;
            }
        }
        let write_reason = |failure: WriteFailure| -> ExtensionReason {
            match failure {
                WriteFailure::Cookie(error) => {
                    if let (Some(detail), Some(hook)) = (&error.detail, &ports.on_cookie_layout) {
                        hook(detail);
                    }
                    cookie_reason(&error)
                }
                WriteFailure::Storage(error) if error.reason == StorageReason::Mismatch => {
                    ExtensionReason::VerifyFailed
                }
                _ => ExtensionReason::WriteFailed,
            }
        };
        // Puts back what a failed write changed: the extension's folder, and the cookie files when
        // they were written too. False when that failed as well; the backups are then kept.
        let mut put_back = |with_cookies: bool| -> bool {
            let restored = (|| -> Result<(), String> {
                restore_folder(dir, &backup).map_err(text)?;
                if with_cookies {
                    restore_cookie_files(profile, &cookie_backup).map_err(text)?;
                    // Put back as it was, so the mark of an earlier interruption is not lost.
                    if !interrupted {
                        vault.clear_swap().map_err(text)?;
                    }
                }
                Ok(())
            })();
            if restored.is_err() {
                // Left for the user.
                *keep_backup = true;
                keep_scratch(scratch);
                if with_cookies {
                    keep_scratch(cookie_scratch);
                }
                return false;
            }
            true
        };
        let target = lower(&request.target);
        let on_target = account.as_ref().is_some_and(|a| target.contains(a)) && !interrupted;
        // On the account, but holding a stale record (`FAILURE_KEYS`): the extension would refuse
        // Claude's browser tools without trying again. The record goes and the rest is written
        // back as it is, so it signs in on its own with the profile's claude.ai login.
        if on_target
            && let Some(current) = &current
            && entries
                .iter()
                .any(|(key, _)| FAILURE_KEYS.contains(&key.as_str()))
        {
            if let Err(error) = storage.write(dir, &current.sign_in) {
                return Ok(if put_back(false) {
                    Core::failed(write_reason(WriteFailure::Storage(error)), saved)
                } else {
                    Core::failed(ExtensionReason::RestoreFailed, saved)
                });
            }
            let mut core = Core::new(
                ExtensionResult::Unchanged,
                ExtensionReason::AlreadyThere,
                saved,
            );
            core.cleared = Some(true);
            return Ok(core);
        }
        let wanted: Option<SignIn> = vault.load(&request.target).map_err(text)?;
        let wanted_web = cookie_vault.load(&request.target).map_err(text)?;
        let listed = vault.list();
        // Only a complete pair is put in place.
        let (Some(wanted), Some(wanted_web)) = (wanted, wanted_web) else {
            let result = if saved {
                ExtensionResult::Saved
            } else {
                ExtensionResult::Unchanged
            };
            return Ok(Core::new(result, ExtensionReason::NoSavedLogin, saved));
        };
        if on_target {
            return Ok(Core::new(
                ExtensionResult::Unchanged,
                ExtensionReason::AlreadyThere,
                saved,
            ));
        }
        // A login left unused until its cookie ended: the browser would drop it on start and the
        // extension sign out. It is forgotten and the account waits for a reconnect instead.
        if let Some(ends) = session_expires_ms(&wanted_web)
            && ends <= self.now()
        {
            for uuid in &target {
                if cookie_vault.list().iter().any(|x| x.account_uuid == *uuid) {
                    cookie_vault.reject(uuid).map_err(text)?;
                    break;
                }
            }
            return Ok(Core::skipped(ExtensionReason::LoginExpired, saved));
        }
        let written = (|| -> Result<(), WriteFailure> {
            vault.mark_swap().map_err(|_| WriteFailure::Other)?;
            storage.write(dir, &wanted).map_err(WriteFailure::Storage)?;
            cookies
                .write(profile, &wanted_web)
                .map_err(WriteFailure::Cookie)?;
            Ok(())
        })();
        if let Err(failure) = written {
            return Ok(if put_back(true) {
                Core::failed(write_reason(failure), saved)
            } else {
                Core::failed(ExtensionReason::RestoreFailed, saved)
            });
        }
        if let Some(placed) = target
            .iter()
            .find(|uuid| listed.iter().any(|x| x.account_uuid == **uuid))
        {
            vault.set_owner(placed).map_err(text)?;
        }
        vault.clear_swap().map_err(text)?;
        Ok(Core {
            result: ExtensionResult::Switched,
            reason: None,
            saved,
            cleared: None,
            current: None,
        })
    }
}
