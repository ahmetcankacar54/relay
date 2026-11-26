//! Port of `shared/tray-panel.ts`: where the menu bar panel opens, and what a tray click, a blur
//! or a renderer event does to it.

use serde::{Deserialize, Serialize};

use super::types::js::{max, min, round, ser_num};
use super::types::literal_enum;

pub const PANEL_WIDTH: f64 = 360.0;

#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct Rect {
    #[serde(serialize_with = "ser_num")]
    pub x: f64,
    #[serde(serialize_with = "ser_num")]
    pub y: f64,
    #[serde(serialize_with = "ser_num")]
    pub width: f64,
    #[serde(serialize_with = "ser_num")]
    pub height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct Point {
    #[serde(serialize_with = "ser_num")]
    pub x: f64,
    #[serde(serialize_with = "ser_num")]
    pub y: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct Size {
    #[serde(serialize_with = "ser_num")]
    pub width: f64,
    #[serde(serialize_with = "ser_num")]
    pub height: f64,
}

const EDGE: f64 = 8.0;
const GAP: f64 = 4.0;

/// Below the tray icon, centred on it, kept inside the work area.
pub fn panel_position(tray: Rect, work_area: Rect, size: Size) -> Point {
    let centred = round(tray.x + tray.width / 2.0 - size.width / 2.0);
    let x = min([
        max([centred, work_area.x + EDGE]),
        work_area.x + work_area.width - size.width - EDGE,
    ]);
    let below = tray.y + tray.height + GAP;
    let y = max([
        work_area.y,
        min([below, work_area.y + work_area.height - size.height - EDGE]),
    ]);
    Point { x, y }
}

pub fn clamp_panel_height(height: f64, work_area_height: f64) -> f64 {
    min([max([height.ceil(), 200.0]), work_area_height - 16.0])
}

/// Clicking the tray icon while the panel is open first blurs (and hides) the panel, then
/// delivers the click. Ignore opens that land within 400 ms of a hide so that click closes the
/// panel instead of reopening it; 400 ms (not 250) also covers a slow, long-press click whose
/// mouse-up arrives late.
pub const TOGGLE_GUARD_MS: f64 = 400.0;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ToggleGuard {
    hidden_at: f64,
}

impl Default for ToggleGuard {
    fn default() -> Self {
        Self::new()
    }
}

impl ToggleGuard {
    pub const fn new() -> Self {
        ToggleGuard {
            hidden_at: f64::NEG_INFINITY,
        }
    }

    pub fn should_open(&self, now: f64) -> bool {
        now - self.hidden_at > TOGGLE_GUARD_MS
    }

    /// `by_tray_click` false (the panel lost focus to a click somewhere else, or Esc) arms
    /// nothing: the user's next tray click, however soon, must open the panel.
    pub fn hidden(&mut self, now: f64, by_tray_click: bool) {
        self.hidden_at = if by_tray_click {
            now
        } else {
            f64::NEG_INFINITY
        };
    }
}

/// The slack around the tray icon `pointer_on_tray` allows by default.
pub const POINTER_SLACK: f64 = 4.0;

/// Whether the pointer is over the tray icon, with a little slack around it (TS default 4).
pub fn pointer_on_tray(tray: Option<&Rect>, point: Point, slack: f64) -> bool {
    let Some(tray) = tray else { return false };
    point.x >= tray.x - slack
        && point.x <= tray.x + tray.width + slack
        && point.y >= tray.y - slack
        && point.y <= tray.y + tray.height + slack
}

/// How long after opening the panel a blur under the tray icon is treated as part of the
/// opening click (AppKit status item tracking ending, focus settling), not a click to close. A
/// human cannot see the panel and click to close it within this window.
pub const PANEL_OPEN_GUARD_MS: f64 = 300.0;

/// `panelBlurAction`'s parameters.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelBlur {
    #[serde(serialize_with = "ser_num")]
    pub opened_at: f64,
    #[serde(serialize_with = "ser_num")]
    pub now: f64,
    #[serde(default)]
    pub tray: Option<Rect>,
    pub cursor: Point,
}

literal_enum!(PanelBlurAction { Ignore = "ignore", HideByTray = "hide-by-tray", Hide = "hide" });

/// What a blur event on the panel window should do:
/// - If the pointer is over the tray icon right after opening (< PANEL_OPEN_GUARD_MS), the blur is
///   a transient artifact of the opening click; ignore it so the panel stays open.
/// - If the pointer is over the tray icon after the panel has been open for a while, the user
///   clicked the tray icon to close the panel: hide it and arm the toggle guard.
/// - Otherwise (clicked into another app, Esc, etc.), hide the panel without arming the guard.
pub fn panel_blur_action(params: PanelBlur) -> PanelBlurAction {
    if pointer_on_tray(params.tray.as_ref(), params.cursor, POINTER_SLACK) {
        return if params.now - params.opened_at < PANEL_OPEN_GUARD_MS {
            PanelBlurAction::Ignore
        } else {
            PanelBlurAction::HideByTray
        };
    }
    PanelBlurAction::Hide
}

