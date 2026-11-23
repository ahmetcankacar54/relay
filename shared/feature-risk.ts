import { EXTERNAL_LINKS } from "./external-links";
import type { MeterProvider } from "./meters";
import type { MessageId } from "./i18n/translate";
import { DEFAULT_PROXY_CONFIG, type ProxyClientId } from "./proxy-types";
import { LOOPBACK_HOSTS } from "./proxy-url";

/**
 * The features that put an account at risk with its provider's terms. Each is turned on only
 * after the user has read what it risks: the window asks once, main refuses without the answer,
 * and the CLI asks for `--yes`.
 */
export const FEATURE_RISK_IDS = [
  "meter-copilot",
  "meter-gemini-cli",
  "meter-cursor",
  "early-start",
  "gateway-codex",
  "gateway-claude",
  "tailscale-bind",
  "omp-binding",
  "antigravity-account",
  "antigravity-gateway",
] as const;
export type FeatureRiskId = (typeof FEATURE_RISK_IDS)[number];

/** R1: a grey area the terms do not name. R2: the provider's terms forbid it in so many words. */
export type RiskLevel = "R1" | "R2";

/** The policy pages a risk cites; every one is on the external-link allow-list. */
export const POLICY_LINKS = {
  anthropicAup: { href: EXTERNAL_LINKS.anthropicAup, label: "featureRisk.linkAnthropicAup" },
  claudeCodeLegal: { href: EXTERNAL_LINKS.claudeTerms, label: "featureRisk.linkClaudeCodeLegal" },
  antigravityFaq: { href: EXTERNAL_LINKS.antigravityTerms, label: "featureRisk.linkAntigravityFaq" },
  antigravityTerms: { href: EXTERNAL_LINKS.antigravityServiceTerms, label: "featureRisk.linkAntigravityTerms" },
  openaiSignIn: { href: EXTERNAL_LINKS.openaiSignIn, label: "featureRisk.linkOpenaiSignIn" },
  githubTerms: { href: EXTERNAL_LINKS.githubTerms, label: "featureRisk.linkGithubTerms" },
  geminiCliFaq: { href: EXTERNAL_LINKS.geminiCliFaq, label: "featureRisk.linkGeminiCliFaq" },
  cursorTerms: { href: EXTERNAL_LINKS.cursorTerms, label: "featureRisk.linkCursorTerms" },
} as const satisfies Record<string, { href: string; label: MessageId }>;
export type PolicyLinkId = keyof typeof POLICY_LINKS;

/**
 * The risk ladder, lowest first (the 2026-11-23 audit, section 3). Switching your own Claude app
 * accounts and reading limits are on it for scale; reading Claude's limits asks nothing, reading
 * another tool's (a meter) asks, since those tools' terms say more about it.
 */
export const RISK_LADDER: readonly MessageId[] = [
  "featureRisk.ladderSwitching",
  "featureRisk.ladderLimits",
  "featureRisk.ladderEarlyStart",
  "featureRisk.ladderGatewayCodex",
  "featureRisk.ladderGatewayClaude",
  "featureRisk.ladderOmp",
  "featureRisk.ladderAntigravity",
];

export interface FeatureRisk {
  id: FeatureRiskId;
  level: RiskLevel;
  /** 1-based position on RISK_LADDER. */
  rung: number;
  /** The first link is the one a short note shows beside the text. */
  links: readonly PolicyLinkId[];
  title: MessageId;
  body: MessageId;
  /**
   * Raised whenever the title or body says something new: an answer given to an older text
   * no longer counts, and the user is asked again.
   */
  textVersion: number;
}

