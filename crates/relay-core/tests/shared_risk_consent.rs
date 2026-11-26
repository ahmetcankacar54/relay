//! Port of the `shared/feature-risk` cases of tests/risk-consent.test.ts. Skipped: "main gates
//! every risky switch…" (reads electron/main source text), "a registry from before the risk
//! notes…" (store schema: store port), "the consent dialog…" (React UI), and the two CLI cases
//! (CLI port).

use relay_core::shared::external_links::is_external_link;
use relay_core::shared::feature_risk::{
    FEATURE_RISK_IDS, FeatureRiskId as F, FeaturesInUse, GatewayInUse, GatewayRiskConfig,
    PoolAccount, ProxyRiskConfig, ProxyRiskPatch, RISK_LADDER, RiskAcknowledgements, TurnOffStep,
    acknowledge_risks, antigravity_account_risks, client_risks, enabled_risks, feature_risk,
    gateway_risks, needs_risk_ack, pending_risks, planning_risks, policy_link, proxy_patch_risks,
    require_risk_ack, turn_off_steps,
};
use relay_core::shared::proxy_types::ProxyClientId;
use relay_i18n::{Locale, catalog};

fn accounts() -> Vec<PoolAccount> {
    vec![
        PoolAccount::new("c1", Some("claude")),
        PoolAccount::new("x1", Some("codex")),
        PoolAccount::new("g1", Some("antigravity")),
    ]
}

fn strings(ids: &[&str]) -> Vec<String> {
    ids.iter().map(|s| (*s).to_string()).collect()
}

#[test]
fn every_risky_feature_has_a_table_row_with_a_ladder_rung_allow_listed_policy_pages_and_english_text()
 {
    let en = catalog(Locale::En);
    for id in FEATURE_RISK_IDS {
        let risk = feature_risk(id);
        assert_eq!(risk.id, id);
        assert!(
            risk.rung >= 1 && risk.rung as usize <= RISK_LADDER.len(),
            "{id:?}"
        );
        assert!(risk.text_version >= 1, "{id:?}");
        assert!(!risk.links.is_empty(), "{id:?}");
        for link in risk.links {
            assert!(
                is_external_link(policy_link(*link).href),
                "{id:?}: {link:?}"
            );
        }
        assert!(
            en.contains_key(risk.title) && en.contains_key(risk.body),
            "{id:?}"
        );
    }
    // The gateway's Claude risk is the one the gateway head shows: it names and links the Usage Policy.
    assert_eq!(
        policy_link(feature_risk(F::GatewayClaude).links[0]).href,
        "https://www.anthropic.com/legal/aup"
    );
    assert!(
        en["featureRisk.gatewayClaudeBody"]
            .contains("Usage Policy, in force from 12 November 2026")
    );
    assert!(en["featureRisk.ompBindingBody"].contains("as Claude Code"));
}

#[test]
fn a_risk_is_asked_until_accepted_at_its_current_text_and_again_once_the_text_changes() {
    let none = RiskAcknowledgements::new();
    assert!(needs_risk_ack(None, F::GatewayClaude));
    assert!(needs_risk_ack(Some(&none), F::GatewayClaude));
    let accepted = acknowledge_risks(Some(&none), &[F::GatewayClaude]);
    assert!(!needs_risk_ack(Some(&accepted), F::GatewayClaude));
    assert!(needs_risk_ack(Some(&accepted), F::GatewayCodex));
    // Accepted under an older text: a raised textVersion asks again.
    let older: RiskAcknowledgements = [(
        F::GatewayClaude,
        feature_risk(F::GatewayClaude).text_version - 1,
    )]
    .into_iter()
    .collect();
    assert!(needs_risk_ack(Some(&older), F::GatewayClaude));
    // Accepting more keeps what was accepted before.
    let more = acknowledge_risks(Some(&accepted), &[F::EarlyStart]);
    assert_eq!(
        serde_json::to_string(&more).unwrap(),
        format!(
            r#"{{"gateway-claude":{},"early-start":{}}}"#,
            feature_risk(F::GatewayClaude).text_version,
            feature_risk(F::EarlyStart).text_version
        )
    );
    // Pending risks come once each, lowest risk first.
    assert_eq!(
        pending_risks(
            Some(&accepted),
            &[
                F::AntigravityGateway,
                F::GatewayClaude,
                F::EarlyStart,
                F::EarlyStart
            ]
        ),
        [F::EarlyStart, F::AntigravityGateway]
    );
}

