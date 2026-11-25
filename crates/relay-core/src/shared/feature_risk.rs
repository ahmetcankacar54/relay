//! Port of `shared/feature-risk.ts`: the features that put an account at risk with its
//! provider's terms. Each is turned on only after the user has read what it risks.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use super::external_links;
use super::meters::MeterProvider;
use super::model_prices::js_trim;
use super::proxy_types::{DEFAULT_PROXY_HOST, ProxyClientId};
use super::proxy_url::is_loopback_host;

/// `FEATURE_RISK_IDS`; the declaration order is the risk order (lowest first).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FeatureRiskId {
    MeterCopilot,
    MeterGeminiCli,
    MeterCursor,
    EarlyStart,
    GatewayCodex,
    GatewayClaude,
    TailscaleBind,
    OmpBinding,
    AntigravityAccount,
    AntigravityGateway,
}

pub const FEATURE_RISK_IDS: [FeatureRiskId; 10] = [
    FeatureRiskId::MeterCopilot,
    FeatureRiskId::MeterGeminiCli,
    FeatureRiskId::MeterCursor,
    FeatureRiskId::EarlyStart,
    FeatureRiskId::GatewayCodex,
    FeatureRiskId::GatewayClaude,
    FeatureRiskId::TailscaleBind,
    FeatureRiskId::OmpBinding,
    FeatureRiskId::AntigravityAccount,
    FeatureRiskId::AntigravityGateway,
];

impl FeatureRiskId {
    pub const fn as_str(self) -> &'static str {
        match self {
            FeatureRiskId::MeterCopilot => "meter-copilot",
            FeatureRiskId::MeterGeminiCli => "meter-gemini-cli",
            FeatureRiskId::MeterCursor => "meter-cursor",
            FeatureRiskId::EarlyStart => "early-start",
            FeatureRiskId::GatewayCodex => "gateway-codex",
            FeatureRiskId::GatewayClaude => "gateway-claude",
            FeatureRiskId::TailscaleBind => "tailscale-bind",
            FeatureRiskId::OmpBinding => "omp-binding",
            FeatureRiskId::AntigravityAccount => "antigravity-account",
            FeatureRiskId::AntigravityGateway => "antigravity-gateway",
        }
    }

    pub fn parse(id: &str) -> Option<Self> {
        FEATURE_RISK_IDS.into_iter().find(|r| r.as_str() == id)
    }
}

/// R1: a grey area the terms do not name. R2: the provider's terms forbid it in so many words.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum RiskLevel {
    R1,
    R2,
}

/// The policy pages a risk cites; every one is on the external-link allow-list.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PolicyLinkId {
    AnthropicAup,
    ClaudeCodeLegal,
    AntigravityFaq,
    AntigravityTerms,
    OpenaiSignIn,
    GithubTerms,
    GeminiCliFaq,
    CursorTerms,
}

/// One entry of `POLICY_LINKS`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PolicyLink {
    pub href: &'static str,
    /// A message id.
    pub label: &'static str,
}

/// `POLICY_LINKS[id]`.
pub const fn policy_link(id: PolicyLinkId) -> PolicyLink {
    let (href, label) = match id {
        PolicyLinkId::AnthropicAup => (external_links::ANTHROPIC_AUP, "featureRisk.linkAnthropicAup"),
        PolicyLinkId::ClaudeCodeLegal => (external_links::CLAUDE_TERMS, "featureRisk.linkClaudeCodeLegal"),
        PolicyLinkId::AntigravityFaq => (external_links::ANTIGRAVITY_TERMS, "featureRisk.linkAntigravityFaq"),
        PolicyLinkId::AntigravityTerms => (external_links::ANTIGRAVITY_SERVICE_TERMS, "featureRisk.linkAntigravityTerms"),
        PolicyLinkId::OpenaiSignIn => (external_links::OPENAI_SIGN_IN, "featureRisk.linkOpenaiSignIn"),
        PolicyLinkId::GithubTerms => (external_links::GITHUB_TERMS, "featureRisk.linkGithubTerms"),
        PolicyLinkId::GeminiCliFaq => (external_links::GEMINI_CLI_FAQ, "featureRisk.linkGeminiCliFaq"),
        PolicyLinkId::CursorTerms => (external_links::CURSOR_TERMS, "featureRisk.linkCursorTerms"),
    };
    PolicyLink { href, label }
}