export const FEATURE_RISKS: Readonly<Record<FeatureRiskId, FeatureRisk>> = {
  "meter-copilot": {
    id: "meter-copilot",
    level: "R1",
    rung: 2,
    links: ["githubTerms"],
    title: "featureRisk.meterCopilotTitle",
    body: "featureRisk.meterCopilotBody",
    textVersion: 1,
  },
  "meter-gemini-cli": {
    id: "meter-gemini-cli",
    level: "R1",
    rung: 2,
    links: ["geminiCliFaq"],
    title: "featureRisk.meterGeminiCliTitle",
    body: "featureRisk.meterGeminiCliBody",
    textVersion: 1,
  },
  "meter-cursor": {
    id: "meter-cursor",
    level: "R1",
    rung: 2,
    links: ["cursorTerms"],
    title: "featureRisk.meterCursorTitle",
    body: "featureRisk.meterCursorBody",
    textVersion: 1,
  },
  "early-start": {
    id: "early-start",
    level: "R1",
    rung: 3,
    links: ["claudeCodeLegal"],
    title: "featureRisk.earlyStartTitle",
    body: "featureRisk.earlyStartBody",
    textVersion: 1,
  },
  "gateway-codex": {
    id: "gateway-codex",
    level: "R1",
    rung: 4,
    links: ["openaiSignIn"],
    title: "featureRisk.gatewayCodexTitle",
    body: "featureRisk.gatewayCodexBody",
    textVersion: 1,
  },
  "gateway-claude": {
    id: "gateway-claude",
    level: "R2",
    rung: 5,
    links: ["anthropicAup", "claudeCodeLegal"],
    title: "featureRisk.gatewayClaudeTitle",
    body: "featureRisk.gatewayClaudeBody",
    textVersion: 1,
  },
  "tailscale-bind": {
    id: "tailscale-bind",
    level: "R2",
    rung: 5,
    links: ["anthropicAup", "openaiSignIn"],
    title: "featureRisk.tailscaleBindTitle",
    body: "featureRisk.tailscaleBindBody",
    textVersion: 1,
  },
  "omp-binding": {
    id: "omp-binding",
    level: "R2",
    rung: 6,
    links: ["anthropicAup", "claudeCodeLegal"],
    title: "featureRisk.ompBindingTitle",
    body: "featureRisk.ompBindingBody",
    textVersion: 1,
  },
  "antigravity-account": {
    id: "antigravity-account",
    level: "R2",
    rung: 7,
    links: ["antigravityTerms", "antigravityFaq"],
    title: "featureRisk.antigravityAccountTitle",
    body: "featureRisk.antigravityAccountBody",
    textVersion: 1,
  },
  "antigravity-gateway": {
    id: "antigravity-gateway",
    level: "R2",
    rung: 7,
    links: ["antigravityFaq", "antigravityTerms"],
    title: "featureRisk.antigravityGatewayTitle",
    body: "featureRisk.antigravityGatewayBody",
    textVersion: 1,
  },
};

/** The text version each feature's risk was accepted at, by feature. */
export type RiskAcknowledgements = Partial<Record<FeatureRiskId, number>>;

/** True until the user has accepted this feature's current risk text. */
export function needsRiskAck(settings: { riskAcknowledged?: RiskAcknowledgements }, id: FeatureRiskId): boolean {
  const accepted = settings.riskAcknowledged?.[id];
  return accepted === undefined || accepted < FEATURE_RISKS[id].textVersion;
}

/** The features among `ids` still to accept, once each, lowest risk first. */
export function pendingRisks(
  settings: { riskAcknowledged?: RiskAcknowledgements },
  ids: readonly FeatureRiskId[],
): FeatureRiskId[] {
  return FEATURE_RISK_IDS.filter((id) => ids.includes(id) && needsRiskAck(settings, id));
}

/** The acknowledgements with `ids` accepted at their current text. */
export function acknowledgeRisks(acks: RiskAcknowledgements | undefined, ids: readonly FeatureRiskId[]): RiskAcknowledgements {
  const next: RiskAcknowledgements = { ...acks };
  for (const id of ids) next[id] = FEATURE_RISKS[id].textVersion;
  return next;
}

