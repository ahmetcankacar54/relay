//! The token ledger's scan, and the widget and menu bar figures written from it (port of
//! electron/main/tokens-widget.ts).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, LazyLock, Mutex};
use std::time::Duration;

use relay_core::desktop_windows::SessionOwner;
use relay_core::shared::limit_calibration::{
    CalibrationInput, CostSlots, LimitCalibration, SlotCost, calibrate_limits,
};
use relay_core::shared::planning::{local_date, wall_time};
use relay_core::shared::tempo::tempo_at;
use relay_core::shared::token_usage_view::{TokenUsageInput, build_token_usage_view};
use relay_core::shared::tray::TrayToday;
use relay_core::shared::types::Account;
use relay_core::shared::types::js::{JsMap, date_parse, iso};
use relay_core::shared::usage_statistics::UsageSample;
use relay_core::shared::usage_statistics_view::{
    StatisticsInput, StatisticsStatus, build_statistics_view,
};
use relay_core::shared::widget_snapshot::{
    WidgetLimits, WidgetProgress, WidgetSnapshotInput, build_widget_snapshot,
};
use relay_core::token_attribution::{
    AttributionDeps, SampleIndexCache, TimelineAccount, attribute,
};
use relay_core::token_ledger::{
    LastTick, LedgerSnapshot, TickResult, TokenLedger, TokenLedgerOptions, TokenRoot,
    token_tick_delay,
};
use relay_core::widget_file::{WidgetFile, WidgetReload};

use crate::services::statusline::schedule_statusline;
use crate::state::{STATE, lock};

/// The Usage page asks for ticks first when the last one is older than this.
pub const TOKEN_FRESH_MS: f64 = 60_000.0;
/// How long the Usage page waits, at most, for those ticks to finish the pass.
pub const TOKEN_REFRESH_BUDGET_MS: f64 = 1_000.0;
/// Limit samples are kept 14 days; older responses cannot be estimated from them.
const TOKEN_ATTRIBUTION_WINDOW_MS: f64 = 14.0 * 86_400_000.0;
/// The limit samples are copied for attribution at most this often.
const TOKEN_SAMPLES_REFRESH_MS: f64 = 60_000.0;

fn now() -> f64 {
    relay_core::clock::now_ms() as f64
}

/// What attribution reads for each row, refreshed once per tick and never once per row.
#[derive(Clone, Default)]
struct AttributionInputs {
    samples: Arc<Vec<UsageSample>>,
    samples_at: Option<f64>,
    accounts: Arc<Vec<Account>>,
    /// Which account's window holds each Claude Code session.
    owners: Arc<HashMap<String, SessionOwner>>,
}

static INPUTS: LazyLock<Mutex<AttributionInputs>> =
    LazyLock::new(|| Mutex::new(AttributionInputs::default()));

static LEDGER: Mutex<Option<TokenLedger>> = Mutex::new(None);
/// The macOS widget's file, rewritten after every tick and at local midnight.
static WIDGET_FILE: Mutex<Option<WidgetFile>> = Mutex::new(None);

/// Today's tokens and API value for the menu bar title, taken from the ledger when the widget is
/// written.
static TRAY_TODAY: Mutex<Option<TrayToday>> = Mutex::new(None);
/// The account open in Claude when the widget file was last written.
static WIDGET_ACTIVE_ID: Mutex<Option<String>> = Mutex::new(None);

/// How the last tick ended (before the first, as a pass yet to finish), and when it did.
static LAST_TICK: Mutex<(LastTick, f64)> =
    Mutex::new((LastTick::Ticked(TickResult { complete: false }), 0.0));
/// A tick under way; a caller during it waits for it instead of starting another.
static TICKING: Mutex<bool> = Mutex::new(false);
static TICK_ENDED: Condvar = Condvar::new();

static SCAN_STOPPED: AtomicBool = AtomicBool::new(false);

/// Each account's dollars per percent of its 5-hour window, worked out again every ten minutes.
static CALIBRATION: Mutex<Option<(f64, JsMap<LimitCalibration>)>> = Mutex::new(None);

/// `trayToday`: today's tokens and API value for the menu bar title.
pub fn tray_today() -> Option<TrayToday> {
    lock(&TRAY_TODAY).clone()
}

/// `widgetActiveId`: the account the widget file last showed as open in Claude.
pub fn widget_active_id() -> Option<String> {
    lock(&WIDGET_ACTIVE_ID).clone()
}

