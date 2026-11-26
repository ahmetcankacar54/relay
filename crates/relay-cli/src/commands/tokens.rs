use std::path::Path;

use relay_core::continuation_journal::{MAX_BYTES, read_private_json};
use relay_core::fs_util::parse_iso_ms;
use relay_core::shared::number_format::{format_cost, format_tokens};
use relay_core::shared::token_usage_view::{
    LedgerSnapshot, TokenCounts, TokenUsageInput, build_token_usage_view, token_row_label,
};
use relay_core::token_ledger::LedgerProgress;
use relay_i18n::Args;
use serde_json::Value;

use crate::CommandRun;
use crate::accounts::resolve_account;
use crate::context::{Needs, open_context};
use crate::errors::CliResult;
use crate::io::{CliError, exit};
use crate::output::{print_json, table};
use crate::util::js_number;

fn total(c: &TokenCounts) -> f64 {
    c.input + c.output + c.cache_write + c.cache_read
}

/// The ledger Relay.app keeps, as the view builder takes it; `None` when there is none.
fn read_ledger(file: &Path) -> CliResult<Option<LedgerSnapshot>> {
    if !file.exists() {
        return Ok(None);
    }
    // readPrivateJson allocates its limit up front: give it the file's size (it re-checks), not
    // the 64 MB cap.
    let size = std::fs::symlink_metadata(file)?.len();
    let cap: u64 = 64 * 1024 * 1024;
    if size > cap {
        return Err(CliError::new(
            "The token ledger is larger than relay reads (64 MB).",
            exit::FAILED,
        )
        .into());
    }
    let saved = read_private_json(file, cap.min(size + 64 * 1024))?;
    // Relay.app has written version 3 since 2026-10-18; it reads version 2 the same way.
    let version = saved.get("version").and_then(Value::as_f64);
    let days = saved.get("days").filter(|d| d.is_object());
    let (Some(2.0 | 3.0), Some(days)) = (version, days) else {
        return Err(CliError::new(
            "The token ledger is in a format this relay does not know. Update relay.",
            exit::ENVIRONMENT,
        )
        .into());
    };
    let (mut scanned, mut total_bytes) = (0.0, 0.0);
    if let Some(files) = saved.get("files").and_then(Value::as_object) {
        for state in files.values() {
            if state.get("broken").is_some_and(truthy) {
                continue;
            }
            scanned += number_or_zero(state.get("offset"));
            total_bytes += number_or_zero(state.get("size"));
        }
    }
    let slots = saved.get("slots").filter(|s| s.is_object() && !s.is_null());
    Ok(Some(LedgerSnapshot {
        days: serde_json::from_value(days.clone())?,
        slots: slots
            .map(|s| serde_json::from_value(s.clone()))
            .transpose()?,
        slots_since: saved.get("slotsSince").and_then(Value::as_f64),
        progress: LedgerProgress {
            scanned_bytes: scanned,
            total_bytes,
            complete: saved.get("complete") == Some(&Value::Bool(true)),
            error: None,
        },
    }))
}

fn truthy(value: &Value) -> bool {
    relay_core::desktop_files::js_truthy(value)
}

/// `Number(x) || 0`.
fn number_or_zero(value: Option<&Value>) -> f64 {
    let n = match value {
        None | Some(Value::Null) => f64::NAN,
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::String(s)) => js_number(s),
        Some(Value::Array(a)) if a.is_empty() => 0.0,
        Some(_) => f64::NAN,
    };
    if n.is_nan() { 0.0 } else { n }
}

/// When the active-account timeline began: its first segment's start. Read only, never rewritten.
fn exact_since(file: &Path) -> Option<f64> {
    let value = read_private_json(file, MAX_BYTES).ok()?;
    if value.get("version").and_then(Value::as_f64) != Some(1.0) {
        return None;
    }
    let from = value.get("segments")?.get(0)?.get("from")?.as_str()?;
    parse_iso_ms(from).map(|ms| ms as f64)
}

