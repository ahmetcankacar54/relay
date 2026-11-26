//! Port of the CLI cases of `tests/risk-consent.test.ts` (`cli/src/risk.ts` and
//! `relay proxy start`). The risk table and the app's gates are relay-core's
//! (`crates/relay-core/tests/shared_risk_consent.rs`) or the UI's.

mod common;

use common::{Options, cli_fixture};
use relay_cli::i18n::T;
use relay_cli::io::exit;
use relay_cli::risk::require_risk_consent;
use relay_core::shared::feature_risk::{FeatureRiskId, RiskAcknowledgements, acknowledge_risks};
use relay_i18n::Locale;

#[test]
fn the_cli_prints_the_risk_and_refuses_without_yes() {
    let f = cli_fixture(Options::default());
    let t = T(Locale::En);
    let ids = [FeatureRiskId::GatewayClaude];
    let none = RiskAcknowledgements::default();
    let error = require_risk_consent(&f.io, t, Some(&none), &ids, false).unwrap_err();
    assert_eq!(error.code, exit::CONFIRM);
    assert!(error.message.contains("--yes"));
    let err = f.err();
    let claude = err
        .find("Gateway with Claude accounts (Against the terms)")
        .unwrap();
    let policy = err[claude..].find("Usage Policy").unwrap() + claude;
    assert!(err[policy..].contains("https://www.anthropic.com/legal/aup"));
    // With --yes the warning still shows, and the command goes ahead.
    f.clear();
    require_risk_consent(&f.io, t, Some(&none), &ids, true).unwrap();
    assert!(f.err().contains("anthropic.com/legal/aup"));
    // Accepted in Relay.app: nothing to say.
    f.clear();
    let accepted = acknowledge_risks(None, &ids);
    require_risk_consent(&f.io, t, Some(&accepted), &ids, false).unwrap();
    assert_eq!(f.err(), "");
}

#[cfg(target_os = "macos")]
#[test]
fn relay_proxy_start_refuses_without_yes_before_it_listens() {
    let f = cli_fixture(Options::default());
    assert_eq!(f.run(&["proxy", "start", "--port", "1"]), exit::CONFIRM);
    let err = f.err();
    let codex = err.find("Gateway with Codex accounts").unwrap();
    let claude = err[codex..].find("Gateway with Claude accounts").unwrap() + codex;
    assert!(err[claude..].contains("--yes"));
    assert!(!f.out().contains("Starting Relay Proxy Gateway"));
}