/// The risk ladder, lowest first (message ids).
pub const RISK_LADDER: [&str; 7] = [
    "featureRisk.ladderSwitching",
    "featureRisk.ladderLimits",
    "featureRisk.ladderEarlyStart",
    "featureRisk.ladderGatewayCodex",
    "featureRisk.ladderGatewayClaude",
    "featureRisk.ladderOmp",
    "featureRisk.ladderAntigravity",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FeatureRisk {
    pub id: FeatureRiskId,
    pub level: RiskLevel,
    /// 1-based position on RISK_LADDER.
    pub rung: u32,
    /// The first link is the one a short note shows beside the text.
    pub links: &'static [PolicyLinkId],
    /// Message ids.
    pub title: &'static str,
    pub body: &'static str,
    /// Raised whenever the title or body says something new: the user is asked again.
    pub text_version: i64,
}

/// `FEATURE_RISKS[id]`.
pub const fn feature_risk(id: FeatureRiskId) -> FeatureRisk {
    use PolicyLinkId as L;
    use RiskLevel::{R1, R2};
    let (level, rung, links, title, body): (RiskLevel, u32, &'static [PolicyLinkId], &str, &str) = match id {
        FeatureRiskId::MeterCopilot => (R1, 2, &[L::GithubTerms], "featureRisk.meterCopilotTitle", "featureRisk.meterCopilotBody"),
        FeatureRiskId::MeterGeminiCli => (
            R1,
            2,
            &[L::GeminiCliFaq],
            "featureRisk.meterGeminiCliTitle",
            "featureRisk.meterGeminiCliBody",
        ),
        FeatureRiskId::MeterCursor => (R1, 2, &[L::CursorTerms], "featureRisk.meterCursorTitle", "featureRisk.meterCursorBody"),
        FeatureRiskId::EarlyStart => (R1, 3, &[L::ClaudeCodeLegal], "featureRisk.earlyStartTitle", "featureRisk.earlyStartBody"),
        FeatureRiskId::GatewayCodex => (R1, 4, &[L::OpenaiSignIn], "featureRisk.gatewayCodexTitle", "featureRisk.gatewayCodexBody"),
        FeatureRiskId::GatewayClaude => (
            R2,
            5,
            &[L::AnthropicAup, L::ClaudeCodeLegal],
            "featureRisk.gatewayClaudeTitle",
            "featureRisk.gatewayClaudeBody",
        ),
        FeatureRiskId::TailscaleBind => (
            R2,
            5,
            &[L::AnthropicAup, L::OpenaiSignIn],
            "featureRisk.tailscaleBindTitle",
            "featureRisk.tailscaleBindBody",
        ),
        FeatureRiskId::OmpBinding => (
            R2,
            6,
            &[L::AnthropicAup, L::ClaudeCodeLegal],
            "featureRisk.ompBindingTitle",
            "featureRisk.ompBindingBody",
        ),
        FeatureRiskId::AntigravityAccount => (
            R2,
            7,
            &[L::AntigravityTerms, L::AntigravityFaq],
            "featureRisk.antigravityAccountTitle",
            "featureRisk.antigravityAccountBody",
        ),
        FeatureRiskId::AntigravityGateway => (
            R2,
            7,
            &[L::AntigravityFaq, L::AntigravityTerms],
            "featureRisk.antigravityGatewayTitle",
            "featureRisk.antigravityGatewayBody",
        ),
    };
    FeatureRisk { id, level, rung, links, title, body, text_version: 1 }
}

/// The text version each feature's risk was accepted at, by feature (insertion order kept, as
/// the JS object keeps it).
pub type RiskAcknowledgements = IndexMap<FeatureRiskId, i64>;

/// True until the user has accepted this feature's current risk text.
pub fn needs_risk_ack(acks: Option<&RiskAcknowledgements>, id: FeatureRiskId) -> bool {
    match acks.and_then(|a| a.get(&id)) {
        None => true,
        Some(&accepted) => accepted < feature_risk(id).text_version,
    }
}

/// The features among `ids` still to accept, once each, lowest risk first.
pub fn pending_risks(acks: Option<&RiskAcknowledgements>, ids: &[FeatureRiskId]) -> Vec<FeatureRiskId> {
    FEATURE_RISK_IDS
        .into_iter()
        .filter(|id| ids.contains(id) && needs_risk_ack(acks, *id))
        .collect()
}

/// The acknowledgements with `ids` accepted at their current text.
pub fn acknowledge_risks(acks: Option<&RiskAcknowledgements>, ids: &[FeatureRiskId]) -> RiskAcknowledgements {
    let mut next = acks.cloned().unwrap_or_default();
    for &id in ids {
        next.insert(id, feature_risk(id).text_version);
    }
    next
}

/// An account as the pool sees it: its id and provider (missing means Claude).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PoolAccount {
    pub id: String,
    pub provider: Option<String>,
}

