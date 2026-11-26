//! Port of `cli/src/risk.ts`.

use relay_core::shared::feature_risk::{
    FeatureRiskId, RiskAcknowledgements, RiskLevel, feature_risk, pending_risks, policy_link,
};

use crate::i18n::T;
use crate::io::{CliError, CliIo, exit};

/// Before a command turns on a risky feature: the same risk text the app's dialog shows, on
/// stderr, for each feature not yet accepted in Relay.app. Without --yes it refuses (exit 4), so
/// a script never takes the risk silently; with --yes it goes ahead after the warning.
pub fn require_risk_consent(
    io: &CliIo,
    t: T,
    acknowledged: Option<&RiskAcknowledgements>,
    ids: &[FeatureRiskId],
    yes: bool,
) -> Result<(), CliError> {
    let pending = pending_risks(acknowledged, ids);
    if pending.is_empty() {
        return Ok(());
    }
    for id in pending {
        let risk = feature_risk(id);
        let level = t.t(if risk.level == RiskLevel::R2 {
            "featureRisk.levelAgainstTerms"
        } else {
            "featureRisk.levelGreyArea"
        });
        io.err(&format!("! {} ({level})", t.t(risk.title)));
        io.err(&format!("  {}", t.t(risk.body)));
        for &link in risk.links {
            let link = policy_link(link);
            io.err(&format!("  {}: {}", t.t(link.label), link.href));
        }
    }
    if !yes {
        return Err(CliError::new(t.t("featureRisk.cliPassYes"), exit::CONFIRM));
    }
    Ok(())
}
