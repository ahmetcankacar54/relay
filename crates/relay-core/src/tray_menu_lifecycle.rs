//! Port of `electron/core/tray-menu-lifecycle.ts`. Replacing a macOS tray menu releases its native
//! controller, which cancels an open menu. Keep the current menu until tracking has ended, and
//! avoid replacing it at all when polling produces the same visible items and commands.
//!
//! The TS `schedule(callback)` becomes `TrayMenuHost::schedule(generation)`: the host runs
//! `TrayMenuLifecycle::run_scheduled(generation)` on its next event-loop turn.

/// What the lifecycle installs menus with.
pub trait TrayMenuHost<T> {
    type Error;
    /// Installs `value` as the native menu of `generation`.
    fn apply(&mut self, value: T, generation: u64) -> Result<(), Self::Error>;
    /// Calls `run_scheduled(generation)` on the next event-loop turn, after the native close
    /// callback has returned.
    fn schedule(&mut self, generation: u64);
    /// A deferred install failed.
    fn on_apply_error(&mut self, _error: Self::Error) {}
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Installed {
    fingerprint: String,
    generation: u64,
}

pub struct TrayMenuLifecycle<T, H: TrayMenuHost<T>> {
    host: H,
    current: Option<Installed>,
    /// The newest menu waiting for the open one to close, with its fingerprint.
    pending: Option<(T, String)>,
    generation: u64,
    open_generation: Option<u64>,
    closing_generation: Option<u64>,
    destroyed: bool,
}

impl<T, H: TrayMenuHost<T>> TrayMenuLifecycle<T, H> {
    pub fn new(host: H) -> Self {
        TrayMenuLifecycle {
            host,
            current: None,
            pending: None,
            generation: 0,
            open_generation: None,
            closing_generation: None,
            destroyed: false,
        }
    }

    pub fn host(&self) -> &H {
        &self.host
    }

    pub fn host_mut(&mut self) -> &mut H {
        &mut self.host
    }

    fn current_generation(&self) -> Option<u64> {
        self.current.as_ref().map(|c| c.generation)
    }

    /// A new poll's menu. An install that fails here is the caller's error.
    pub fn update(&mut self, value: T, fingerprint: &str) -> Result<(), H::Error> {
        if self.destroyed {
            return Ok(());
        }
        if self.current.as_ref().map(|c| c.fingerprint.as_str()) == Some(fingerprint) {
            // The newest poll may undo a change queued while the menu was open.
            self.pending = None;
            return Ok(());
        }
        if self.open_generation.is_some() || self.closing_generation.is_some() {
            self.pending = Some((value, fingerprint.to_string()));
            return Ok(());
        }
        self.install(value, fingerprint.to_string())
    }

    pub fn opened(&mut self, generation: u64) {
        if self.destroyed || self.current_generation() != Some(generation) {
            return;
        }
        self.open_generation = Some(generation);
    }

    pub fn closed(&mut self, generation: u64) {
        if self.destroyed
            || self.current_generation() != Some(generation)
            || self.open_generation != Some(generation)
        {
            return;
        }
        self.open_generation = None;
        // Even a poll arriving from another close listener must wait until the native close
        // callback has returned. The menu may reopen before this runs.
        self.closing_generation = Some(generation);
        self.host.schedule(generation);
    }

    /// The turn after `closed(generation)`: installs the newest pending menu unless the menu
    /// reopened or was replaced meanwhile.
    pub fn run_scheduled(&mut self, generation: u64) {
        if self.destroyed
            || self.current_generation() != Some(generation)
            || self.closing_generation != Some(generation)
        {
            return;
        }
        self.closing_generation = None;
        if self.open_generation.is_some() {
            return;
        }
        let Some((value, fingerprint)) = self.pending.take() else {
            return;
        };
        if self.current.as_ref().map(|c| &c.fingerprint) == Some(&fingerprint) {
            return;
        }
        if let Err(error) = self.install(value, fingerprint) {
            self.host.on_apply_error(error);
        }
    }

    pub fn destroy(&mut self) {
        self.destroyed = true;
        self.pending = None;
        self.open_generation = None;
        self.closing_generation = None;
    }

    fn install(&mut self, value: T, fingerprint: String) -> Result<(), H::Error> {
        self.generation += 1;
        let generation = self.generation;
        let previous = self.current.replace(Installed {
            fingerprint,
            generation,
        });
        if let Err(error) = self.host.apply(value, generation) {
            self.current = previous;
            return Err(error);
        }
        Ok(())
    }
}