/// Whether the ledger exists (`tokenLedger !== undefined`).
pub fn has_ledger() -> bool {
    lock(&LEDGER).is_some()
}

/// `tokenLedger?.snapshot()`.
pub fn ledger_snapshot() -> Option<LedgerSnapshot> {
    lock(&LEDGER).as_ref().map(TokenLedger::snapshot)
}

/// `tokenLastTick`.
pub fn token_last_tick() -> LastTick {
    lock(&LAST_TICK).0
}

/// `tokenTickedAt`.
pub fn token_ticked_at() -> f64 {
    lock(&LAST_TICK).1
}

/// `limitCalibrations`.
pub fn limit_calibrations() -> JsMap<LimitCalibration> {
    let now = now();
    if let Some((at, value)) = lock(&CALIBRATION).as_ref()
        && now - at < 10.0 * 60_000.0
    {
        return value.clone();
    }
    let mut value = JsMap::new();
    // Not now: the next status asks again in ten minutes.
    if let (Some(slots), Some(history), Some(service)) = (
        ledger_snapshot().and_then(|ledger| ledger.slots),
        STATE.usage_history.get(),
        STATE.service.get(),
    ) {
        let slots: CostSlots = slots
            .into_iter()
            .map(|(date, who)| {
                let who = who
                    .into_iter()
                    .map(|(id, quarters)| {
                        let quarters = quarters
                            .into_iter()
                            .map(|(slot, counts)| (slot, SlotCost { cost: counts.cost }))
                            .collect();
                        (id, quarters)
                    })
                    .collect();
                (date, who)
            })
            .collect();
        let samples = lock(history).recent_samples(now - 7.0 * 86_400_000.0);
        let zone = service
            .store
            .with_state(|s| s.settings.planning.time_zone.clone());
        value = calibrate_limits(CalibrationInput {
            samples: &samples,
            slots: &slots,
            zone: &zone,
            now,
            days: None,
        });
    }
    *lock(&CALIBRATION) = Some((now, value.clone()));
    value
}

/// `addTokenRoots`: roots are only ever appended, so the indexes the ledger keeps into them stay
/// valid; an account that starts a terminal after launch is read from its next pass.
pub fn add_token_roots() {
    let Some(service) = STATE.service.get() else {
        return;
    };
    let mut fresh: Vec<TokenRoot> = Vec::new();
    for account in STATE.accounts() {
        let known = lock(&LEDGER).as_ref().is_none_or(|ledger| {
            ledger
                .roots()
                .iter()
                .any(|root| root.profile_account_id.as_deref() == Some(account.id.as_str()))
        });
        if known {
            continue;
        }
        let Ok(profile) = service.store.profile(&account.id) else {
            continue;
        };
        let dir = profile.join("projects");
        if dir.is_dir() {
            fresh.push(TokenRoot {
                dir,
                profile_account_id: Some(account.id),
            });
        }
    }
    if let Some(ledger) = lock(&LEDGER).as_mut() {
        for root in fresh {
            ledger.add_root(root);
        }
    }
}

/// A new copy of the limit samples when the last is a minute old, or the clock went back; and
/// the accounts as they are now.
fn refresh_inputs() {
    let now = now();
    let mut inputs = lock(&INPUTS);
    inputs.accounts = Arc::new(STATE.accounts());
    let age = inputs.samples_at.map_or(f64::INFINITY, |at| now - at);
    if (0.0..TOKEN_SAMPLES_REFRESH_MS).contains(&age) {
        return;
    }
    if let Some(history) = STATE.usage_history.get() {
        inputs.samples = Arc::new(lock(history).recent_samples(now - TOKEN_ATTRIBUTION_WINDOW_MS));
        inputs.samples_at = Some(now);
    }
}

fn token_tick_once() {
    if !has_ledger() {
        return;
    }
    add_token_roots();
    refresh_inputs();
    if let Some(windows) = STATE.desktop_windows.get() {
        let owners = windows.session_owners();
        lock(&INPUTS).owners = Arc::new(owners);
    }
    let ticked = lock(&LEDGER).as_mut().map(TokenLedger::tick);
    let last = match ticked {
        Some(Ok(result)) => {
            lock(&LAST_TICK).0 = LastTick::Ticked(result);
            write_widget();
            LastTick::Ticked(result)
        }
        // A scan that fails (a full disk, a bad time zone) never disturbs Relay; it is tried
        // again at the slow pace.
        Some(Err(_)) | None => LastTick::Failed,
    };
    *lock(&LAST_TICK) = (last, now());
}

