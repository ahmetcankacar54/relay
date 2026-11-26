//! Port of `electron/core/tray-refresh.ts`: one tray refresh. Only a failed snapshot rests the
//! panda; a failing panda never turns a healthy snapshot into the fallback menu. Never fails.

/// The steps of a refresh; each fails alone.
pub trait TrayRefreshSteps {
    type Snapshot;
    type Error;
    /// Still the newest refresh of a live tray.
    fn current(&mut self) -> bool;
    fn snapshot(&mut self) -> Result<Self::Snapshot, Self::Error>;
    /// The menu bar panda's next pose; it never decides what the menu shows. No panda: nothing.
    fn mascot_next(&mut self, _snapshot: &Self::Snapshot) -> Result<(), Self::Error> {
        Ok(())
    }
    /// The panda rests: the snapshot could not be read.
    fn mascot_unavailable(&mut self) -> Result<(), Self::Error> {
        Ok(())
    }
    /// Title, tooltip and menu for a snapshot.
    fn show(&mut self, snapshot: &Self::Snapshot) -> Result<(), Self::Error>;
    /// The fallback menu when the snapshot or its menu could not be built.
    fn unavailable(&mut self) -> Result<(), Self::Error>;
}

/// One tray refresh. A step that fails leaves the tray with what it had.
pub fn refresh_tray<S: TrayRefreshSteps>(steps: &mut S) {
    let snapshot = match steps.snapshot() {
        Ok(snapshot) => snapshot,
        Err(_) => {
            if !steps.current() {
                return;
            }
            let _ = steps.mascot_unavailable();
            let _ = steps.unavailable();
            return;
        }
    };
    if !steps.current() {
        return;
    }
    let _ = steps.mascot_next(&snapshot);
    if steps.show(&snapshot).is_err() {
        let _ = steps.unavailable();
    }
}
