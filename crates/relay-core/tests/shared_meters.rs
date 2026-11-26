//! Port of the `shared/feature-risk` and `shared/meters` parts of tests/meters.test.ts. The
//! readers, the service, the store schema and the Overview cases belong to their own ports; the
//! main-source assertions of "turning a meter on…" are source-text checks and are skipped.

use relay_core::shared::external_links::is_external_link;
use relay_core::shared::feature_risk::{
    FeatureRiskId as F, FeaturesInUse, RiskAcknowledgements, RiskLevel, TurnOffStep,
    acknowledge_risks, enabled_risks, feature_risk, meter_risks, policy_link, require_risk_ack,
    turn_off_steps,
};
use relay_core::shared::meters::{METER_PROVIDERS, MeterProvider as P, enabled_meters};
use relay_i18n::{Locale, catalog};

#[test]
fn turning_a_meter_on_needs_its_risk_accepted_in_main_and_in_the_window() {
    let en = catalog(Locale::En);
    // Each meter is R1 on the limits rung, with its maker's terms, allow-listed, and English text.
    for id in [F::MeterCopilot, F::MeterGeminiCli, F::MeterCursor] {
        let risk = feature_risk(id);
        assert_eq!(risk.level, RiskLevel::R1);
        assert_eq!(risk.rung, 2);
        assert!(is_external_link(policy_link(risk.links[0]).href), "{id:?}");
        assert!(
            en.contains_key(risk.title) && en.contains_key(risk.body),
            "{id:?}"
        );
    }
    assert!(en["featureRisk.meterCursorBody"].contains("harvesting, scraping or extracting"));
    assert!(en["featureRisk.meterGeminiCliBody"].contains("direct violation"));

    assert_eq!(
        meter_risks(None, Some(&[P::Cursor, P::Copilot])),
        [F::MeterCursor, F::MeterCopilot]
    );
    assert_eq!(meter_risks(Some(&[P::Cursor]), Some(&[P::Cursor])), []);
    assert_eq!(meter_risks(Some(&[P::Cursor]), Some(&[])), []);
    let message = |pending: &[F]| {
        format!(
            "accept {}",
            pending
                .iter()
                .map(|id| id.as_str())
                .collect::<Vec<_>>()
                .join("+")
        )
    };
    let refused = require_risk_ack(
        Some(&RiskAcknowledgements::new()),
        &meter_risks(None, Some(&[P::GeminiCli])),
        message,
    )
    .unwrap_err();
    assert!(refused.to_string().contains("accept meter-gemini-cli"));
    let accepted = acknowledge_risks(None, &[F::MeterGeminiCli]);
    assert!(
        require_risk_ack(
            Some(&accepted),
            &meter_risks(None, Some(&[P::GeminiCli])),
            message
        )
        .is_ok()
    );

    // A meter turned on without the answer (a restored backup) is asked about, and "Turn it off" keeps the rest.
    let state = FeaturesInUse {
        early_start: false,
        accounts: vec![],
        gateway: None,
        meters: Some(vec![P::Copilot, P::Cursor]),
    };
    assert_eq!(enabled_risks(&state), [F::MeterCopilot, F::MeterCursor]);
    assert_eq!(
        turn_off_steps(&[F::MeterCursor], &state),
        [TurnOffStep::Meters {
            keep: vec![P::Copilot]
        }]
    );
}

#[test]
fn enabled_meters_come_once_each_in_relay_s_order() {
    // Not in the TS file: `enabledMeters` as RiskConsent and main read it.
    assert_eq!(enabled_meters(None), []);
    assert_eq!(
        enabled_meters(Some(&[P::GeminiCli, P::Copilot, P::GeminiCli])),
        [P::Copilot, P::GeminiCli]
    );
    assert_eq!(
        METER_PROVIDERS.map(P::as_str),
        ["copilot", "cursor", "gemini-cli"]
    );
    assert_eq!(
        serde_json::to_string(&P::GeminiCli).unwrap(),
        r#""gemini-cli""#
    );
}
