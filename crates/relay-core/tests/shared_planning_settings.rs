//! The `shared/planning` cases of tests/planning-settings.test.ts. The planning schema, legacy
//! workday migration and Store cases are Electron.

use relay_core::shared::planning::{default_planning, system_time_zone, wall_time_or_next};
use relay_core::shared::types::js::date_parse;
use relay_core::shared::types::{PlanningSettings, default_planning_settings, default_settings};

#[test]
fn a_new_registry_plans_in_the_systems_time_zone_a_saved_one_keeps_its_own() {
    // The Store half (a new registry's planning) is Electron; this keeps what `defaultPlanning`
    // gives it: the defaults in the system's zone, the shared defaults left untouched.
    let planning = default_planning();
    assert_eq!(planning.time_zone, system_time_zone());
    assert_eq!(
        PlanningSettings {
            time_zone: default_planning_settings().time_zone,
            ..planning
        },
        default_planning_settings()
    );
    // The default object itself is never shared or changed.
    assert_eq!(default_settings().planning.time_zone, "Europe/Istanbul");
}

#[test]
fn a_clock_a_dst_change_skips_moves_to_the_first_quarter_hour_after_it() {
    // Berlin skips 02:00–03:00 on 2026-03-29; Istanbul has no DST.
    assert_eq!(
        wall_time_or_next("2026-03-29", "02:30", "Europe/Berlin"),
        Some(date_parse("2026-03-29T01:00:00Z"))
    );
    assert_eq!(
        wall_time_or_next("2026-03-29", "01:30", "Europe/Berlin"),
        Some(date_parse("2026-03-29T00:30:00Z"))
    );
    assert_eq!(
        wall_time_or_next("2026-03-29", "25:00", "Europe/Berlin"),
        None
    );
}