impl PoolAccount {
    pub fn new(id: impl Into<String>, provider: Option<&str>) -> Self {
        Self { id: id.into(), provider: provider.map(Into::into) }
    }
}

/// Whether the pool (every account not excluded) holds an account of `provider`.
fn pool_has(accounts: &[PoolAccount], excluded: Option<&[String]>, provider: &str) -> bool {
    let excluded = excluded.unwrap_or(&[]);
    accounts
        .iter()
        .filter(|a| !excluded.contains(&a.id))
        .any(|a| a.provider.as_deref().unwrap_or("claude") == provider)
}

/// The gateway as `gateway_risks` reads it.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct GatewayRiskConfig<'a> {
    pub host: &'a str,
    pub excluded_account_ids: Option<&'a [String]>,
    pub bound_clients: Option<&'a [ProxyClientId]>,
}

/// What turning the gateway on risks: Claude and Codex always; Antigravity only when an
/// Antigravity account is in the pool, the tailnet when it listens there, and each bound client.
pub fn gateway_risks(config: &GatewayRiskConfig<'_>, accounts: &[PoolAccount]) -> Vec<FeatureRiskId> {
    let mut risks = vec![FeatureRiskId::GatewayClaude, FeatureRiskId::GatewayCodex];
    if pool_has(accounts, config.excluded_account_ids, "antigravity") {
        risks.push(FeatureRiskId::AntigravityGateway);
    }
    if !is_loopback_host(js_trim(config.host)) {
        risks.push(FeatureRiskId::TailscaleBind);
    }
    for &client in config.bound_clients.unwrap_or(&[]) {
        risks.extend(client_risks(client));
    }
    FEATURE_RISK_IDS.into_iter().filter(|id| risks.contains(id)).collect()
}

/// The gateway's current settings, as `proxy_patch_risks` reads them.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ProxyRiskConfig<'a> {
    pub enabled: bool,
    pub host: &'a str,
    pub excluded_account_ids: Option<&'a [String]>,
}

/// A change to the gateway's settings.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ProxyRiskPatch<'a> {
    pub host: Option<&'a str>,
    pub excluded_account_ids: Option<&'a [String]>,
}

