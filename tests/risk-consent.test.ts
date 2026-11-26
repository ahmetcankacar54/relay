import test from "node:test";
import assert from "node:assert/strict";
import { mainSource } from "./helpers/main-source";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  FEATURE_RISK_IDS,
  FEATURE_RISKS,
  POLICY_LINKS,
  RISK_LADDER,
  RiskNotAcknowledged,
  acknowledgeRisks,
  antigravityAccountRisks,
  enabledRisks,
  turnOffSteps,
  clientRisks,
  gatewayRisks,
  needsRiskAck,
  pendingRisks,
  planningRisks,
  proxyPatchRisks,
  requireRiskAck,
} from "../shared/feature-risk";
import { isExternalLink } from "../shared/external-links";
import { en } from "../shared/i18n/catalogs/en";
import { settingsPatchSchema, settingsSchema } from "../electron/core/store";
import { DEFAULT_SETTINGS } from "../shared/types";
import { I18nContext } from "../src/data/i18n";
import { RiskConsentBody, featuresInUse } from "../src/components/RiskConsent";
import { i18nValue } from "./i18n";

const accounts = [
  { id: "c1", provider: "claude" },
  { id: "x1", provider: "codex" },
  { id: "g1", provider: "antigravity" },
];

test("every risky feature has a table row with a ladder rung, allow-listed policy pages and English text", () => {
  assert.deepEqual(
    Object.keys(FEATURE_RISKS).sort(),
    [...FEATURE_RISK_IDS].sort(),
  );
  for (const id of FEATURE_RISK_IDS) {
    const risk = FEATURE_RISKS[id];
    assert.equal(risk.id, id);
    assert.ok(risk.rung >= 1 && risk.rung <= RISK_LADDER.length, id);
    assert.ok(risk.textVersion >= 1, id);
    assert.ok(risk.links.length > 0, id);
    for (const link of risk.links)
      assert.ok(isExternalLink(POLICY_LINKS[link].href), `${id}: ${link}`);
    assert.ok(en[risk.title] && en[risk.body], id);
  }
  // The gateway's Claude risk is the one the gateway head shows: it names and links the Usage Policy.
  assert.equal(
    POLICY_LINKS[FEATURE_RISKS["gateway-claude"].links[0]].href,
    "https://www.anthropic.com/legal/aup",
  );
  assert.match(
    en["featureRisk.gatewayClaudeBody"],
    /Usage Policy, in force from 12 November 2026/,
  );
  assert.match(en["featureRisk.ompBindingBody"], /as Claude Code/);
});

test("a risk is asked until accepted at its current text, and again once the text changes", () => {
  assert.equal(needsRiskAck({}, "gateway-claude"), true);
  assert.equal(needsRiskAck(DEFAULT_SETTINGS, "gateway-claude"), true);
  const accepted = acknowledgeRisks({}, ["gateway-claude"]);
  assert.equal(
    needsRiskAck({ riskAcknowledged: accepted }, "gateway-claude"),
    false,
  );
  assert.equal(
    needsRiskAck({ riskAcknowledged: accepted }, "gateway-codex"),
    true,
  );
  // Accepted under an older text: a raised textVersion asks again.
  const older = {
    "gateway-claude": FEATURE_RISKS["gateway-claude"].textVersion - 1,
  };
  assert.equal(
    needsRiskAck({ riskAcknowledged: older }, "gateway-claude"),
    true,
  );
  // Accepting more keeps what was accepted before.
  assert.deepEqual(acknowledgeRisks(accepted, ["early-start"]), {
    "gateway-claude": FEATURE_RISKS["gateway-claude"].textVersion,
    "early-start": FEATURE_RISKS["early-start"].textVersion,
  });
  // Pending risks come once each, lowest risk first.
  assert.deepEqual(
    pendingRisks({ riskAcknowledged: accepted }, [
      "antigravity-gateway",
      "gateway-claude",
      "early-start",
      "early-start",
    ]),
    ["early-start", "antigravity-gateway"],
  );
});

