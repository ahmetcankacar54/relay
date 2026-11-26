//! What the windows read: the snapshots, usage statistics, token usage and the lost-and-found
//! (port of electron/main/ipc/snapshots.ts).

use relay_core::draft_main::draft_summaries;
use relay_core::shared::lost_found::{LostFoundInput, LostSegment, lost_found_collection};
use relay_core::shared::token_usage_view::{TokenUsageInput, build_token_usage_view};
use relay_core::shared::usage_statistics_view::{
    StatisticsHours, StatisticsInput, build_statistics_view,
};
use relay_core::sidebar_main::sidebar_summary;
use relay_core::token_ledger::{LastTick, LedgerDays};
use relay_core::usage_statistics_input::parse_usage_statistics_input;
use serde::Serialize;
use serde_json::{Map, Value};

use super::{Call, IpcResult, Registry, reply, zod_message};
use crate::services::tokens_widget::{
    TOKEN_FRESH_MS, TOKEN_REFRESH_BUDGET_MS, has_ledger, ledger_snapshot, token_last_tick,
    token_tick, token_ticked_at,
};
use crate::state::{STATE, lock};

pub fn register(registry: &mut Registry) {
    registry.handle("panel-snapshot", panel_snapshot);
    registry.handle("snapshot", snapshot);
    registry.handle("usage-statistics", usage_statistics);
    registry.handle("token-usage", token_usage);
    registry.handle("lost-found-collection", lost_found);
}

fn now() -> f64 {
    relay_core::clock::now_ms() as f64
}

/// `{ ...base, key: value }`: a key already there keeps its place; `undefined` adds nothing.
fn put(out: &mut Map<String, Value>, key: &str, value: Option<impl Serialize>) {
    if let Some(value) = value.and_then(|value| serde_json::to_value(value).ok()) {
        out.insert(key.to_owned(), value);
    }
}

fn object(value: impl Serialize) -> Result<Map<String, Value>, String> {
    match serde_json::to_value(value).map_err(|e| e.to_string())? {
        Value::Object(map) => Ok(map),
        _ => Err("snapshot is not an object".into()),
    }
}

/// The keys both snapshots add after `windows`, `update` and the snapshot's own ones.
fn automation_keys(out: &mut Map<String, Value>) {
    let desktop = STATE.desktop();
    put(out, "continuation", Some(STATE.continuation().snapshot()));
    put(out, "fleet", Some(STATE.fleet().snapshot()));
    put(out, "autoSwitch", Some(STATE.auto_switch().snapshot()));
    put(out, "planning", Some(STATE.keeper().snapshot()));
    put(out, "drafts", Some(draft_summaries(&**desktop)));
    put(
        out,
        "sidebar",
        sidebar_summary(|| Ok::<_, ()>(desktop.sidebar_gap())),
    );
    put(out, "extension", desktop.extension_offer());
}

fn panel_snapshot(_: &Call) -> IpcResult {
    let mut out = object(STATE.service().panel_snapshot())?;
    put(
        &mut out,
        "windows",
        crate::services::desktop_support::separate_windows(),
    );
    put(&mut out, "update", crate::services::updates::state());
    put(
        &mut out,
        "antigravity",
        crate::services::antigravity::antigravity_app(),
    );
    put(
        &mut out,
        "usage",
        Some(crate::services::desktop_support::display_usage()),
    );
    automation_keys(&mut out);
    Ok(Value::Object(out))
}

fn snapshot(_: &Call) -> IpcResult {
    let service = STATE.service();
    service.transaction(|| {
        let mut out = object(service.snapshot())?;
        put(
            &mut out,
            "windows",
            crate::services::desktop_support::separate_windows(),
        );
        put(&mut out, "update", crate::services::updates::state());
        put(
            &mut out,
            "shortcuts",
            STATE
                .global_shortcuts
                .get()
                .map(|shortcuts| lock(shortcuts).status()),
        );
        put(
            &mut out,
            "antigravity",
            crate::services::antigravity::antigravity_app(),
        );
        put(
            &mut out,
            "meters",
            Some(crate::services::notifications::meters_snapshot()),
        );
        put(
            &mut out,
            "usage",
            Some(crate::services::desktop_support::display_usage()),
        );
        automation_keys(&mut out);
        Ok(Value::Object(out))
    })
}

fn usage_statistics(call: &Call) -> IpcResult {
    let input = parse_usage_statistics_input(call.arg(0)).map_err(|e| zod_message(&e))?;
    let (accounts, planning) = STATE
        .service()
        .store
        .with_state(|s| (s.accounts.clone(), s.settings.planning.clone()));
    let (rollups, available) = {
        let history = lock(STATE.usage_history());
        (history.rollups(), history.rollups_available)
    };
    reply(build_statistics_view(&StatisticsInput {
        rollups: rollups.as_ref(),
        available,
        accounts: &accounts,
        range: input.range,
        account_id: input.account_id.as_deref(),
        zone: &planning.time_zone,
        now: now(),
        hours: Some(&StatisticsHours {
            weekday: planning.weekday.clone(),
            weekend: planning.weekend.clone(),
        }),
    }))
}

fn token_usage(call: &Call) -> IpcResult {
    let input = parse_usage_statistics_input(call.arg(0)).map_err(|e| zod_message(&e))?;
    if !has_ledger() {
        return Err(crate::i18n::say(
            "electronMain.relayCannotReadTheTokenUsage",
        ));
    }
    if now() - token_ticked_at() > TOKEN_FRESH_MS {
        // Ticks until the pass is complete or about a second has passed.
        let until = now() + TOKEN_REFRESH_BUDGET_MS;
        loop {
            token_tick();
            match token_last_tick() {
                LastTick::Ticked(result) if !result.complete && now() < until => {}
                _ => break,
            }
        }
    }
    let exact_since = lock(STATE.active_timeline()).exact_since();
    let Some(ledger) = ledger_snapshot() else {
        return Err(crate::i18n::say(
            "electronMain.relayCannotReadTheTokenUsage",
        ));
    };
    let (accounts, zone) = STATE
        .service()
        .store
        .with_state(|s| (s.accounts.clone(), s.settings.planning.time_zone.clone()));
    reply(build_token_usage_view(&TokenUsageInput {
        ledger: &ledger,
        accounts: &accounts,
        range: input.range,
        account_id: input.account_id.as_deref(),
        zone: &zone,
        now: now(),
        exact_since,
    }))
}

fn lost_found(_: &Call) -> IpcResult {
    let ledger = ledger_snapshot();
    let rollups = lock(STATE.usage_history()).rollups();
    let segments: Vec<LostSegment> = lock(STATE.active_timeline())
        .list()
        .into_iter()
        .map(|segment| LostSegment {
            account_uuid: segment.account_uuid,
            org_id: segment.org_id,
            from: segment.from,
            to: segment.to,
        })
        .collect();
    let (accounts, zone) = STATE
        .service()
        .store
        .with_state(|s| (s.accounts.clone(), s.settings.planning.time_zone.clone()));
    let empty = LedgerDays::new();
    reply(lost_found_collection(&LostFoundInput {
        rollups: rollups.as_ref(),
        segments: &segments,
        ledger_days: ledger.as_ref().map_or(&empty, |ledger| &ledger.days),
        ledger_slots: ledger.as_ref().and_then(|ledger| ledger.slots.as_ref()),
        slots_since: ledger.as_ref().and_then(|ledger| ledger.slots_since),
        accounts: &accounts,
        zone: &zone,
        now: now(),
        week_start: None,
    }))
}
