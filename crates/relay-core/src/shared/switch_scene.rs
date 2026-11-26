//! Port of `shared/switch-scene.ts`: the switch window's story (the panda leaves, waits behind
//! the door, returns, fades) as a pure state machine, its line and view, and the timer that runs it.

use std::borrow::Cow;

use relay_i18n::{Args, Locale, translate};
use serde::{Deserialize, Serialize, Serializer};

use super::types::js::{ser_num, ser_opt_num};
use super::types::{DesktopOperationKind, DesktopRestartEvent, literal_enum};

pub const LEAVING_MS: f64 = 1_200.0;
/// After this long behind the closed door the window hides; the menu bar keeps the door.
pub const WAITING_LIMIT_MS: f64 = 60_000.0;
/// How long each outcome returns for.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ReturningMs {
    pub switched: f64,
    pub back: f64,
    pub failed: f64,
}

impl ReturningMs {
    pub const fn of(&self, outcome: SwitchOutcome) -> f64 {
        match outcome {
            SwitchOutcome::Switched => self.switched,
            SwitchOutcome::Back => self.back,
            SwitchOutcome::Failed => self.failed,
        }
    }
}

pub const RETURNING_MS: ReturningMs = ReturningMs {
    switched: 2_500.0,
    back: 1_500.0,
    failed: 4_000.0,
};
pub const CLOSING_MS: f64 = 300.0;

literal_enum!(Disguise { Fedora = "fedora", Sunglasses = "sunglasses", Deerstalker = "deerstalker" });

/// Each disguise is a pair of props worn on the standing panda, in the TS key order.
pub const DISGUISES: [(Disguise, [&str; 2]); 3] = [
    (Disguise::Fedora, ["fedora", "mustache"]),
    (Disguise::Sunglasses, ["sunglasses", "scarf"]),
    (Disguise::Deerstalker, ["deerstalker", "coat"]),
];

literal_enum!(SwitchOutcome { Switched = "switched", Back = "back", Failed = "failed" });
literal_enum!(
    /// `stalled`: still waiting after the limit, with the window hidden.
    SwitchStage {
        Hidden = "hidden",
        Leaving = "leaving",
        Waiting = "waiting",
        Stalled = "stalled",
        Returning = "returning",
        Closing = "closing",
    }
);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchSceneState {
    pub stage: SwitchStage,
    /// When the stage began.
    #[serde(serialize_with = "ser_num")]
    pub since: f64,
    /// Counts stories, so the window restarts its animations for a new one.
    pub story: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<DesktopOperationKind>,
    /// The switch target; the line names it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
    /// The account Claude had open when the story began, for the from → to line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_id: Option<String>,
    /// The result, once the operation ended (it may end while the panda still walks).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<SwitchOutcome>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disguise: Option<Disguise>,
    /// Never worn twice in a row.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_disguise: Option<Disguise>,
}

pub const INITIAL_SCENE: SwitchSceneState = SwitchSceneState {
    stage: SwitchStage::Hidden,
    since: 0.0,
    story: 0,
    kind: None,
    profile_id: None,
    from_id: None,
    outcome: None,
    disguise: None,
    last_disguise: None,
};