test("each way to turn a risky feature on names its risks", () => {
  // The gateway answers Claude and Codex whatever the pool holds; Antigravity only when pooled.
  assert.deepEqual(gatewayRisks({ host: "127.0.0.1" }, []), [
    "gateway-codex",
    "gateway-claude",
  ]);
  assert.deepEqual(gatewayRisks({ host: "127.0.0.1" }, accounts), [
    "gateway-codex",
    "gateway-claude",
    "antigravity-gateway",
  ]);
  assert.deepEqual(
    gatewayRisks({ host: "127.0.0.1", excludedAccountIds: ["g1"] }, accounts),
    ["gateway-codex", "gateway-claude"],
  );
  assert.deepEqual(gatewayRisks({ host: "100.101.12.34" }, []), [
    "gateway-codex",
    "gateway-claude",
    "tailscale-bind",
  ]);
  // A client still bound when the gateway starts again counts too: omp passes as Claude Code.
  assert.deepEqual(
    gatewayRisks({ host: "127.0.0.1", boundClients: ["omp"] }, []),
    ["gateway-codex", "gateway-claude", "omp-binding"],
  );

  const on = { enabled: true, host: "127.0.0.1", excludedAccountIds: ["g1"] };
  assert.deepEqual(proxyPatchRisks(on, { host: "100.101.12.34" }, accounts), [
    "tailscale-bind",
  ]);
  assert.deepEqual(proxyPatchRisks(on, { host: "::1" }, accounts), []);
  assert.deepEqual(proxyPatchRisks(on, { excludedAccountIds: [] }, accounts), [
    "antigravity-gateway",
  ]);
  assert.deepEqual(
    proxyPatchRisks(on, { excludedAccountIds: ["g1", "x1"] }, accounts),
    [],
  );
  // Off, the pool is judged when the gateway is turned on.
  assert.deepEqual(
    proxyPatchRisks(
      { ...on, enabled: false },
      { excludedAccountIds: [] },
      accounts,
    ),
    [],
  );

  assert.deepEqual(clientRisks("claude-code"), ["gateway-claude"]);
  assert.deepEqual(clientRisks("codex"), ["gateway-codex"]);
  assert.deepEqual(clientRisks("omp"), ["omp-binding"]);
  assert.deepEqual(antigravityAccountRisks(false), ["antigravity-account"]);
  assert.deepEqual(antigravityAccountRisks(true), [
    "antigravity-account",
    "antigravity-gateway",
  ]);
  assert.deepEqual(planningRisks({ autoStart: false }, { autoStart: true }), [
    "early-start",
  ]);
  assert.deepEqual(planningRisks({ autoStart: true }, { autoStart: true }), []);
  assert.deepEqual(
    planningRisks({ autoStart: false }, { tempo: "auto" } as {
      autoStart?: boolean;
    }),
    [],
  );
});

test("features already on before Relay asked are found, and only the unaccepted ones are asked", () => {
  const settings = {
    ...DEFAULT_SETTINGS,
    planning: { ...DEFAULT_SETTINGS.planning, autoStart: true },
    proxy: { ...DEFAULT_SETTINGS.proxy!, enabled: true, host: "100.101.12.34" },
  };
  const relayAccounts = accounts.map((a) => ({
    ...a,
    name: a.id,
    kind: "personal",
  })) as never[];
  const status = {
    running: true,
    host: "100.101.12.34",
    accounts: [
      { id: "c1", inPool: true },
      { id: "x1", inPool: true },
      { id: "g1", inPool: false },
    ],
    clients: [
      { id: "omp", bound: true },
      { id: "codex", bound: false },
    ],
  } as never;
  const state = featuresInUse(settings, relayAccounts, status);
  assert.deepEqual(enabledRisks(state), [
    "early-start",
    "gateway-codex",
    "gateway-claude",
    "tailscale-bind",
    "omp-binding",
    "antigravity-account",
  ]);
  // Accepted ones are not asked again; the rest are, before anything is turned off.
  const partly = {
    ...settings,
    riskAcknowledged: acknowledgeRisks({}, [
      "early-start",
      "gateway-codex",
      "gateway-claude",
    ]),
  };
  assert.deepEqual(pendingRisks(partly, enabledRisks(state)), [
    "tailscale-bind",
    "omp-binding",
    "antigravity-account",
  ]);
  // Off and unbound, nothing of the gateway counts; nothing at all with early start off and no Antigravity.
  const off = featuresInUse(
    { ...settings, proxy: { ...settings.proxy, enabled: false } },
    relayAccounts.slice(0, 2),
    { ...(status as object), running: false } as never,
  );
  assert.deepEqual(enabledRisks(off), ["early-start"]);
  assert.deepEqual(
    enabledRisks(featuresInUse(DEFAULT_SETTINGS, [], undefined)),
    [],
  );
  // Before the gateway's state is read, the saved switch still counts.
  assert.deepEqual(enabledRisks(featuresInUse(settings, [], undefined)), [
    "early-start",
    "gateway-codex",
    "gateway-claude",
    "tailscale-bind",
  ]);

  // "Turn it off": clients first, then only the declined part of the gateway, then the rest.
  assert.deepEqual(
    turnOffSteps(
      ["tailscale-bind", "omp-binding", "antigravity-account"],
      state,
    ),
    [
      { kind: "unbind", client: "omp" },
      { kind: "gateway-host", host: "127.0.0.1" },
      { kind: "remove-account", accountId: "g1" },
    ],
  );
  assert.deepEqual(
    turnOffSteps(["early-start", "gateway-claude", "tailscale-bind"], state),
    [{ kind: "gateway-off" }, { kind: "early-start-off" }],
  );
  const pooled = {
    ...state,
    gateway: { ...state.gateway!, excludedAccountIds: ["x1"] },
  };
  assert.deepEqual(turnOffSteps(["antigravity-gateway"], pooled), [
    { kind: "exclude", accountIds: ["x1", "g1"] },
  ]);
});

