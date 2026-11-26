//! Port of `electron/core/meters/index.ts`: the meters turned on in Settings → Other tools, read
//! in the background. Each is read when it is turned on and then at most every interval (later
//! when the provider asked to wait), never while off. A failed read keeps the windows of the
//! read before it and says why beside them. The readings carry no token: the readers keep
//! theirs to the request.

pub mod common;
pub mod copilot;
pub mod cursor;
pub mod gemini_cli;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use crate::clock::now_ms;
use crate::shared::meters::{
    METER_INTERVAL_MS, METER_PROVIDERS, MeterProvider, MeterReading, MeterReadingError, MeterSource,
};
use crate::shared::types::js::iso;
use common::{MeterError, MeterRead, MeterReaderOptions};

/// One meter's reader.
pub type MeterReader = Arc<dyn Fn() -> Result<MeterRead, MeterError> + Send + Sync>;
/// A line for the private log.
pub type MeterLog = Arc<dyn Fn(&str) + Send + Sync>;

/// Each meter's reader; every one reads an endpoint the tool itself uses, none a documented
/// API.
pub fn meter_reader(provider: MeterProvider) -> MeterReader {
    match provider {
        MeterProvider::Copilot => {
            Arc::new(|| copilot::read_copilot(&MeterReaderOptions::default(), None))
        }
        MeterProvider::Cursor => Arc::new(|| cursor::read_cursor(&MeterReaderOptions::default())),
        MeterProvider::GeminiCli => {
            Arc::new(|| gemini_cli::read_gemini_cli(&MeterReaderOptions::default()))
        }
    }
}

fn source(_provider: MeterProvider) -> MeterSource {
    MeterSource::Unofficial
}

/// How often the service asks whether a meter is due; the meter itself reads at most every
/// interval.
const CHECK_MS: u64 = 60_000;

/// What the service reads with.
#[derive(Clone)]
pub struct MeterServiceOptions {
    pub enabled: Arc<dyn Fn() -> Vec<MeterProvider> + Send + Sync>,
    /// Stand-ins for the default readers.
    pub readers: HashMap<MeterProvider, MeterReader>,
    pub now: Option<Arc<dyn Fn() -> f64 + Send + Sync>>,
    pub interval_ms: Option<f64>,
    /// A reading changed: the windows are told to read the snapshot again.
    pub on_change: Option<Arc<dyn Fn() + Send + Sync>>,
    /// A failed read, redacted: the meter, the step and a status.
    pub log: Option<MeterLog>,
}

impl MeterServiceOptions {
    pub fn new(enabled: impl Fn() -> Vec<MeterProvider> + Send + Sync + 'static) -> Self {
        MeterServiceOptions {
            enabled: Arc::new(enabled),
            readers: HashMap::new(),
            now: None,
            interval_ms: None,
            on_change: None,
            log: None,
        }
    }
}

#[derive(Default)]
struct State {
    readings: HashMap<MeterProvider, MeterReading>,
    /// The earliest time each meter may be read again; kept while it is off, so off and on
    /// again does not read sooner.
    due: HashMap<MeterProvider, f64>,
}

struct Inner {
    options: MeterServiceOptions,
    state: Mutex<State>,
    /// A pass under way; a tick during it waits for it instead of starting another.
    running: Mutex<bool>,
    ended: Condvar,
    timer: Mutex<Option<Arc<AtomicBool>>>,
}

/// The meters service. Clones share it.
#[derive(Clone)]
pub struct MeterService(Arc<Inner>);

impl MeterService {
    pub fn new(options: MeterServiceOptions) -> Self {
        MeterService(Arc::new(Inner {
            options,
            state: Mutex::new(State::default()),
            running: Mutex::new(false),
            ended: Condvar::new(),
            timer: Mutex::new(None),
        }))
    }

