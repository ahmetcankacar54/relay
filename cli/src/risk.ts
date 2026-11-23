import { CliError, EXIT, type CliIO } from "./io";
import { FEATURE_RISKS, POLICY_LINKS, pendingRisks, type FeatureRiskId, type RiskAcknowledgements } from "../../shared/feature-risk";
import type { T } from "../../shared/i18n/translate";

/**
 * Before a command turns on a risky feature: the same risk text the app's dialog shows, on
 * stderr, for each feature not yet accepted in Relay.app. Without --yes it refuses (exit 4), so
 * a script never takes the risk silently; with --yes it goes ahead after the warning.
 */
export function requireRiskConsent(
  io: CliIO,
  t: T,
  settings: { riskAcknowledged?: RiskAcknowledgements },
  ids: readonly FeatureRiskId[],
  yes: boolean,
): void {
  const pending = pendingRisks(settings, ids);
  if (!pending.length) return;
  for (const id of pending) {
    const risk = FEATURE_RISKS[id];
    const level = t(risk.level === "R2" ? "featureRisk.levelAgainstTerms" : "featureRisk.levelGreyArea");
    io.stderr(`! ${t(risk.title)} (${level})`);
    io.stderr(`  ${t(risk.body)}`);
    for (const link of risk.links) io.stderr(`  ${t(POLICY_LINKS[link].label)}: ${POLICY_LINKS[link].href}`);
  }
  if (!yes) throw new CliError(t("featureRisk.cliPassYes"), EXIT.confirm);
}