#[test]
fn each_way_to_turn_a_risky_feature_on_names_its_risks() {
    let accounts = accounts();
    let gateway = |host| GatewayRiskConfig {
        host,
        ..Default::default()
    };
    // The gateway answers Claude and Codex whatever the pool holds; Antigravity only when pooled.
    assert_eq!(
        gateway_risks(&gateway("127.0.0.1"), &[]),
        [F::GatewayCodex, F::GatewayClaude]
    );
    assert_eq!(
        gateway_risks(&gateway("127.0.0.1"), &accounts),
        [F::GatewayCodex, F::GatewayClaude, F::AntigravityGateway]
    );
    let g1 = strings(&["g1"]);
    assert_eq!(
        gateway_risks(
            &GatewayRiskConfig {
                host: "127.0.0.1",
                excluded_account_ids: Some(&g1),
                bound_clients: None
            },
            &accounts
        ),
        [F::GatewayCodex, F::GatewayClaude]
    );
    assert_eq!(
        gateway_risks(&gateway("100.101.12.34"), &[]),
        [F::GatewayCodex, F::GatewayClaude, F::TailscaleBind]
    );
    // A client still bound when the gateway starts again counts too: omp passes as Claude Code.
    let omp = [ProxyClientId::Omp];
    assert_eq!(
        gateway_risks(
            &GatewayRiskConfig {
                host: "127.0.0.1",
                excluded_account_ids: None,
                bound_clients: Some(&omp)
            },
            &[]
        ),
        [F::GatewayCodex, F::GatewayClaude, F::OmpBinding]
    );

    let on = ProxyRiskConfig {
        enabled: true,
        host: "127.0.0.1",
        excluded_account_ids: Some(&g1),
    };
    let host = |h| ProxyRiskPatch {
        host: Some(h),
        excluded_account_ids: None,
    };
    let exclude = |ids: &'static [String]| ProxyRiskPatch {
        host: None,
        excluded_account_ids: Some(ids),
    };
    assert_eq!(
        proxy_patch_risks(&on, &host("100.101.12.34"), &accounts),
        [F::TailscaleBind]
    );
    assert_eq!(proxy_patch_risks(&on, &host("::1"), &accounts), []);
    assert_eq!(
        proxy_patch_risks(&on, &exclude(&[]), &accounts),
        [F::AntigravityGateway]
    );
    let g1_x1 = strings(&["g1", "x1"]);
    assert_eq!(
        proxy_patch_risks(
            &on,
            &ProxyRiskPatch {
                host: None,
                excluded_account_ids: Some(&g1_x1)
            },
            &accounts
        ),
        []
    );
    // Off, the pool is judged when the gateway is turned on.
    let off = ProxyRiskConfig {
        enabled: false,
        ..on
    };
    assert_eq!(proxy_patch_risks(&off, &exclude(&[]), &accounts), []);

    assert_eq!(client_risks(ProxyClientId::ClaudeCode), [F::GatewayClaude]);
    assert_eq!(client_risks(ProxyClientId::Codex), [F::GatewayCodex]);
    assert_eq!(client_risks(ProxyClientId::Omp), [F::OmpBinding]);
    assert_eq!(antigravity_account_risks(false), [F::AntigravityAccount]);
    assert_eq!(
        antigravity_account_risks(true),
        [F::AntigravityAccount, F::AntigravityGateway]
    );
    assert_eq!(planning_risks(false, Some(true)), [F::EarlyStart]);
    assert_eq!(planning_risks(true, Some(true)), []);
    assert_eq!(planning_risks(false, None), []);
}