/// A restart report (whose start may name the account Claude had open), or a timer tick.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "phase", rename_all = "lowercase")]
pub enum SwitchSceneEvent {
    #[serde(rename_all = "camelCase")]
    Start {
        kind: DesktopOperationKind,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        profile_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    End {
        kind: DesktopOperationKind,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        profile_id: Option<String>,
        ok: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from_id: Option<String>,
    },
    Tick,
}

impl From<DesktopRestartEvent> for SwitchSceneEvent {
    fn from(event: DesktopRestartEvent) -> Self {
        match event {
            DesktopRestartEvent::Start { kind, profile_id } => SwitchSceneEvent::Start {
                kind,
                profile_id,
                from_id: None,
            },
            DesktopRestartEvent::End {
                kind,
                profile_id,
                ok,
            } => SwitchSceneEvent::End {
                kind,
                profile_id,
                ok,
                from_id: None,
            },
        }
    }
}

/// `Math.random()`: uniform in [0, 1).
pub(crate) fn math_random() -> f64 {
    let mut bytes = [0u8; 8];
    // Without entropy the first choice is as good as any: this only picks decorations.
    let _ = getrandom::fill(&mut bytes);
    (u64::from_le_bytes(bytes) >> 11) as f64 / (1u64 << 53) as f64
}

/// A random disguise other than the previous one (`random` is `Math.random` in the TS default).
pub fn pick_disguise(previous: Option<Disguise>, random: impl FnOnce() -> f64) -> Disguise {
    let choices: Vec<Disguise> = DISGUISES
        .iter()
        .map(|(d, _)| *d)
        .filter(|d| Some(*d) != previous)
        .collect();
    let at = (random() * choices.len() as f64).floor();
    // `as usize` reads a negative or NaN draw as 0, where the TS would index out of the list.
    choices[(choices.len() - 1).min(at as usize)]
}

/// When the stage ends by itself; `None` while it waits for an event.
pub fn scene_deadline(state: &SwitchSceneState) -> Option<f64> {
    match state.stage {
        SwitchStage::Leaving => Some(state.since + LEAVING_MS),
        SwitchStage::Waiting => Some(state.since + WAITING_LIMIT_MS),
        SwitchStage::Returning => {
            Some(state.since + RETURNING_MS.of(state.outcome.unwrap_or(SwitchOutcome::Back)))
        }
        SwitchStage::Closing => Some(state.since + CLOSING_MS),
        _ => None,
    }
}

type Pick<'p> = dyn FnMut(Option<Disguise>) -> Disguise + 'p;

fn returning(state: &SwitchSceneState, at: f64, pick: &mut Pick<'_>) -> SwitchSceneState {
    let disguise = if state.outcome == Some(SwitchOutcome::Switched) {
        Some(pick(state.last_disguise))
    } else {
        None
    };
    SwitchSceneState {
        stage: SwitchStage::Returning,
        since: at,
        disguise,
        last_disguise: disguise.or(state.last_disguise),
        ..state.clone()
    }
}

/// Finishes every stage whose time is up at `now`; a late timer skips what it slept through.
fn catch_up<'a>(
    state: Cow<'a, SwitchSceneState>,
    now: f64,
    pick: &mut Pick<'_>,
) -> Cow<'a, SwitchSceneState> {
    let mut next = state;
    while let Some(deadline) = scene_deadline(&next).filter(|d| *d <= now) {
        let with = |stage| SwitchSceneState {
            stage,
            since: deadline,
            ..(*next).clone()
        };
        next = Cow::Owned(match next.stage {
            SwitchStage::Leaving if next.outcome.is_some() => returning(&next, deadline, pick),
            SwitchStage::Leaving => with(SwitchStage::Waiting),
            SwitchStage::Waiting => with(SwitchStage::Stalled),
            SwitchStage::Returning => with(SwitchStage::Closing),
            _ => with(SwitchStage::Hidden),
        });
    }
    next
}

/// One step of the story: a restart report or a timer tick at `now`. `Borrowed` is the state as
/// it was (the TS returns the same object), so a caller can tell a change.
pub fn switch_scene<'a>(
    state: &'a SwitchSceneState,
    event: &SwitchSceneEvent,
    now: f64,
    pick: &mut Pick<'_>,
) -> Cow<'a, SwitchSceneState> {
    if let SwitchSceneEvent::Start {
        kind,
        profile_id,
        from_id,
    } = event
    {
        return Cow::Owned(SwitchSceneState {
            stage: SwitchStage::Leaving,
            since: now,
            story: state.story + 1,
            kind: Some(*kind),
            profile_id: profile_id.clone(),
            from_id: from_id.clone(),
            outcome: None,
            disguise: None,
            last_disguise: state.last_disguise,
        });
    }
    let current = catch_up(Cow::Borrowed(state), now, pick);
    if let SwitchSceneEvent::End { kind, ok, .. } = event {
        // The timer may not have run yet, so the end first sees the stage it really arrives in.
        let outcome = if !ok {
            SwitchOutcome::Failed
        } else if *kind == DesktopOperationKind::Switch {
            SwitchOutcome::Switched
        } else {
            SwitchOutcome::Back
        };
        let ended = || SwitchSceneState {
            outcome: Some(outcome),
            ..(*current).clone()
        };
        return match current.stage {
            SwitchStage::Leaving => Cow::Owned(ended()),
            SwitchStage::Waiting | SwitchStage::Stalled => {
                Cow::Owned(returning(&ended(), now, pick))
            }
            _ => current, // an end without its start
        };
    }
    current
}