/// `tokenTick`: one tick at a time; a caller during a tick shares it instead of starting another.
pub fn token_tick() {
    let mut running = lock(&TICKING);
    if *running {
        while *running {
            running = TICK_ENDED.wait(running).unwrap_or_else(|e| e.into_inner());
        }
        return;
    }
    *running = true;
    drop(running);
    token_tick_once();
    *lock(&TICKING) = false;
    TICK_ENDED.notify_all();
}

fn stopped() -> bool {
    SCAN_STOPPED.load(Ordering::SeqCst) || STATE.quitting()
}

/// The next tick is armed only when the last has ended, on a thread that never holds Relay open.
fn schedule_token_ticks() {
    let _ = std::thread::Builder::new()
        .name("relay-token-scan".into())
        .spawn(|| {
            while !stopped() {
                std::thread::sleep(Duration::from_millis(token_tick_delay(token_last_tick())));
                if stopped() {
                    return;
                }
                token_tick();
            }
        });
}

/// `writeWidget()`: today's numbers for the widget and the menu bar title, from the ledger as it
/// stands; never disturbs Relay.
pub fn write_widget() {
    write_widget_with(false);
}

/// `writeWidget(true)`: the widget reloads now whatever the throttle says, as for a new language.
pub fn write_widget_forced() {
    write_widget_with(true);
}

fn write_widget_with(force: bool) {
    schedule_statusline();
    let active = STATE
        .observed_desktop()
        .and_then(|state| state.active_profile_id);
    *lock(&WIDGET_ACTIVE_ID) = active.clone();
    let Some(service) = STATE.service.get() else {
        return;
    };
    let Some(ledger) = ledger_snapshot() else {
        return;
    };
    let mut widget = lock(&WIDGET_FILE);
    let Some(file) = widget.as_mut() else {
        return;
    };
    // A widget file that cannot be written leaves the widget saying Relay is not current.
    let (accounts, settings) = service
        .store
        .with_state(|s| (s.accounts.clone(), s.settings.clone()));
    let zone = settings.planning.time_zone.clone();
    let now = now();
    let progress = &ledger.progress;
    let complete = progress.complete;
    let percent = if complete {
        100.0
    } else if progress.total_bytes > 0.0 {
        ((progress.scanned_bytes / progress.total_bytes) * 100.0)
            .floor()
            .min(99.0)
    } else {
        0.0
    };
    let tokens = build_token_usage_view(&TokenUsageInput {
        ledger: &ledger,
        accounts: &accounts,
        range: 7,
        account_id: None,
        zone: &zone,
        now,
        exact_since: None,
    });
    // The menu bar title reads today's figures from here, so its 5-second timer never reads the
    // ledger; until the first pass is done they are partial and left out.
    let totals = &tokens.today.totals;
    *lock(&TRAY_TODAY) = complete.then(|| TrayToday {
        date: tokens.today.date.clone(),
        tokens: totals.input + totals.output + totals.cache_write + totals.cache_read,
        cost: totals.cost.unwrap_or(0.0),
        cost_estimated: totals.cost_estimated.filter(|&estimated| estimated),
    });
    let usage: JsMap<_> = STATE
        .usage
        .get()
        .map(|usage| usage.snapshot().into_iter().collect())
        .unwrap_or_default();
    let snapshot = build_widget_snapshot(&WidgetSnapshotInput {
        today: &tokens.today,
        days: Some(&tokens.days),
        progress: WidgetProgress { complete, percent },
        language: crate::i18n::locale(),
        zone: &zone,
        now,
        limits: Some(WidgetLimits {
            accounts: &accounts,
            usage: &usage,
            active_id: active.as_deref(),
            settings: &settings,
            rate: widget_tempo_rate(now),
        }),
        hits: widget_limit_hits(&accounts, &zone, now),
    });
    let _ = file.write(&snapshot, force);
}

/// `widgetTempoRate`: the keeper's tempo now, as the panel ranks accounts with it; `None`
/// without one.
pub fn widget_tempo_rate(now: f64) -> Option<f64> {
    let tempo = STATE.keeper.get()?.snapshot().tempo?;
    Some(tempo_at(&tempo, &STATE.settings().planning, now))
}