/// What a change to the gateway's settings risks: listening on the tailnet, and, while the
/// gateway is on, letting an Antigravity account into the pool.
pub fn proxy_patch_risks(config: &ProxyRiskConfig<'_>, patch: &ProxyRiskPatch<'_>, accounts: &[PoolAccount]) -> Vec<FeatureRiskId> {
    let mut risks = Vec::new();
    if let Some(host) = patch.host
        && !is_loopback_host(js_trim(host))
    {
        risks.push(FeatureRiskId::TailscaleBind);
    }
    if config.enabled
        && let Some(excluded) = patch.excluded_account_ids
        && pool_has(accounts, Some(excluded), "antigravity")
        && !pool_has(accounts, config.excluded_account_ids, "antigravity")
    {
        risks.push(FeatureRiskId::AntigravityGateway);
    }
    risks
}

/// What pointing a client at the gateway risks: its own provider's requests, or omp passing as
/// Claude Code.
pub fn client_risks(id: ProxyClientId) -> Vec<FeatureRiskId> {
    vec![match id {
        ProxyClientId::Omp => FeatureRiskId::OmpBinding,
        ProxyClientId::Codex => FeatureRiskId::GatewayCodex,
        ProxyClientId::ClaudeCode => FeatureRiskId::GatewayClaude,
    }]
}

/// Adding an Antigravity account; while the gateway is on the account joins its pool as well.
pub fn antigravity_account_risks(gateway_on: bool) -> Vec<FeatureRiskId> {
    if gateway_on {
        vec![FeatureRiskId::AntigravityAccount, FeatureRiskId::AntigravityGateway]
    } else {
        vec![FeatureRiskId::AntigravityAccount]
    }
}

/// A planning change risks something only when it turns early start on.
pub fn planning_risks(before_auto_start: bool, patch_auto_start: Option<bool>) -> Vec<FeatureRiskId> {
    if patch_auto_start == Some(true) && !before_auto_start {
        vec![FeatureRiskId::EarlyStart]
    } else {
        Vec::new()
    }
}

/// A meter's risk: the provider's own terms on reading its usage from outside its tool.
pub const fn meter_risk(provider: MeterProvider) -> FeatureRiskId {
    match provider {
        MeterProvider::Copilot => FeatureRiskId::MeterCopilot,
        MeterProvider::Cursor => FeatureRiskId::MeterCursor,
        MeterProvider::GeminiCli => FeatureRiskId::MeterGeminiCli,
    }
}

/// The meters a settings change turns on (on in `after`, off in `before`), as their risks.
pub fn meter_risks(before: Option<&[MeterProvider]>, after: Option<&[MeterProvider]>) -> Vec<FeatureRiskId> {
    after
        .unwrap_or(&[])
        .iter()
        .filter(|p| !before.is_some_and(|b| b.contains(p)))
        .map(|&p| meter_risk(p))
        .collect()
}

/// The gateway as the window sees it.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct GatewayInUse {
    pub on: bool,
    pub host: String,
    pub excluded_account_ids: Option<Vec<String>>,
    pub bound_clients: Vec<ProxyClientId>,
}

/// What is on right now: early start, the accounts, the gateway and the meters.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct FeaturesInUse {
    pub early_start: bool,
    pub accounts: Vec<PoolAccount>,
    pub gateway: Option<GatewayInUse>,
    pub meters: Option<Vec<MeterProvider>>,
}

/// The risky features already on, lowest risk first. A client bound to a gateway that is off
/// sends nothing, so it counts only while the gateway runs.
pub fn enabled_risks(state: &FeaturesInUse) -> Vec<FeatureRiskId> {
    let mut risks = Vec::new();
    if state.early_start {
        risks.push(FeatureRiskId::EarlyStart);
    }
    risks.extend(state.meters.iter().flatten().map(|&p| meter_risk(p)));
    if state.accounts.iter().any(|a| a.provider.as_deref() == Some("antigravity")) {
        risks.push(FeatureRiskId::AntigravityAccount);
    }
    if let Some(gateway) = state.gateway.as_ref().filter(|g| g.on) {
        let config = GatewayRiskConfig {
            host: &gateway.host,
            excluded_account_ids: gateway.excluded_account_ids.as_deref(),
            bound_clients: Some(&gateway.bound_clients),
        };
        risks.extend(gateway_risks(&config, &state.accounts));
    }
    FEATURE_RISK_IDS.into_iter().filter(|id| risks.contains(id)).collect()
}

