//! Port of electron/window-release.ts: frees a window's page once it has stayed hidden a while.
//! Opening it again loads the page anew (under a second); a window still busy waits another round.

use std::sync::{Arc, Mutex};
use std::time::Duration;

/// How long a closed main window stays loaded, so opening it again at once is instant.
pub const WINDOW_RELEASE_MS: u64 = 60_000;

/// Runs a callback after a delay (a thread by default; tests hold the callbacks).
pub type Schedule = Box<dyn Fn(Duration, Box<dyn FnOnce() + Send>) + Send + Sync>;

pub struct WindowReleaseOptions {
    /// The window exists and is not on screen.
    pub hidden: Box<dyn Fn() -> bool + Send + Sync>,
    /// Something still reports to the window: a sign-in or a Desktop operation.
    pub busy: Box<dyn Fn() -> bool + Send + Sync>,
    /// Destroys the window; the next show creates it again.
    pub release: Box<dyn Fn() + Send + Sync>,
    pub delay: Duration,
    pub schedule: Schedule,
}

impl WindowReleaseOptions {
    /// `WINDOW_RELEASE_MS` on a timer thread.
    pub fn new(
        hidden: impl Fn() -> bool + Send + Sync + 'static,
        busy: impl Fn() -> bool + Send + Sync + 'static,
        release: impl Fn() + Send + Sync + 'static,
    ) -> Self {
        WindowReleaseOptions {
            hidden: Box::new(hidden),
            busy: Box::new(busy),
            release: Box::new(release),
            delay: Duration::from_millis(WINDOW_RELEASE_MS),
            schedule: Box::new(after),
        }
    }
}

/// Runs `run` on its own thread after `delay`; the thread never keeps the app from quitting.
pub fn after(delay: Duration, run: Box<dyn FnOnce() + Send>) {
    std::thread::spawn(move || {
        std::thread::sleep(delay);
        run();
    });
}

#[derive(Clone)]
pub struct WindowRelease {
    options: Arc<WindowReleaseOptions>,
    /// The running timer's number; a timer whose number is no longer this one does nothing.
    timer: Arc<Mutex<Option<u64>>>,
    next: Arc<Mutex<u64>>,
}

impl WindowRelease {
    pub fn new(options: WindowReleaseOptions) -> Self {
        WindowRelease {
            options: Arc::new(options),
            timer: Arc::new(Mutex::new(None)),
            next: Arc::new(Mutex::new(0)),
        }
    }

    /// The window was hidden: release it later unless it is shown first.
    pub fn arm(&self) {
        let id = {
            let mut next = crate::state::lock(&self.next);
            *next += 1;
            *next
        };
        *crate::state::lock(&self.timer) = Some(id);
        let this = self.clone();
        (self.options.schedule)(self.options.delay, Box::new(move || this.fire(id)));
    }

    /// The window was shown or is gone.
    pub fn cancel(&self) {
        *crate::state::lock(&self.timer) = None;
    }

    /// A timer is running.
    pub fn armed(&self) -> bool {
        crate::state::lock(&self.timer).is_some()
    }

    fn fire(&self, id: u64) {
        {
            let mut timer = crate::state::lock(&self.timer);
            if *timer != Some(id) {
                return;
            }
            *timer = None;
        }
        if !(self.options.hidden)() {
            return;
        }
        if (self.options.busy)() {
            return self.arm();
        }
        (self.options.release)();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    type Timers = Arc<Mutex<Vec<(Duration, Option<Box<dyn FnOnce() + Send>>)>>>;

    struct Harness {
        release: WindowRelease,
        timers: Timers,
        released: Arc<AtomicUsize>,
        hidden: Arc<AtomicBool>,
        busy: Arc<AtomicBool>,
    }

    fn harness(hidden: bool, busy: bool) -> Harness {
        let timers: Timers = Arc::default();
        let released = Arc::new(AtomicUsize::new(0));
        let hidden = Arc::new(AtomicBool::new(hidden));
        let busy = Arc::new(AtomicBool::new(busy));
        let (h, b, r, t) = (
            hidden.clone(),
            busy.clone(),
            released.clone(),
            timers.clone(),
        );
        let release = WindowRelease::new(WindowReleaseOptions {
            hidden: Box::new(move || h.load(Ordering::SeqCst)),
            busy: Box::new(move || b.load(Ordering::SeqCst)),
            release: Box::new(move || {
                r.fetch_add(1, Ordering::SeqCst);
            }),
            delay: Duration::from_millis(WINDOW_RELEASE_MS),
            schedule: Box::new(move |delay, run| t.lock().unwrap().push((delay, Some(run)))),
        });
        Harness {
            release,
            timers,
            released,
            hidden,
            busy,
        }
    }

    impl Harness {
        /// The newest timer fires.
        fn fire(&self) {
            let run = self
                .timers
                .lock()
                .unwrap()
                .last_mut()
                .unwrap()
                .1
                .take()
                .unwrap();
            run();
        }
        fn released(&self) -> usize {
            self.released.load(Ordering::SeqCst)
        }
    }

    #[test]
    fn a_window_still_hidden_after_the_delay_is_released() {
        let h = harness(true, false);
        h.release.arm();
        assert!(h.release.armed());
        assert_eq!(h.timers.lock().unwrap()[0].0, Duration::from_millis(60_000));
        h.fire();
        assert_eq!(h.released(), 1);
    }

    #[test]
    fn showing_the_window_again_cancels_the_release() {
        let h = harness(true, false);
        h.release.arm();
        h.release.cancel();
        assert!(!h.release.armed());
        h.fire();
        assert_eq!(h.released(), 0);
    }

    #[test]
    fn a_window_shown_by_the_time_the_timer_fires_is_kept() {
        let h = harness(true, false);
        h.release.arm();
        h.hidden.store(false, Ordering::SeqCst);
        h.fire();
        assert_eq!(h.released(), 0);
        assert!(!h.release.armed());
    }

    #[test]
    fn a_busy_window_waits_another_round_then_goes_once_idle() {
        let h = harness(true, true);
        h.release.arm();
        h.fire();
        assert_eq!(h.released(), 0);
        assert!(h.release.armed(), "re-armed");
        h.busy.store(false, Ordering::SeqCst);
        h.fire();
        assert_eq!(h.released(), 1);
    }

    #[test]
    fn arming_twice_keeps_one_timer() {
        let h = harness(true, false);
        h.release.arm();
        h.release.arm();
        // The first timer is stale: only the second releases.
        let first = h.timers.lock().unwrap()[0].1.take().unwrap();
        first();
        assert_eq!(h.released(), 0);
        h.fire();
        assert_eq!(h.released(), 1);
    }
}
