import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  limitColumns,
  limitHeadline,
  limitOrigin,
} from "../shared/quota-windows";
import { LimitLine, limitOriginText } from "../src/components/LimitLine";
import { I18nContext } from "../src/data/i18n";
import { usageWindowRows } from "../src/data/selectors";
import { i18nValue, testT } from "./i18n";

const NOW = Date.parse("2026-11-20T12:00:00Z");

test("a window whose reset passed since its reading is Relay's estimate", () => {
  const read = {
    usedPercent: 80,
    resetsAt: new Date(NOW - 60_000).toISOString(),
    source: "official" as const,
    readAt: new Date(NOW - 3_600_000).toISOString(),
  };
  assert.deepEqual(limitOrigin(read, undefined, NOW), {
    source: "estimate",
    readAt: read.readAt,
  });
  assert.deepEqual(
    limitOrigin(
      { ...read, resetsAt: new Date(NOW + 60_000).toISOString() },
      undefined,
      NOW,
    ),
    { source: "official", readAt: read.readAt },
  );
});

test("an untagged window takes its source from the account's sign-in and its age from the read", () => {
  const checkedAt = new Date(NOW - 5 * 60_000).toISOString();
  assert.deepEqual(limitOrigin({}, { source: "desktop", checkedAt }, NOW), {
    source: "app-session",
    readAt: checkedAt,
  });
  assert.deepEqual(limitOrigin({}, { source: "cli", checkedAt }, NOW), {
    source: "official",
    readAt: checkedAt,
  });
  assert.equal(limitOrigin({}, { checkedAt }, NOW), undefined);
  assert.equal(
    limitOrigin(undefined, { source: "cli", checkedAt }, NOW),
    undefined,
  );
});

test("rows, columns and the headline keep each window's source", () => {
  const readAt = new Date(NOW - 60_000).toISOString();
  const usage = {
    accountId: "a",
    status: "ready" as const,
    stale: false,
    fiveHour: { usedPercent: 30, source: "gateway" as const, readAt },
    sevenDay: { usedPercent: 50, source: "official" as const, readAt },
  };
  assert.deepEqual(
    usageWindowRows(usage).map((r) => r.source),
    ["gateway", "official"],
  );
  assert.equal(limitHeadline(usage, NOW)?.source, "official");
  assert.equal(limitColumns(usage, NOW).five?.source, "gateway");
  const pools = {
    accountId: "b",
    status: "ready" as const,
    stale: false,
    modelWindows: [
      {
        key: "antigravity_gemini_5h",
        label: "Gemini",
        usedPercent: 30,
        period: "five_hour" as const,
        source: "official" as const,
        readAt,
      },
    ],
  };
  assert.equal(limitColumns(pools, NOW).five?.source, "official");
  assert.equal(usageWindowRows(pools)[0].readAt, readAt);
});

test("the tooltip names each source and the reading's age", () => {
  const en = testT("en");
  const ago = (minutes: number) =>
    new Date(NOW - minutes * 60_000).toISOString();
  assert.equal(
    limitOriginText({ source: "official", readAt: ago(3) }, NOW, en, "en"),
    "Source: Official API · 3 min ago",
  );
  assert.equal(
    limitOriginText({ source: "app-session", readAt: ago(0) }, NOW, en, "en"),
    "Source: Claude app sign-in · just now",
  );
  assert.equal(
    limitOriginText({ source: "gateway", readAt: ago(90) }, NOW, en, "en"),
    `Source: Gateway answer · ${en("proxyUi.hAgo", { hours: 1 })}`,
  );
  assert.equal(
    limitOriginText(
      { source: "estimate", readAt: ago(2 * 24 * 60) },
      NOW,
      en,
      "en",
    ),
    `Source: Estimate (reset since the reading) · ${en("libTime.daysAgo", { days: 2 })}`,
  );
  assert.equal(
    limitOriginText({ source: "official" }, NOW, en, "en"),
    "Source: Official API",
  );
  assert.equal(limitOriginText(undefined, NOW, en, "en"), undefined);
  // The age moves on with the row's clock.
  assert.equal(
    limitOriginText(
      { source: "official", readAt: ago(3) },
      NOW + 5 * 60_000,
      en,
      "en",
    ),
    "Source: Official API · 8 min ago",
  );
  assert.equal(
    limitOriginText(
      { source: "official", readAt: ago(3) },
      NOW,
      testT("tr"),
      "tr",
    ),
    "Kaynak: Resmi API · 3 dk önce",
  );
});

test("a limit line's tooltip ends with its source and age", () => {
  const html = renderToStaticMarkup(
    createElement(
      I18nContext.Provider,
      { value: i18nValue("en") },
      createElement(LimitLine, {
        label: "5 hours",
        usedPercent: 40,
        resetsAt: new Date(NOW + 60 * 60_000).toISOString(),
        period: "five_hour",
        now: NOW,
        t: testT("en"),
        origin: {
          source: "official",
          readAt: new Date(NOW - 3 * 60_000).toISOString(),
        },
      }),
    ),
  );
  const title = /title="([^"]*)"/.exec(html)?.[1] ?? "";
  assert.match(title, /^5 hours .*\nSource: Official API · 3 min ago$/);
});