pub fn tokens(run: &CommandRun<'_>) -> CliResult<i32> {
    let (io, t, lang) = (run.io, run.t, run.lang);
    if !run.parsed.positionals.is_empty() {
        return Err(CliError::new(t.t("tokens.usageRelayTokensDays730"), exit::USAGE).into());
    }
    let days = run.parsed.flags.str("days").map_or(7.0, js_number);
    if ![7.0, 30.0, 90.0].contains(&days) {
        return Err(CliError::new(t.t("tokens.daysMustBe730Or"), exit::USAGE).into());
    }
    let ctx = open_context(io, run.deps, &run.parsed.flags, Needs::READ)?;
    let Some(ledger) = read_ledger(&ctx.paths.data.join("token-ledger.json"))? else {
        io.out(&t.t("tokens.thereIsNoTokenLedgerYet"));
        return Ok(exit::OK);
    };
    let registry = ctx.store.state();
    let accounts = &registry.accounts;
    let account = match run.parsed.flags.str("account").filter(|a| !a.is_empty()) {
        Some(query) => Some(resolve_account(accounts, query, t)?),
        None => None,
    };
    let zone = registry.settings.planning.time_zone.clone();
    let view = build_token_usage_view(&TokenUsageInput {
        ledger: &ledger,
        accounts,
        range: days as u32,
        account_id: account.map(|a| a.id.as_str()),
        zone: &zone,
        now: io.now() as f64,
        exact_since: exact_since(&ctx.paths.data.join("active-account-timeline.json")),
    });
    if ctx.json {
        print_json(io, &serde_json::to_value(&view)?);
        return Ok(exit::OK);
    }
    let n = |value: f64| format_tokens(value, lang);
    let usd = |value: f64| format_cost(value, lang);
    io.out(&t.f(
        "tokens.tokenUsageLastDays",
        Args::new().set("days", days).set("zone", zone.as_str()),
    ));
    let totals = &view.totals;
    io.out(
        &t.f(
            "tokens.totalInputOutputCacheWriteCache",
            Args::new()
                .set("total", n(total(totals)))
                .set("input", n(totals.input))
                .set("output", n(totals.output))
                .set("cacheWrite", n(totals.cache_write))
                .set("cacheRead", n(totals.cache_read))
                .set(
                    "cost",
                    format!(
                        "{}{}",
                        if totals.cost_estimated == Some(true) {
                            "≈"
                        } else {
                            ""
                        },
                        usd(totals.cost.unwrap_or(0.0))
                    ),
                ),
        ),
    );
    if !view.rows.is_empty() {
        let rows: Vec<Vec<String>> = view
            .days
            .iter()
            .rev()
            .map(|day| {
                let mut cells = vec![day.date.clone()];
                for row in &view.rows {
                    cells.push(match day.by_row.get(&row.key) {
                        Some(cell) if total(&cell.counts) != 0.0 => {
                            format!(
                                "{}{}",
                                if cell.estimated { "≈" } else { "" },
                                n(total(&cell.counts))
                            )
                        }
                        _ => "—".into(),
                    });
                }
                let cells_iter = || day.by_row.values();
                // `reduce(…, 0)`: an empty day adds up to 0, never -0.
                cells.push(n(cells_iter().fold(0.0, |sum, c| sum + total(&c.counts))));
                cells.push(format!(
                    "{}{}",
                    if cells_iter().any(|c| c.counts.cost_estimated == Some(true)) {
                        "≈"
                    } else {
                        ""
                    },
                    usd(cells_iter().fold(0.0, |sum, c| sum + c.counts.cost.unwrap_or(0.0)))
                ));
                cells
            })
            .collect();
        let mut headers = vec![t.t("tokens.day")];
        for row in &view.rows {
            headers.push(match token_row_label(row.kind) {
                Some(id) => t.t(id),
                None => row.name.clone().unwrap_or_default(),
            });
        }
        headers.push(t.t("common.total"));
        headers.push(t.t("common.apiValue"));
        io.out("");
        io.out(&table(&headers, &rows));
    }
    io.out("");
    if let Some(since) = view.exact_since.as_deref().filter(|s| !s.is_empty()) {
        io.out(&t.f(
            "tokens.exactAccountMatchingHasBeenKept",
            Args::new().set("viewExactSince", since),
        ));
    }
    io.out(&t.f(
        "tokens.apiValueAnthropicApiListPrices",
        Args::new().set("viewPricesChecked", view.prices_checked.as_str()),
    ));
    if !view.progress.complete {
        io.out(&t.f(
            "tokens.transcriptsAreStillBeingScanned",
            Args::new().set("progressPercent", view.progress.percent),
        ));
    }
    Ok(exit::OK)
}