interface PoolAccount {
  id: string;
  provider?: string;
}

/** The pool's accounts: every account the gateway may route to, by provider. */
const poolProviders = (accounts: readonly PoolAccount[], excluded: readonly string[] = []) =>
  new Set(accounts.filter((a) => !excluded.includes(a.id)).map((a) => a.provider ?? "claude"));

/**
 * What turning the gateway on risks. It answers Claude and Codex clients whatever the pool holds
 * now (an account added later joins the pool by itself), so both are always asked; Antigravity
 * only when an Antigravity account is in the pool, the tailnet when it listens there, and each
 * client still bound to it (omp passing as Claude Code).
 */
export function gatewayRisks(
  config: { host: string; excludedAccountIds?: readonly string[]; boundClients?: readonly ProxyClientId[] },
  accounts: readonly PoolAccount[],
): FeatureRiskId[] {
  const risks: FeatureRiskId[] = ["gateway-claude", "gateway-codex"];
  if (poolProviders(accounts, config.excludedAccountIds).has("antigravity")) risks.push("antigravity-gateway");
  if (!LOOPBACK_HOSTS.has(config.host.trim())) risks.push("tailscale-bind");
  for (const client of config.boundClients ?? []) risks.push(...clientRisks(client));
  return FEATURE_RISK_IDS.filter((id) => risks.includes(id));
}

/**
 * What a change to the gateway's settings risks: listening on the tailnet, and, while the gateway
 * is on, letting an Antigravity account into the pool.
 */
export function proxyPatchRisks(
  config: { enabled: boolean; host: string; excludedAccountIds?: readonly string[] },
  patch: { host?: string; excludedAccountIds?: readonly string[] },
  accounts: readonly PoolAccount[],
): FeatureRiskId[] {
  const risks: FeatureRiskId[] = [];
  if (patch.host !== undefined && !LOOPBACK_HOSTS.has(patch.host.trim())) risks.push("tailscale-bind");
  if (
    config.enabled &&
    patch.excludedAccountIds !== undefined &&
    poolProviders(accounts, patch.excludedAccountIds).has("antigravity") &&
    !poolProviders(accounts, config.excludedAccountIds).has("antigravity")
  )
    risks.push("antigravity-gateway");
  return risks;
}

/** What pointing a client at the gateway risks: its own provider's requests, or omp passing as Claude Code. */
export function clientRisks(id: ProxyClientId): FeatureRiskId[] {
  if (id === "omp") return ["omp-binding"];
  return [id === "codex" ? "gateway-codex" : "gateway-claude"];
}

/** Adding an Antigravity account; while the gateway is on the account joins its pool as well. */
export const antigravityAccountRisks = (gatewayOn: boolean): FeatureRiskId[] =>
  gatewayOn ? ["antigravity-account", "antigravity-gateway"] : ["antigravity-account"];

/** A planning change risks something only when it turns early start on. */
export const planningRisks = (before: { autoStart: boolean }, patch: { autoStart?: boolean }): FeatureRiskId[] =>
  patch.autoStart === true && !before.autoStart ? ["early-start"] : [];

/** A meter's risk: the provider's own terms on reading its usage from outside its tool. */
export const meterRisk = (provider: MeterProvider): FeatureRiskId => `meter-${provider}`;

/** The meters a settings change turns on (on in `after`, off in `before`), as their risks. */
export const meterRisks = (before: readonly MeterProvider[] | undefined, after: readonly MeterProvider[] | undefined): FeatureRiskId[] =>
  (after ?? []).filter((provider) => !before?.includes(provider)).map(meterRisk);

/** What is on right now, as the window sees it: early start, the accounts, the gateway and the meters. */
export interface FeaturesInUse {
  earlyStart: boolean;
  accounts: readonly PoolAccount[];
  gateway?: { on: boolean; host: string; excludedAccountIds?: readonly string[]; boundClients: readonly ProxyClientId[] };
  meters?: readonly MeterProvider[];
}