test("main refuses a risky feature without its acceptance and words the refusal from the pending ones", () => {
  const message = (pending: string[]) => `accept ${pending.join("+")}`;
  assert.throws(
    () => requireRiskAck({}, ["gateway-claude", "gateway-codex"], message),
    (error: unknown) =>
      error instanceof RiskNotAcknowledged &&
      error.message === "accept gateway-codex+gateway-claude" &&
      error.ids.join() === "gateway-codex,gateway-claude",
  );
  const accepted = {
    riskAcknowledged: acknowledgeRisks({}, ["gateway-claude", "gateway-codex"]),
  };
  assert.doesNotThrow(() =>
    requireRiskAck(accepted, ["gateway-claude", "gateway-codex"], message),
  );
  assert.throws(
    () => requireRiskAck(accepted, ["tailscale-bind"], message),
    /accept tailscale-bind/,
  );
});

test("main gates every risky switch, and only acknowledge-risk records an acceptance", () => {
  const main = mainSource();
  const preload = readFileSync(
    new URL("../electron/preload.ts", import.meta.url),
    "utf8",
  );
  // A handler's source: from its name to the next handler.
  const handler = (name: string) =>
    new RegExp(`handle\\("${name}"[\\s\\S]*?(?=\\n  handle\\()`).exec(
      main,
    )?.[0] ?? "";
  for (const [name, gate] of [
    ["proxy-toggle", /requireRisk\(gatewayRisks\(/],
    ["proxy-configure", /requireRisk\(proxyPatchRisks\(/],
    ["proxy-bind-client", /requireRisk\(clientRisks\(/],
    ["antigravity-oauth-start", /requireRisk\(antigravityAccountRisks\(/],
    ["create-account", /requireRisk\(antigravityAccountRisks\(/],
    ["update-planning", /requireRisk\(planningRisks\(/],
  ] as const)
    assert.match(handler(name), gate, name);
  assert.match(main, /handle\("acknowledge-risk"/);
  assert.match(preload, /ipcRenderer\.invoke\("relay:acknowledge-risk"/);
  // The settings patch cannot accept a risk behind the dialog's back.
  assert.equal(
    settingsPatchSchema.safeParse({ riskAcknowledged: { "gateway-claude": 1 } })
      .success,
    false,
  );
});

test("a registry from before the risk notes has accepted none, and an unknown risk is refused", () => {
  const { riskAcknowledged: _, ...old } = {
    ...DEFAULT_SETTINGS,
    planning: { ...DEFAULT_SETTINGS.planning },
  };
  assert.deepEqual(settingsSchema.parse(old).riskAcknowledged, {});
  assert.deepEqual(
    settingsSchema.parse({ ...old, riskAcknowledged: { "omp-binding": 1 } })
      .riskAcknowledged,
    { "omp-binding": 1 },
  );
  assert.equal(
    settingsSchema.safeParse({ ...old, riskAcknowledged: { "made-up": 1 } })
      .success,
    false,
  );
  assert.equal(
    settingsSchema.safeParse({ ...old, riskAcknowledged: { "omp-binding": 0 } })
      .success,
    false,
  );
});

test("the consent dialog shows each risk with its pages, and marks its rungs on the ladder", () => {
  const html = renderToStaticMarkup(
    createElement(
      I18nContext.Provider,
      { value: i18nValue("en") },
      createElement(RiskConsentBody, {
        ids: ["gateway-codex", "gateway-claude"],
      }),
    ),
  );
  assert.match(
    html,
    /data-risk="gateway-codex" data-level="R1"[\s\S]*?Grey area[\s\S]*?help\.openai\.com/,
  );
  assert.match(
    html,
    /data-risk="gateway-claude" data-level="R2"[\s\S]*?Against the terms[\s\S]*?https:\/\/www\.anthropic\.com\/legal\/aup/,
  );
  const rungs = [...html.matchAll(/<li([^>]*)>/g)].map((m) =>
    m[1].includes('aria-current="step"'),
  );
  assert.equal(rungs.length, RISK_LADDER.length);
  assert.deepEqual(rungs, [false, false, false, true, true, false, false]);
  const turkish = renderToStaticMarkup(
    createElement(
      I18nContext.Provider,
      { value: i18nValue("tr") },
      createElement(RiskConsentBody, { ids: ["early-start"] }),
    ),
  );
  assert.match(turkish, /Önceden başlatma[\s\S]*?Gri alan/);
});
