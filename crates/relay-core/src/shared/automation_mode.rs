//! Port of `shared/automation-mode.ts`: the one automatic-switching choice. It sits on two
//! records: the fleet ("Continue at quota") and `settings.autoSwitchMode` (prepare on quit).

use serde::{Deserialize, Serialize};

use super::types::{AutoSwitchMode, literal_enum};

literal_enum!(AutomationMode { Off = "off", AfterExit = "after-exit", Quota = "quota" });

/// The fleet wins: the two records are never both on in a saved choice. `fleet_enabled` is the
/// fleet's `enabled`, `None` without a fleet.
pub fn automation_mode(
    auto_switch_mode: AutoSwitchMode,
    fleet_enabled: Option<bool>,
) -> AutomationMode {
    if fleet_enabled == Some(true) {
        return AutomationMode::Quota;
    }
    match auto_switch_mode {
        AutoSwitchMode::AfterExit => AutomationMode::AfterExit,
        AutoSwitchMode::Off => AutomationMode::Off,
    }
}

/// Both records a mode writes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationModeWrites {
    pub fleet: bool,
    pub auto_switch_mode: AutoSwitchMode,
}

/// Both records a mode writes, so choosing one always turns the other off.
pub fn automation_mode_writes(mode: AutomationMode) -> AutomationModeWrites {
    let (fleet, auto_switch_mode) = match mode {
        AutomationMode::Quota => (true, AutoSwitchMode::Off),
        AutomationMode::AfterExit => (false, AutoSwitchMode::AfterExit),
        AutomationMode::Off => (false, AutoSwitchMode::Off),
    };
    AutomationModeWrites {
        fleet,
        auto_switch_mode,
    }
}

/// One choice of the picker: its value and message ids.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct AutomationModeOption {
    pub value: AutomationMode,
    pub label: &'static str,
    pub description: &'static str,
}

pub const AUTOMATION_MODES: [AutomationModeOption; 3] = [
    AutomationModeOption {
        value: AutomationMode::Off,
        label: "common.off",
        description: "automationMode.relayDoesNotSwitchAccounts",
    },
    AutomationModeOption {
        value: AutomationMode::AfterExit,
        label: "automationMode.whenTheClaudeAppQuits",
        description: "automationMode.atTheLimitPreparesThe",
    },
    AutomationModeOption {
        value: AutomationMode::Quota,
        label: "automationMode.whenTheLimitIsReached",
        description: "automationMode.opensTheNextAccountAnd",
    },
];
