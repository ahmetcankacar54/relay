//! Port of `electron/core/auto-capture.ts`: saves a Claude app sign-in by itself once it is
//! complete.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};

use crate::desktop::{DesktopError, DesktopResult};
use crate::shared::types::{Account, AutoCaptureState, AutoCaptureStatus, DesktopState};
use crate::sign_in_wait::{SignInReading, read_sign_in};

/// What the automatic save needs of the app.
pub trait AutoCaptureDeps: Send + Sync {
    fn snapshot(&self) -> DesktopResult<DesktopState>;
    fn accounts(&self) -> Vec<Account>;
    /// Saves the Claude app sign-in into the profile; quits and reopens Claude. Fails with
    /// [`DesktopError::SignInNotSettled`] when the sign-in is not in the cookie file yet
    /// (`desktop_session::SignInNotSettled`).
    fn capture(&self, account_id: &str, org_id: &str) -> DesktopResult<()>;
    /// Something the main window shows changed.
    fn changed(&self);
    fn now(&self) -> f64;
}

/// How long Relay waits for the sign-in before it gives up; the sign-in itself stays pending.
pub const AUTO_CAPTURE_LIMIT_MS: f64 = 30.0 * 60_000.0;

/// `choose` with a workspace the sign-in does not have.
pub const UNKNOWN_WORKSPACE: &str = "Unknown workspace.";

/// The armed sign-in; `generation` stands for the TS object's identity, new at every change.
struct Current {
    state: AutoCaptureState,
    since: f64,
    generation: u64,
}

/// Saves a Claude app sign-in by itself once it is complete, so adding an account needs one
/// confirmation at the start instead of a second "Save sign-in": the user signs in to the Claude
/// app and opens Code, and the next tick captures it (Claude restarts once more, as the first
/// confirmation said). With several Code workspaces it saves the one the Claude app is in, and
/// waits for the user to pick one only when nothing says which that is. Armed for
/// one profile at a time, in memory: after a Relay restart the pending sign-in is saved by hand.
pub struct AutoCapture {
    deps: Box<dyn AutoCaptureDeps>,
    current: Mutex<Option<Current>>,
    generations: Mutex<u64>,
    running: AtomicBool,
}

impl AutoCapture {
    pub fn new(deps: impl AutoCaptureDeps + 'static) -> AutoCapture {
        AutoCapture {
            deps: Box::new(deps),
            current: Mutex::new(None),
            generations: Mutex::new(0),
            running: AtomicBool::new(false),
        }
    }

    fn current(&self) -> MutexGuard<'_, Option<Current>> {
        self.current.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn next_generation(&self) -> u64 {
        let mut generations = self
            .generations
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        *generations += 1;
        *generations
    }

    /// The armed account's save in its current step, if one is armed.
    pub fn state(&self) -> Option<AutoCaptureState> {
        self.current().as_ref().map(|current| current.state.clone())
    }

    pub fn arm(&self, account_id: &str) {
        let generation = self.next_generation();
        *self.current() = Some(Current {
            state: AutoCaptureState {
                account_id: account_id.to_string(),
                status: AutoCaptureStatus::Waiting,
                orgs: None,
                suggested_org: None,
                already_saved: None,
                error: None,
            },
            since: self.deps.now(),
            generation,
        });
        self.deps.changed();
    }

    /// Disarms `account_id`'s save, or any save when `None`.
    pub fn disarm(&self, account_id: Option<&str>) {
        {
            let mut current = self.current();
            if let Some(id) = account_id.filter(|id| !id.is_empty())
                && current.as_ref().map(|c| c.state.account_id.as_str()) != Some(id)
            {
                return;
            }
            *current = None;
        }
        self.deps.changed();
    }

    /// The user picked the workspace of a sign-in that has several.
    pub fn choose(&self, account_id: &str, org_id: &str) -> DesktopResult<()> {
        {
            let current = self.current();
            let Some(current) = current.as_ref().filter(|c| {
                c.state.account_id == account_id && c.state.status == AutoCaptureStatus::ChooseOrg
            }) else {
                return Ok(());
            };
            if !current
                .state
                .orgs
                .as_ref()
                .is_some_and(|orgs| orgs.iter().any(|org| org == org_id))
            {
                return Err(DesktopError::new(UNKNOWN_WORKSPACE));
            }
        }
        self.save(account_id, org_id);
        Ok(())
    }

