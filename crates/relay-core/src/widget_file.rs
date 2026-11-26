//! Port of `electron/core/widget-file.ts`.

use std::path::{Path, PathBuf};

use crate::continuation_journal::{
    MAX_BYTES, PrivateJsonError, private_journal_directory, write_private_json,
};
use crate::shared::widget_snapshot::{WidgetSnapshot, widget_visible_key};

/// The widget kinds in RelayWidget.swift; a reload asks for all of them at once.
pub const WIDGET_KINDS: [&str; 5] = [
    "RelayToday",
    "RelayAccount",
    "RelayAccounts",
    "RelayAccountsToday",
    "RelayWeek",
];
/// Reloads are budgeted by the system (roughly 40–70 a day for an app in the background): at most
/// one this often, unless the day, the language or the account open in Claude changed.
pub const WIDGET_RELOAD_MS: f64 = 15.0 * 60_000.0;

/// Reloads every widget of Relay's; an error is ignored (the widget refreshes itself every 15
/// minutes anyway).
pub type WidgetReload = Box<dyn Fn() -> Result<(), String> + Send>;

/// Writes the widget's file, `<dir>/today.json`, and asks the system to redraw the widget when
/// what it shows changed. The directory holds nothing else: the widget's sandbox may read this one
/// directory of Relay's data.
pub struct WidgetFile {
    dir: PathBuf,
    file: PathBuf,
    reload: Option<WidgetReload>,
    now: Box<dyn Fn() -> f64 + Send>,
    reloaded_key: Option<String>,
    reloaded_date: Option<String>,
    reloaded_active: Option<String>,
    reloaded_at: f64,
}

impl WidgetFile {
    /// `now` defaults to the wall clock.
    pub fn new(
        dir: impl AsRef<Path>,
        reload: Option<WidgetReload>,
        now: Option<Box<dyn Fn() -> f64 + Send>>,
    ) -> Self {
        let dir = dir.as_ref().to_path_buf();
        WidgetFile {
            file: dir.join("today.json"),
            dir,
            reload,
            now: now.unwrap_or_else(|| Box::new(|| crate::clock::now_ms() as f64)),
            reloaded_key: None,
            reloaded_date: None,
            reloaded_active: None,
            reloaded_at: f64::NEG_INFINITY,
        }
    }

    /// The file the widget reads.
    pub fn file(&self) -> &Path {
        &self.file
    }

    /// `force`: reload now whatever the throttle says, as for a new language.
    pub fn write(
        &mut self,
        snapshot: &WidgetSnapshot,
        force: bool,
    ) -> Result<(), PrivateJsonError> {
        private_journal_directory(&self.dir)?;
        write_private_json(&self.file, snapshot, MAX_BYTES)?;
        let Some(reload) = &self.reload else {
            return Ok(());
        };
        let key = widget_visible_key(snapshot);
        if self.reloaded_key.as_deref() == Some(key.as_str()) {
            return Ok(());
        }
        let now = (self.now)();
        let active = snapshot.active.as_ref().map(|a| a.id.clone());
        if !force
            && Some(&snapshot.date) == self.reloaded_date.as_ref()
            && active == self.reloaded_active
            && now - self.reloaded_at < WIDGET_RELOAD_MS
        {
            return Ok(());
        }
        self.reloaded_key = Some(key);
        self.reloaded_date = Some(snapshot.date.clone());
        self.reloaded_active = active;
        self.reloaded_at = now;
        // The widget refreshes itself every 15 minutes anyway.
        let _ = reload();
        Ok(())
    }
}