#[test]
fn features_already_on_before_relay_asked_are_found_and_only_the_unaccepted_ones_are_asked() {
    // What `featuresInUse` (src/components/RiskConsent.tsx) builds from the settings and the
    // gateway's status: early start on, the gateway running on the tailnet, g1 out of the pool,
    // omp bound.
    let state = FeaturesInUse {
        early_start: true,
        accounts: accounts(),
        gateway: Some(GatewayInUse {
            on: true,
            host: "100.101.12.34".into(),
            excluded_account_ids: Some(strings(&["g1"])),
            bound_clients: vec![ProxyClientId::Omp],
        }),
        meters: Some(vec![]),
    };
    assert_eq!(
        enabled_risks(&state),
        [
            F::EarlyStart,
            F::GatewayCodex,
            F::GatewayClaude,
            F::TailscaleBind,
            F::OmpBinding,
            F::AntigravityAccount
        ]
    );
    // Accepted ones are not asked again; the rest are, before anything is turned off.
    let partly = acknowledge_risks(None, &[F::EarlyStart, F::GatewayCodex, F::GatewayClaude]);
    assert_eq!(
        pending_risks(Some(&partly), &enabled_risks(&state)),
        [F::TailscaleBind, F::OmpBinding, F::AntigravityAccount]
    );
    // Off and unbound, nothing of the gateway counts; nothing at all with early start off and no Antigravity.
    let off = FeaturesInUse {
        early_start: true,
        accounts: accounts()[..2].to_vec(),
        gateway: Some(GatewayInUse {
            on: false,
            host: "100.101.12.34".into(),
            excluded_account_ids: Some(strings(&["g1"])),
            bound_clients: vec![ProxyClientId::Omp],
        }),
        meters: Some(vec![]),
    };
    assert_eq!(enabled_risks(&off), [F::EarlyStart]);
    let default = FeaturesInUse {
        early_start: false,
        accounts: vec![],
        gateway: Some(GatewayInUse {
            on: false,
            host: "127.0.0.1".into(),
            excluded_account_ids: None,
            bound_clients: vec![],
        }),
        meters: Some(vec![]),
    };
    assert_eq!(enabled_risks(&default), []);
    // Before the gateway's state is read, the saved switch still counts.
    let saved = FeaturesInUse {
        early_start: true,
        accounts: vec![],
        gateway: Some(GatewayInUse {
            on: true,
            host: "100.101.12.34".into(),
            excluded_account_ids: None,
            bound_clients: vec![],
        }),
        meters: Some(vec![]),
    };
    assert_eq!(
        enabled_risks(&saved),
        [
            F::EarlyStart,
            F::GatewayCodex,
            F::GatewayClaude,
            F::TailscaleBind
        ]
    );

    // "Turn it off": clients first, then only the declined part of the gateway, then the rest.
    assert_eq!(
        turn_off_steps(
            &[F::TailscaleBind, F::OmpBinding, F::AntigravityAccount],
            &state
        ),
        [
            TurnOffStep::Unbind {
                client: ProxyClientId::Omp
            },
            TurnOffStep::GatewayHost {
                host: "127.0.0.1".into()
            },
            TurnOffStep::RemoveAccount {
                account_id: "g1".into()
            },
        ]
    );
    assert_eq!(
        turn_off_steps(&[F::EarlyStart, F::GatewayClaude, F::TailscaleBind], &state),
        [TurnOffStep::GatewayOff, TurnOffStep::EarlyStartOff]
    );
    let mut pooled = state.clone();
    pooled.gateway.as_mut().unwrap().excluded_account_ids = Some(strings(&["x1"]));
    let steps = turn_off_steps(&[F::AntigravityGateway], &pooled);
    assert_eq!(
        steps,
        [TurnOffStep::Exclude {
            account_ids: strings(&["x1", "g1"])
        }]
    );
    // The steps keep the IPC shape the window sends.
    assert_eq!(
        serde_json::to_string(&steps).unwrap(),
        r#"[{"kind":"exclude","accountIds":["x1","g1"]}]"#
    );
}

#[test]
fn main_refuses_a_risky_feature_without_its_acceptance_and_words_the_refusal_from_the_pending_ones()
{
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
    let error = require_risk_ack(
        Some(&RiskAcknowledgements::new()),
        &[F::GatewayClaude, F::GatewayCodex],
        message,
    )
    .unwrap_err();
    assert_eq!(error.to_string(), "accept gateway-codex+gateway-claude");
    assert_eq!(error.ids, [F::GatewayCodex, F::GatewayClaude]);
    let accepted = acknowledge_risks(None, &[F::GatewayClaude, F::GatewayCodex]);
    assert!(
        require_risk_ack(
            Some(&accepted),
            &[F::GatewayClaude, F::GatewayCodex],
            message
        )
        .is_ok()
    );
    let refused = require_risk_ack(Some(&accepted), &[F::TailscaleBind], message).unwrap_err();
    assert!(refused.to_string().contains("accept tailscale-bind"));
}