/**
 * The risky features already on, lowest risk first. A feature turned on before Relay asked about
 * risks (an older version) is found here, so the window can ask once without stopping it first.
 * A client bound to a gateway that is off sends nothing, so it counts only while the gateway runs.
 */
export function enabledRisks(state: FeaturesInUse): FeatureRiskId[] {
  const risks: FeatureRiskId[] = [];
  if (state.earlyStart) risks.push("early-start");
  risks.push(...(state.meters ?? []).map(meterRisk));
  if (state.accounts.some((a) => a.provider === "antigravity")) risks.push("antigravity-account");
  if (state.gateway?.on) risks.push(...gatewayRisks(state.gateway, state.accounts));
  return FEATURE_RISK_IDS.filter((id) => risks.includes(id));
}

/** One call that turns a risky feature off, through the same IPC the pages use. */
export type TurnOffStep =
  | { kind: "unbind"; client: ProxyClientId }
  | { kind: "gateway-off" }
  | { kind: "gateway-host"; host: string }
  | { kind: "exclude"; accountIds: string[] }
  | { kind: "early-start-off" }
  | { kind: "remove-account"; accountId: string }
  /** The meters to keep on: the others are turned off in one settings change. */
  | { kind: "meters"; keep: MeterProvider[] };

/**
 * How to turn the `pending` features off, in order: clients first (so they go back to their own
 * sign-in), then the gateway as a whole when its Claude or Codex risk was declined, or only its
 * tailnet address or its Antigravity accounts; then early start and the meters; and last the
 * Antigravity accounts themselves, which are only off once they are removed.
 */
export function turnOffSteps(pending: readonly FeatureRiskId[], state: FeaturesInUse): TurnOffStep[] {
  const steps: TurnOffStep[] = [];
  const gateway = state.gateway;
  const antigravity = state.accounts.filter((a) => a.provider === "antigravity").map((a) => a.id);
  if (gateway?.on) {
    for (const client of gateway.boundClients)
      if (clientRisks(client).some((id) => pending.includes(id))) steps.push({ kind: "unbind", client });
    if (pending.includes("gateway-claude") || pending.includes("gateway-codex")) steps.push({ kind: "gateway-off" });
    else {
      if (pending.includes("tailscale-bind")) steps.push({ kind: "gateway-host", host: DEFAULT_PROXY_CONFIG.host });
      if (pending.includes("antigravity-gateway")) {
        const excluded = gateway.excludedAccountIds ?? [];
        steps.push({ kind: "exclude", accountIds: [...excluded, ...antigravity.filter((id) => !excluded.includes(id))] });
      }
    }
  }
  if (pending.includes("early-start")) steps.push({ kind: "early-start-off" });
  const meters = state.meters ?? [];
  if (meters.some((provider) => pending.includes(meterRisk(provider))))
    steps.push({ kind: "meters", keep: meters.filter((provider) => !pending.includes(meterRisk(provider))) });
  if (pending.includes("antigravity-account"))
    for (const accountId of antigravity) steps.push({ kind: "remove-account", accountId });
  return steps;
}

/** Thrown in main when a feature is turned on before its risk was accepted. */
export class RiskNotAcknowledged extends Error {
  constructor(
    readonly ids: FeatureRiskId[],
    message: string,
  ) {
    super(message);
    this.name = "RiskNotAcknowledged";
  }
}

/**
 * Refuses (throws RiskNotAcknowledged) when any of `ids` is not accepted at its current text.
 * `message` words the refusal in the app's language from the features still pending.
 */
export function requireRiskAck(
  settings: { riskAcknowledged?: RiskAcknowledgements },
  ids: readonly FeatureRiskId[],
  message: (pending: FeatureRiskId[]) => string,
): void {
  const pending = pendingRisks(settings, ids);
  if (pending.length) throw new RiskNotAcknowledged(pending, message(pending));
}