/// Limits reached in the last seven days, as the Usage page counts them; `None` without history.
fn widget_limit_hits(accounts: &[Account], zone: &str, now: f64) -> Option<f64> {
    let history = lock(STATE.usage_history.get()?);
    if !history.rollups_available {
        return None;
    }
    let rollups = history.rollups();
    drop(history);
    let view = build_statistics_view(&StatisticsInput {
        rollups: rollups.as_ref(),
        available: true,
        accounts,
        range: 7,
        account_id: None,
        zone,
        now,
        hours: None,
    });
    if view.status == StatisticsStatus::Unavailable {
        return None;
    }
    Some(f64::from(
        view.totals.hits.five_hour + view.totals.hits.weekly,
    ))
}

/// How long until local midnight in the planning zone (plus a second), at most an hour.
fn until_midnight() -> u64 {
    let mut wait = 60.0 * 60_000.0;
    let zone = STATE.settings().planning.time_zone;
    let now = now();
    let today = local_date(now, &zone);
    let noon = date_parse(&format!("{today}T12:00:00Z"));
    // An invalid zone: try again within the hour.
    if noon.is_finite() {
        let tomorrow: String = iso(noon + 86_400_000.0).chars().take(10).collect();
        if let Some(midnight) = wall_time(&tomorrow, "00:00", &zone)
            && midnight > now
        {
            wait = f64::min(wait, midnight - now + 1_000.0);
        }
    }
    wait as u64
}

/// At local midnight the widget starts the new day, even with nothing to count.
fn schedule_widget_midnight() {
    let _ = std::thread::Builder::new()
        .name("relay-widget-midnight".into())
        .spawn(|| {
            while !stopped() {
                std::thread::sleep(Duration::from_millis(until_midnight()));
                if stopped() {
                    return;
                }
                write_widget();
            }
        });
}

/// Asks WidgetKit to redraw every widget of Relay's.
#[cfg(target_os = "macos")]
fn widget_reload() -> Option<WidgetReload> {
    let reload = crate::macos::widget_reload()?;
    Some(Box::new(move || {
        reload(None);
        Ok(())
    }))
}

/// No widgets off macOS.
#[cfg(not(target_os = "macos"))]
fn widget_reload() -> Option<WidgetReload> {
    None
}

/// The ledger's attribution of one row: whose response it was.
fn ledger_options(roots: Vec<TokenRoot>) -> TokenLedgerOptions {
    let mut index = SampleIndexCache::new();
    let mut indexed: Option<Arc<Vec<UsageSample>>> = None;
    TokenLedgerOptions {
        file: STATE.paths().data_dir().join("token-ledger.json"),
        roots,
        attribute: Box::new(move |row| {
            let inputs = lock(&INPUTS).clone();
            if !indexed
                .as_ref()
                .is_some_and(|samples| Arc::ptr_eq(samples, &inputs.samples))
            {
                index = SampleIndexCache::new();
                indexed = Some(Arc::clone(&inputs.samples));
            }
            let window_owner = |session_id: &str, time: f64| {
                inputs
                    .owners
                    .get(&session_id.to_lowercase())
                    .filter(|owner| time <= owner.until)
                    .map(|owner| owner.account_uuid.clone())
            };
            let gateway_account = crate::services::gateway::gateway_account;
            let unknown = |_: f64| -> Option<TimelineAccount> { None };
            let timeline = STATE.active_timeline.get().map(lock);
            let mut deps = match &timeline {
                Some(timeline) => {
                    AttributionDeps::new(&**timeline, &inputs.samples, &inputs.accounts)
                }
                None => AttributionDeps::new(&unknown, &inputs.samples, &inputs.accounts),
            };
            deps.window_owner = Some(&window_owner);
            deps.gateway_account = Some(&gateway_account);
            deps.index = Some(&index);
            attribute(row, &deps)
        }),
        zone: Box::new(|| STATE.settings().planning.time_zone),
        now: None,
        budget_ms: None,
        max_age_days: None,
        max_bytes: None,
    }
}

/// `startTokenScan`.
pub fn start_token_scan() {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_default();
    let roots = vec![TokenRoot {
        dir: home.join(".claude").join("projects"),
        profile_account_id: None,
    }];
    *lock(&LEDGER) = Some(TokenLedger::new(ledger_options(roots)));
    *lock(&WIDGET_FILE) = Some(WidgetFile::new(
        STATE.paths().data_dir().join("widget"),
        widget_reload(),
        None,
    ));
    write_widget();
    schedule_widget_midnight();
    schedule_token_ticks();
}

/// `stopTokenScan`: Relay is quitting; no tick or midnight rewrite is armed again.
pub fn stop_token_scan() {
    SCAN_STOPPED.store(true, Ordering::SeqCst);
}
