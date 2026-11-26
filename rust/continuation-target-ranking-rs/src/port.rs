//! The Rust port of `shared/continuation-target-ranking.ts`, delegating to
//! `relay_core::shared::continuation_target_ranking`.
//!
//! Only argument and result conversion lives here: the JSON the bindings carry becomes the
//! relay-core types, and their results become what the TS returns.

#![forbid(unsafe_code)]

mod args;

use relay_core::shared::continuation_target_ranking::{
    self, ContinuationTargetCandidate, RankingContext,
};
use relay_core::shared::types::{Account, AccountUsage, AutoSwitchStrategy};
use serde::Deserialize;
use serde_json::json;

use args::{arg, opt_arg};

/// `Pick<Account, "switchAtPercent">`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SwitchLine {
    #[serde(default)]
    switch_at_percent: Option<f64>,
}

/// The TS `RankingContext`.
#[derive(Deserialize)]
struct Context {
    now: f64,
    #[serde(default)]
    rate: Option<f64>,
    #[serde(default)]
    strategy: Option<AutoSwitchStrategy>,
}

/// A candidate as the TS passes it; `usage` is required but may be `undefined`.
#[derive(Deserialize)]
struct Candidate {
    account: Account,
    #[serde(default)]
    usage: Option<AccountUsage>,
}

/// Port of `switchAtPercent` (`shared/continuation-target-ranking.ts:13`): it reads only the
/// account's own line.
pub fn switch_at_percent(account: serde_json::Value, fallback: f64) -> Result<f64, String> {
    let line: SwitchLine = arg(account)?;
    let account = Account {
        switch_at_percent: line.switch_at_percent,
        ..Account::new("", "")
    };
    Ok(continuation_target_ranking::switch_at_percent(
        &account, fallback,
    ))
}

/// Port of `continuationTargetScore` (`shared/continuation-target-ranking.ts:60`).
pub fn continuation_target_score(
    account: serde_json::Value,
    usage: Option<serde_json::Value>,
) -> Result<f64, String> {
    let account: Account = arg(account)?;
    let usage: Option<AccountUsage> = opt_arg(usage)?;
    Ok(continuation_target_ranking::continuation_target_score(
        &account,
        usage.as_ref(),
    ))
}

/// Port of `rankContinuationTargets` (`shared/continuation-target-ranking.ts:138`): each ranked
/// entry holds the caller's own account and usage objects, as the TS does.
pub fn rank_continuation_targets(
    candidates: Vec<serde_json::Value>,
    context: Option<serde_json::Value>,
) -> Result<Vec<serde_json::Value>, String> {
    let typed = candidates
        .iter()
        .map(|c| arg(c.clone()))
        .collect::<Result<Vec<Candidate>, _>>()?;
    let context: Option<Context> = opt_arg(context)?;
    let borrowed: Vec<ContinuationTargetCandidate<'_>> = typed
        .iter()
        .map(|c| ContinuationTargetCandidate {
            account: &c.account,
            usage: c.usage.as_ref(),
        })
        .collect();
    let ranked = continuation_target_ranking::rank_continuation_targets(
        &borrowed,
        context.map(|c| RankingContext {
            now: c.now,
            rate: c.rate,
            strategy: c.strategy,
        }),
    );
    Ok(ranked
        .into_iter()
        .map(|r| {
            let at = typed
                .iter()
                .position(|c| std::ptr::eq(&c.account, r.account))
                .expect("a ranked account is one of the candidates");
            let original = &candidates[at];
            json!({
                "account": original["account"],
                "usage": original.get("usage").cloned().unwrap_or_else(crate::js::undefined),
                "remainingPercent": crate::js::number(r.remaining_percent),
                "score": crate::js::number(r.score),
            })
        })
        .collect())
}