    /// One look; safe to call on a timer, never overlaps itself.
    pub fn tick(&self) {
        let (armed, since, generation) = {
            let current = self.current();
            let Some(current) = current.as_ref() else {
                return;
            };
            (current.state.clone(), current.since, current.generation)
        };
        if self.running.load(Ordering::SeqCst) || armed.status == AutoCaptureStatus::Saving {
            return;
        }
        if matches!(
            armed.status,
            AutoCaptureStatus::Saved | AutoCaptureStatus::Failed
        ) {
            return;
        }
        if self.deps.now() - since > AUTO_CAPTURE_LIMIT_MS {
            self.set(|s| {
                s.status = AutoCaptureStatus::Failed;
                s.error = Some("timeout".into());
            });
            return;
        }
        if self.running.swap(true, Ordering::SeqCst) {
            return;
        }
        // A reading that failed is tried again at the next tick.
        if let Ok(snapshot) = self.deps.snapshot() {
            let reading = read_sign_in(&snapshot, &self.deps.accounts(), &armed.account_id);
            if self.current().as_ref().map(|c| c.generation) == Some(generation) {
                self.apply(&armed, reading);
            }
        }
        self.running.store(false, Ordering::SeqCst);
    }

    fn apply(&self, armed: &AutoCaptureState, reading: SignInReading) {
        match reading {
            SignInReading::OtherPending => self.set(|s| {
                s.status = AutoCaptureStatus::Failed;
                s.error = Some("other-pending".into());
            }),
            SignInReading::Done => self.set(|s| s.status = AutoCaptureStatus::Saved),
            SignInReading::SavedElsewhere { account } => {
                if armed.already_saved.as_deref() != Some(account.name.as_str()) {
                    self.set(|s| {
                        s.status = AutoCaptureStatus::Waiting;
                        s.already_saved = Some(account.name.clone());
                    });
                }
            }
            SignInReading::Waiting => {
                if armed
                    .already_saved
                    .as_deref()
                    .is_some_and(|n| !n.is_empty())
                {
                    self.set(|s| {
                        s.status = AutoCaptureStatus::Waiting;
                        s.already_saved = None;
                    });
                }
            }
            SignInReading::Ready {
                orgs,
                preferred,
                suggested,
                ..
            } => {
                // Several workspaces: the one the Claude app is in is saved without asking; a
                // blind choice binds the profile to a workspace its usage sign-in can never match.
                if orgs.len() > 1 && preferred.as_deref().is_none_or(str::is_empty) {
                    if armed.status != AutoCaptureStatus::ChooseOrg
                        || armed.suggested_org != suggested
                    {
                        self.set(|s| {
                            s.status = AutoCaptureStatus::ChooseOrg;
                            s.orgs = Some(orgs);
                            s.suggested_org = suggested;
                            s.already_saved = None;
                        });
                    }
                    return;
                }
                let org = preferred
                    .or_else(|| orgs.into_iter().next())
                    .unwrap_or_default();
                self.save(&armed.account_id, &org);
            }
        }
    }

    fn is_armed(&self, account_id: &str) -> bool {
        self.current()
            .as_ref()
            .is_some_and(|c| c.state.account_id == account_id)
    }

    fn save(&self, account_id: &str, org_id: &str) {
        self.set(|s| {
            s.status = AutoCaptureStatus::Saving;
            s.already_saved = None;
        });
        match self.deps.capture(account_id, org_id) {
            Ok(()) => {
                if self.is_armed(account_id) {
                    self.set(|s| {
                        s.status = AutoCaptureStatus::Saved;
                        s.orgs = None;
                        s.suggested_org = None;
                    });
                }
            }
            // The sign-in is not in Claude's cookie file yet; nothing was quit. The next tick
            // saves it.
            Err(DesktopError::SignInNotSettled(_)) => {
                if self.is_armed(account_id) {
                    self.set(|s| s.status = AutoCaptureStatus::Waiting);
                }
            }
            Err(error) => {
                if self.is_armed(account_id) {
                    self.set(|s| {
                        s.status = AutoCaptureStatus::Failed;
                        s.error = Some(error.to_string());
                    });
                }
            }
        }
    }

    fn set(&self, patch: impl FnOnce(&mut AutoCaptureState)) {
        {
            let mut current = self.current();
            let Some(current) = current.as_mut() else {
                return;
            };
            patch(&mut current.state);
            current.generation = self.next_generation();
        }
        self.deps.changed();
    }
}