fn returned(state: &SwitchSceneState) -> bool {
    matches!(state.stage, SwitchStage::Returning | SwitchStage::Closing)
}

/// The line under the scene; an account that is gone falls back to the general lines.
pub fn scene_line(
    state: &SwitchSceneState,
    language: Locale,
    name: &dyn Fn(&str) -> Option<String>,
) -> String {
    let t = |id: &str, args: &Args| translate(language, id, args);
    let target = state
        .profile_id
        .as_deref()
        .filter(|id| !id.is_empty())
        .and_then(name);
    if returned(state) {
        if state.outcome == Some(SwitchOutcome::Failed) {
            return t("switchScene.didNotFinishDetailsInRelay", &Args::new());
        }
        return match target {
            Some(target) if state.outcome == Some(SwitchOutcome::Switched) => {
                t("switchScene.youAreOn", &Args::new().set("name", target))
            }
            _ => t("switchScene.theClaudeAppReopened", &Args::new()),
        };
    }
    if matches!(state.stage, SwitchStage::Hidden | SwitchStage::Stalled) {
        return String::new();
    }
    match target {
        Some(target) if state.kind == Some(DesktopOperationKind::Switch) => t(
            "switchScene.relaySwitchesTo",
            &Args::new().set("name", target),
        ),
        _ => t("switchScene.theClaudeAppRestarts", &Args::new()),
    }
}

/// One side of a switch: the account's name and its five-hour percent used, when known.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SceneAccount {
    pub name: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_num"
    )]
    pub percent: Option<f64>,
}

/// For a switch: where it goes, and from where when that is another known account.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SceneAccounts {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<SceneAccount>,
    pub to: SceneAccount,
}

fn ser_locale<S: Serializer>(locale: &Locale, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(locale.as_str())
}

/// What the switch window draws; sent to its page as is.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SwitchSceneView {
    /// The stage is drawn on screen.
    pub visible: bool,
    pub stage: SwitchStage,
    pub story: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<SwitchOutcome>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disguise: Option<Disguise>,
    pub line: String,
    /// The language `line` is in; the page formats its figures in it too.
    #[serde(serialize_with = "ser_locale")]
    pub locale: Locale,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accounts: Option<SceneAccounts>,
    /// Animate; otherwise each stage is one still image.
    pub motion: bool,
}

/// An account's percent used (`percent` in `SceneContext`).
pub type PercentOf<'a> = &'a dyn Fn(&str) -> Option<f64>;

/// What `scene_view` reads besides the state.
#[derive(Clone, Copy)]
pub struct SceneContext<'a> {
    pub language: Locale,
    pub name: &'a dyn Fn(&str) -> Option<String>,
    /// The five-hour percent used of an account, when known.
    pub percent: Option<PercentOf<'a>>,
    pub motion: bool,
}