    fn now(&self) -> f64 {
        self.0
            .options
            .now
            .as_ref()
            .map_or_else(|| now_ms() as f64, |now| now())
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.0.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The enabled meters' readings in Relay's order; one not read yet has no windows and no
    /// `read_at`.
    pub fn snapshot(&self) -> Vec<MeterReading> {
        let enabled = (self.0.options.enabled)();
        let state = self.state();
        METER_PROVIDERS
            .into_iter()
            .filter(|p| enabled.contains(p))
            .map(|provider| {
                state
                    .readings
                    .get(&provider)
                    .cloned()
                    .unwrap_or_else(|| blank(provider))
            })
            .collect()
    }

    /// Reads every enabled meter that is due; one pass at a time.
    pub fn tick(&self) {
        {
            let mut running = self.0.running.lock().unwrap_or_else(|e| e.into_inner());
            if *running {
                while *running {
                    running = self
                        .0
                        .ended
                        .wait(running)
                        .unwrap_or_else(|e| e.into_inner());
                }
                return;
            }
            *running = true;
        }
        self.pass();
        *self.0.running.lock().unwrap_or_else(|e| e.into_inner()) = false;
        self.0.ended.notify_all();
    }

    fn pass(&self) {
        let enabled = (self.0.options.enabled)();
        let now = self.now();
        let due: Vec<MeterProvider> = {
            let state = self.state();
            METER_PROVIDERS
                .into_iter()
                .filter(|p| enabled.contains(p) && state.due.get(p).copied().unwrap_or(0.0) <= now)
                .collect()
        };
        if due.is_empty() {
            return;
        }
        std::thread::scope(|scope| {
            for provider in &due {
                scope.spawn(move || self.read(*provider));
            }
        });
        if let Some(on_change) = &self.0.options.on_change {
            on_change();
        }
    }

    fn read(&self, provider: MeterProvider) {
        let interval = self
            .0
            .options
            .interval_ms
            .unwrap_or(METER_INTERVAL_MS as f64);
        let reader = self
            .0
            .options
            .readers
            .get(&provider)
            .cloned()
            .unwrap_or_else(|| meter_reader(provider));
        // Set before the read, so a read that hangs is not started again by the next tick.
        let before = {
            let mut state = self.state();
            state.due.insert(provider, self.now() + interval);
            state.readings.get(&provider).cloned()
        };
        match reader() {
            Ok(read) => {
                let reading = MeterReading {
                    provider,
                    label: read.label.filter(|l| !l.is_empty()),
                    windows: read.windows,
                    source: source(provider),
                    read_at: Some(iso(self.now())),
                    error: None,
                };
                self.state().readings.insert(provider, reading);
            }
            Err(failure) => {
                let now = self.now();
                if before
                    .as_ref()
                    .and_then(|b| b.error.as_ref())
                    .map(|e| e.issue)
                    != Some(failure.issue)
                    && let Some(log) = &self.0.options.log
                {
                    let detail = failure
                        .detail
                        .as_deref()
                        .map_or(String::new(), |d| format!(" ({d})"));
                    log(&format!(
                        "{}: {}{detail}",
                        provider.as_str(),
                        common::issue_text(failure.issue)
                    ));
                }
                let mut state = self.state();
                if let Some(retry_at) = failure.retry_at {
                    state.due.insert(provider, retry_at.max(now + interval));
                }
                let mut reading = before.unwrap_or_else(|| blank(provider));
                reading.error = Some(MeterReadingError {
                    issue: failure.issue,
                    retry_at: failure.retry_at.map(iso),
                });
                state.readings.insert(provider, reading);
            }
        }
    }

    /// Reads now, then checks every minute until `stop`.
    pub fn start(&self) {
        let mut timer = self.0.timer.lock().unwrap_or_else(|e| e.into_inner());
        if timer.is_none() {
            let stopped = Arc::new(AtomicBool::new(false));
            *timer = Some(stopped.clone());
            let service = self.clone();
            std::thread::spawn(move || {
                loop {
                    std::thread::sleep(Duration::from_millis(CHECK_MS));
                    if stopped.load(Ordering::SeqCst) {
                        break;
                    }
                    service.tick();
                }
            });
        }
        drop(timer);
        let service = self.clone();
        std::thread::spawn(move || service.tick());
    }

    pub fn stop(&self) {
        if let Some(stopped) = self
            .0
            .timer
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            stopped.store(true, Ordering::SeqCst);
        }
    }
}

fn blank(provider: MeterProvider) -> MeterReading {
    MeterReading {
        provider,
        label: None,
        windows: Vec::new(),
        source: source(provider),
        read_at: None,
        error: None,
    }
}