/// macOS can order the panel in on no Space at all: it counts as shown, nothing draws it, and
/// every later show of the same window does the same until Relay restarts. A new window lands on
/// the Space as it should, so the panel's window is made again and opens once it has painted.
/// At most one rebuild per this long, so a Mac that keeps every new window off the Space does
/// not reload the panel on every click.
pub const PANEL_REBUILD_GAP_MS: f64 = 10_000.0;
/// How long after the click a rebuilt panel may still open by itself.
pub const PANEL_PENDING_OPEN_MS: f64 = 5_000.0;

literal_enum!(PanelOffSpaceAction { Rebuild = "rebuild", Hide = "hide" });

/// A shown panel that is not on the active Space: make its window again, or only hide it.
pub fn panel_off_space_action(since_rebuild: f64) -> PanelOffSpaceAction {
    if since_rebuild < PANEL_REBUILD_GAP_MS {
        PanelOffSpaceAction::Hide
    } else {
        PanelOffSpaceAction::Rebuild
    }
}

/// The click a rebuilt panel still has to open for.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct PendingOpen {
    #[serde(serialize_with = "ser_num")]
    pub at: f64,
}

/// Whether a rebuilt panel that has just painted should still open for the click that rebuilt it.
pub fn pending_open_due(pending: Option<PendingOpen>, now: f64) -> bool {
    pending.is_some_and(|p| now - p.at <= PANEL_PENDING_OPEN_MS)
}

literal_enum!(TrayClickAction { Toggle = "toggle", Menu = "menu" });

/// Left tray click: the popover once it has loaded, else today's native menu.
pub fn tray_click_action(panel_usable: bool) -> TrayClickAction {
    if panel_usable {
        TrayClickAction::Toggle
    } else {
        TrayClickAction::Menu
    }
}

literal_enum!(PanelPhase {
    Loading = "loading",
    Ready = "ready",
    Failed = "failed",
    Reloading = "reloading",
});

/// Panel renderer lifecycle. `painted` is the first `relay:panel-size` message, which the renderer
/// sends only after its first layout, so did-finish-load alone never makes the panel usable. One
/// renderer crash reloads it; a second crash keeps it unusable (native menu) until a tray click
/// revives it (`panel_revival`).
///
/// `start` is a new document in the main frame (`did-navigate`), never `did-start-loading`: that
/// one also fires for a change of the address inside the page and for a navigation Relay refuses,
/// after which the page stays as it was and never reports a size again.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PanelLoadState {
    pub phase: PanelPhase,
    pub crashes: u32,
}

literal_enum!(PanelLoadEvent {
    Start = "start",
    Finish = "finish",
    Painted = "painted",
    Fail = "fail",
    Gone = "gone",
});

pub const INITIAL_PANEL_LOAD: PanelLoadState = PanelLoadState {
    phase: PanelPhase::Loading,
    crashes: 0,
};
pub const MAX_PANEL_CRASHES: u32 = 2;

pub fn panel_load_state(prev: PanelLoadState, event: PanelLoadEvent) -> PanelLoadState {
    if prev.crashes >= MAX_PANEL_CRASHES {
        return prev;
    }
    match event {
        PanelLoadEvent::Start => PanelLoadState {
            phase: PanelPhase::Loading,
            ..prev
        },
        PanelLoadEvent::Finish => prev,
        PanelLoadEvent::Painted => match prev.phase {
            PanelPhase::Loading | PanelPhase::Ready => PanelLoadState {
                phase: PanelPhase::Ready,
                ..prev
            },
            _ => prev,
        },
        PanelLoadEvent::Fail => PanelLoadState {
            phase: PanelPhase::Failed,
            ..prev
        },
        PanelLoadEvent::Gone => {
            let crashes = prev.crashes + 1;
            PanelLoadState {
                phase: if crashes >= MAX_PANEL_CRASHES {
                    PanelPhase::Failed
                } else {
                    PanelPhase::Reloading
                },
                crashes,
            }
        }
    }
}

/// How long a panel may stay unpainted with nothing loading before a tray click reloads it.
pub const PANEL_STUCK_MS: f64 = 5_000.0;
/// At most one revival per this long: a page that cannot load is not reloaded on every click.
pub const PANEL_REVIVE_GAP_MS: f64 = 10_000.0;

/// What `panel_revival` reads of the panel.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelHealth {
    pub phase: PanelPhase,
    /// The window exists.
    pub alive: bool,
    /// Its page is loading right now.
    pub page_loading: bool,
    /// How long it has not been ready, in ms.
    #[serde(serialize_with = "ser_num")]
    pub unready_for: f64,
    /// How long ago it was last revived, in ms.
    #[serde(serialize_with = "ser_num")]
    pub since_revival: f64,
}

literal_enum!(PanelRevival { Recreate = "recreate", Reload = "reload" });

/// What a tray click does for a panel that cannot open, so the next click finds it working: make
/// its window again when it is gone, or load its page again when that failed, crashed out or never
/// painted. `None` while it is still loading normally or was revived a moment ago.
pub fn panel_revival(panel: PanelHealth) -> Option<PanelRevival> {
    if panel.since_revival < PANEL_REVIVE_GAP_MS {
        return None;
    }
    if !panel.alive {
        return Some(PanelRevival::Recreate);
    }
    match panel.phase {
        PanelPhase::Ready => None,
        PanelPhase::Failed => Some(PanelRevival::Reload),
        _ => (!panel.page_loading && panel.unready_for >= PANEL_STUCK_MS)
            .then_some(PanelRevival::Reload),
    }
}