/// The from → to pair of a switch whose target is still known; `None` for a plain restart.
fn scene_accounts(
    state: &SwitchSceneState,
    name: &dyn Fn(&str) -> Option<String>,
    percent: &dyn Fn(&str) -> Option<f64>,
) -> Option<SceneAccounts> {
    if state.kind != Some(DesktopOperationKind::Switch) {
        return None;
    }
    let profile_id = state.profile_id.as_deref().filter(|id| !id.is_empty())?;
    let side = |id: &str| {
        name(id).map(|known| SceneAccount {
            name: known,
            percent: percent(id),
        })
    };
    let to = side(profile_id)?;
    let from = state
        .from_id
        .as_deref()
        .filter(|from| !from.is_empty() && *from != profile_id)
        .and_then(side);
    Some(SceneAccounts { from, to })
}

pub fn scene_view(state: &SwitchSceneState, context: &SceneContext<'_>) -> SwitchSceneView {
    let accounts = scene_accounts(state, context.name, context.percent.unwrap_or(&|_| None));
    let returned = returned(state);
    SwitchSceneView {
        visible: matches!(state.stage, SwitchStage::Leaving | SwitchStage::Waiting) || returned,
        stage: state.stage,
        story: state.story,
        outcome: if returned { state.outcome } else { None },
        disguise: if returned { state.disguise } else { None },
        line: scene_line(state, context.language, context.name),
        locale: context.language,
        accounts,
        motion: context.motion,
    }
}

/// The switch window's own state, for `switch_window_visible`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchWindowState {
    pub loaded: bool,
    pub enabled: bool,
    pub panel_open: bool,
}

/// The window shows a drawn stage only with its page ready, the setting on and the menu bar panel
/// closed. `visible` is the view's (`None` before there is one).
pub fn switch_window_visible(visible: Option<bool>, window: SwitchWindowState) -> bool {
    visible == Some(true) && window.loaded && window.enabled && !window.panel_open
}

/// What a `SwitchStory` runs on: where its states go, the clock and one timer.
pub trait SwitchStoryHost {
    type Error;
    /// Each new state of the story.
    fn show(&mut self, state: &SwitchSceneState) -> Result<(), Self::Error>;
    fn now(&mut self) -> f64 {
        crate::clock::now_ms() as f64
    }
    /// Starts a timer whose firing calls `SwitchStory::tick`.
    fn set_timeout(&mut self, ms: f64) -> u64;
    fn clear_timeout(&mut self, handle: u64);
    fn pick(&mut self, previous: Option<Disguise>) -> Disguise {
        pick_disguise(previous, math_random)
    }
}

/// Runs the story: one timer for the current stage, a new state for every change.
pub struct SwitchStory<H: SwitchStoryHost> {
    host: H,
    state: SwitchSceneState,
    timer: Option<u64>,
}

impl<H: SwitchStoryHost> SwitchStory<H> {
    pub fn new(host: H) -> Self {
        SwitchStory {
            host,
            state: INITIAL_SCENE,
            timer: None,
        }
    }

    pub fn current(&self) -> &SwitchSceneState {
        &self.state
    }

    pub fn host(&self) -> &H {
        &self.host
    }

    pub fn host_mut(&mut self) -> &mut H {
        &mut self.host
    }

    pub fn report(&mut self, event: SwitchSceneEvent) {
        self.step(&event);
    }

    /// Re-reads the clock now (the timer calls this; so can a preview that moves its clock).
    pub fn tick(&mut self) {
        self.step(&SwitchSceneEvent::Tick);
    }

    pub fn destroy(&mut self) {
        if let Some(timer) = self.timer.take() {
            self.host.clear_timeout(timer);
        }
    }

    fn step(&mut self, event: &SwitchSceneEvent) {
        let now = self.host.now();
        let host = &mut self.host;
        let next = switch_scene(&self.state, event, now, &mut |previous| host.pick(previous));
        let changed = match next {
            Cow::Owned(next) => {
                self.state = next;
                true
            }
            Cow::Borrowed(_) => false,
        };
        self.destroy();
        if let Some(deadline) = scene_deadline(&self.state) {
            self.timer = Some(self.host.set_timeout((deadline - now).max(0.0)));
        }
        if changed {
            // The story is decoration; it never breaks a Desktop operation.
            let _ = self.host.show(&self.state);
        }
    }
}