/// One call that turns a risky feature off, through the same IPC the pages use.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum TurnOffStep {
    Unbind {
        client: ProxyClientId,
    },
    GatewayOff,
    GatewayHost {
        host: String,
    },
    Exclude {
        #[serde(rename = "accountIds")]
        account_ids: Vec<String>,
    },
    EarlyStartOff,
    RemoveAccount {
        #[serde(rename = "accountId")]
        account_id: String,
    },
    /// The meters to keep on: the others are turned off in one settings change.
    Meters {
        keep: Vec<MeterProvider>,
    },
}

/// How to turn the `pending` features off, in order: clients first, then the gateway as a whole
/// when its Claude or Codex risk was declined, or only its tailnet address or its Antigravity
/// accounts; then early start and the meters; and last the Antigravity accounts themselves.
pub fn turn_off_steps(pending: &[FeatureRiskId], state: &FeaturesInUse) -> Vec<TurnOffStep> {
    let mut steps = Vec::new();
    let antigravity: Vec<&String> = state
        .accounts
        .iter()
        .filter(|a| a.provider.as_deref() == Some("antigravity"))
        .map(|a| &a.id)
        .collect();
    if let Some(gateway) = state.gateway.as_ref().filter(|g| g.on) {
        for &client in &gateway.bound_clients {
            if client_risks(client).iter().any(|id| pending.contains(id)) {
                steps.push(TurnOffStep::Unbind { client });
            }
        }
        if pending.contains(&FeatureRiskId::GatewayClaude) || pending.contains(&FeatureRiskId::GatewayCodex) {
            steps.push(TurnOffStep::GatewayOff);
        } else {
            if pending.contains(&FeatureRiskId::TailscaleBind) {
                steps.push(TurnOffStep::GatewayHost { host: DEFAULT_PROXY_HOST.to_string() });
            }
            if pending.contains(&FeatureRiskId::AntigravityGateway) {
                let excluded = gateway.excluded_account_ids.clone().unwrap_or_default();
                let mut account_ids = excluded.clone();
                account_ids.extend(antigravity.iter().filter(|id| !excluded.contains(id)).map(|id| (*id).clone()));
                steps.push(TurnOffStep::Exclude { account_ids });
            }
        }
    }
    if pending.contains(&FeatureRiskId::EarlyStart) {
        steps.push(TurnOffStep::EarlyStartOff);
    }
    let meters = state.meters.as_deref().unwrap_or(&[]);
    if meters.iter().any(|&p| pending.contains(&meter_risk(p))) {
        steps.push(TurnOffStep::Meters {
            keep: meters.iter().copied().filter(|&p| !pending.contains(&meter_risk(p))).collect(),
        });
    }
    if pending.contains(&FeatureRiskId::AntigravityAccount) {
        for id in antigravity {
            steps.push(TurnOffStep::RemoveAccount { account_id: id.clone() });
        }
    }
    steps
}

/// Raised in main when a feature is turned on before its risk was accepted.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct RiskNotAcknowledged {
    pub ids: Vec<FeatureRiskId>,
    pub message: String,
}

/// Refuses when any of `ids` is not accepted at its current text. `message` words the refusal
/// in the app's language from the features still pending.
pub fn require_risk_ack(
    acks: Option<&RiskAcknowledgements>,
    ids: &[FeatureRiskId],
    message: impl FnOnce(&[FeatureRiskId]) -> String,
) -> Result<(), RiskNotAcknowledged> {
    let pending = pending_risks(acks, ids);
    if pending.is_empty() {
        return Ok(());
    }
    let message = message(&pending);
    Err(RiskNotAcknowledged { ids: pending, message })
}
