import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  FEATURE_RISKS,
  POLICY_LINKS,
  acknowledgeRisks,
  enabledRisks,
  meterRisks,
  requireRiskAck,
  turnOffSteps,
} from "../shared/feature-risk";
import { isExternalLink } from "../shared/external-links";
import type { MeterProvider, MeterReading } from "../shared/meters";
import { DEFAULT_SETTINGS, type Snapshot } from "../shared/types";
import { en } from "../shared/i18n/catalogs/en";
import { MetersCard } from "../src/pages/overview/MetersCard";
import { RelayContext, type Relay } from "../src/data/relay-context";
import { I18nContext } from "../src/data/i18n";
import { i18nValue } from "./i18n";

const NOW = Date.parse("2026-11-23T12:00:00Z");

test("turning a meter on needs its risk accepted", () => {
  // Each meter is R1 on the limits rung, with its maker's terms, allow-listed, and English text.
  for (const id of [
    "meter-copilot",
    "meter-gemini-cli",
    "meter-cursor",
  ] as const) {
    const risk = FEATURE_RISKS[id];
    assert.equal(risk.level, "R1");
    assert.equal(risk.rung, 2);
    assert.ok(isExternalLink(POLICY_LINKS[risk.links[0]!].href), id);
    assert.ok(en[risk.title] && en[risk.body], id);
  }
  assert.match(
    en["featureRisk.meterCursorBody"],
    /harvesting, scraping or extracting/,
  );
  assert.match(en["featureRisk.meterGeminiCliBody"], /direct violation/);

  assert.deepEqual(meterRisks(undefined, ["cursor", "copilot"]), [
    "meter-cursor",
    "meter-copilot",
  ]);
  assert.deepEqual(meterRisks(["cursor"], ["cursor"]), []);
  assert.deepEqual(meterRisks(["cursor"], []), []);
  const message = (pending: string[]) => `accept ${pending.join("+")}`;
  assert.throws(
    () =>
      requireRiskAck(
        DEFAULT_SETTINGS,
        meterRisks(undefined, ["gemini-cli"]),
        message,
      ),
    /accept meter-gemini-cli/,
  );
  assert.doesNotThrow(() =>
    requireRiskAck(
      { riskAcknowledged: acknowledgeRisks({}, ["meter-gemini-cli"]) },
      meterRisks(undefined, ["gemini-cli"]),
      message,
    ),
  );

  // A meter turned on without the answer (a restored backup) is asked about, and "Turn it off" keeps the rest.
  const state = {
    earlyStart: false,
    accounts: [],
    meters: ["copilot", "cursor"] as MeterProvider[],
  };
  assert.deepEqual(enabledRisks(state), ["meter-copilot", "meter-cursor"]);
  assert.deepEqual(turnOffSteps(["meter-cursor"], state), [
    { kind: "meters", keep: ["copilot"] },
  ]);
});

// --- Overview ---------------------------------------------------------------------------------

const READINGS: MeterReading[] = [
  {
    provider: "copilot",
    label: "individual · alto",
    source: "unofficial",
    readAt: new Date(NOW - 4 * 60_000).toISOString(),
    windows: [
      {
        name: "premium",
        kind: "monthly",
        unit: "premium requests",
        usedPercent: 62,
        used: 186,
        limit: 300,
        resetsAt: new Date(NOW + 8 * 86_400_000).toISOString(),
      },
    ],
  },
  {
    provider: "cursor",
    label: "pro",
    source: "unofficial",
    readAt: new Date(NOW - 9 * 60_000).toISOString(),
    windows: [
      {
        name: "included",
        kind: "monthly",
        unit: "$",
        usedPercent: 91,
        used: 18.2,
        limit: 20,
        resetsAt: new Date(NOW + 12 * 86_400_000).toISOString(),
      },
    ],
  },
  {
    provider: "gemini-cli",
    source: "unofficial",
    windows: [],
    error: { issue: "not-available" },
  },
];

const overview = (meters: MeterReading[] | undefined) =>
  renderToStaticMarkup(
    createElement(
      RelayContext.Provider,
      {
        value: {
          data: {
            settings: DEFAULT_SETTINGS,
            usage: {},
            accounts: [],
            ...(meters ? { meters } : {}),
          } as unknown as Snapshot,
        } as unknown as Relay,
      },
      createElement(
        I18nContext.Provider,
        { value: i18nValue("en") },
        createElement(MetersCard, { now: NOW }),
      ),
    ),
  );

test("the Overview shows a row per enabled meter with its plan, its bars and its source", () => {
  assert.equal(overview(undefined), "");
  assert.equal(overview([]), "");
  const html = overview(READINGS);
  const rows = [...html.matchAll(/data-meter="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(rows, ["copilot", "cursor", "gemini-cli"]);
  assert.match(html, /GitHub Copilot[\s\S]*?individual · alto/);
  assert.match(html, /Premium requests[\s\S]*?62%/);
  // Its own reset, and the amount, source and age in the tooltip, as a limit line words them.
  assert.match(
    html,
    /title="Premium requests 186 of 300 62% · 8 d\nSource: Unofficial endpoint · 4 min ago"/,
  );
  assert.match(
    html,
    /title="Plan budget \$18\.20 of \$20\.00 91% · 12 d\nSource: Unofficial endpoint · 9 min ago"/,
  );
  // Gemini CLI's refusal says whom it leaves out, inline.
  assert.match(
    html,
    /data-issue="not-available"[^>]*>Not available for personal Google accounts\./,
  );
});
