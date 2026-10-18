import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UsageCard } from "../src/features/UsageCard";
import { DEFAULT_SETTINGS, type AccountUsage } from "../shared/types";

const now = Date.parse("2026-10-13T10:00:00.000Z");
const earlier = "2026-10-13T09:00:00.000Z";
const later = "2026-10-13T13:00:00.000Z";
const checkedAt = "2026-10-13T08:00:00.000Z";

function render(usage: AccountUsage, language = "en") {
  return renderToStaticMarkup(
    createElement(UsageCard, {
      usage,
      settings: DEFAULT_SETTINGS,
      now,
      language,
      t: (tr, en) => (language === "tr" ? tr : en),
      refresh: () => {},
      connect: () => {},
    }),
  );
}

test("connection renewal is an explicit action and preserves verified current quota", () => {
  const usage: AccountUsage = {
    accountId: "a",
    status: "ready",
    stale: false,
    checkedAt,
    connectionRenewalRequired: true,
    fiveHour: { usedPercent: 20, resetsAt: later },
  };
  const en = render(usage);
  assert.match(en, /20% used/);
  assert.match(en, /The usage sign-in needs to be renewed/);
  assert.match(en, /No limit reported/);
  assert.match(en, />Allow renewal<\/button>/);
  assert.doesNotMatch(en, /Allow Keychain access|Reconnect|Stale data/);
  const tr = render(usage, "tr");
  assert.match(tr, /Limit okuma girişinin yenilenmesi gerekiyor/);
  assert.match(tr, />Yenilemeye izin ver<\/button>/);
});

test("an expired connection waiting for interactive renewal does not ask for another reader grant or browser login", () => {
  const en = render({
    accountId: "a",
    status: "error",
    stale: false,
    issue: "renewal-required",
    retryAt: later,
  });
  assert.match(en, />Allow renewal<\/button>/);
  assert.doesNotMatch(en, /Allow Keychain access|Reconnect|Retry /);
});

test("a switched-away account keeps dated resets in English and Turkish without claiming current quota", () => {
  const usage: AccountUsage = {
    accountId: "exhausted-account",
    status: "idle",
    stale: false,
    lastKnownResets: {
      fiveHour: { resetsAt: earlier, checkedAt },
      sevenDay: { resetsAt: later, checkedAt },
    },
  };
  const en = render(usage);
  assert.match(en, /Previous period/);
  assert.match(en, /Last known reset/);
  assert.match(en, /Last verified/);
  assert.match(en, new RegExp(`dateTime="${earlier}"`, "i"));
  assert.match(en, new RegExp(`dateTime="${checkedAt}"`, "i"));
  assert.match(en, /No data/);
  assert.doesNotMatch(en, /role="meter"|Limit reached|100%|>Resets /);
  const tr = render(usage, "tr");
  assert.match(tr, /Önceki dönem/);
  assert.match(tr, /Son bilinen yenilenme/);
  assert.match(tr, /Son doğrulama/);
});

test("fresh server quota supersedes historical reset copy, while a missing weekly window keeps its own history", () => {
  const en = render({
    accountId: "a",
    status: "ready",
    stale: false,
    checkedAt,
    fiveHour: { usedPercent: 20, resetsAt: later },
    lastKnownResets: {
      fiveHour: { resetsAt: earlier, checkedAt },
      sevenDay: { resetsAt: later, checkedAt },
    },
  });
  assert.match(en, />Resets /);
  assert.match(en, /20% used/);
  assert.match(en, /Last known reset/);
  assert.doesNotMatch(en, /Previous period/);
  assert.doesNotMatch(en, new RegExp(`dateTime="${earlier}"`, "i"));
});

test("stale future dates and a passed reset retain their actual dates and observation time", () => {
  const stale = render({
    accountId: "a",
    status: "error",
    stale: true,
    issue: "unavailable",
    checkedAt,
    fiveHour: { usedPercent: 100, resetsAt: later },
  });
  assert.match(stale, /Last known reset/);
  assert.match(stale, /Last verified/);
  assert.match(stale, /Stale data/);
  assert.doesNotMatch(stale, />Resets /);
  const past = render({
    accountId: "a",
    status: "ready",
    stale: false,
    checkedAt,
    fiveHour: { usedPercent: 100, resetsAt: earlier },
  });
  assert.match(past, /Previous period/);
  assert.match(past, new RegExp(`dateTime="${earlier}"`, "i"));
  assert.match(past, new RegExp(`dateTime="${checkedAt}"`, "i"));
});

test("invalid or future-dated observation metadata does not present an invented reset", () => {
  const en = render({
    accountId: "a",
    status: "idle",
    stale: false,
    lastKnownResets: {
      fiveHour: { resetsAt: "invalid", checkedAt },
      sevenDay: { resetsAt: later, checkedAt: "2099-01-01T00:00:00.000Z" },
    },
  });
  assert.doesNotMatch(en, /Invalid Date|Last known reset|Last verified|2099/);
  assert.match(en, /Reset time unavailable/);
});

test("the reset line and the used word are set in text-xs, not 11 px", () => {
  const usage: AccountUsage = {
    accountId: "a",
    status: "ready",
    stale: false,
    checkedAt,
    fiveHour: { usedPercent: 20, resetsAt: later },
  };
  for (const language of ["en", "tr"]) {
    const html = render(usage, language);
    assert.match(html, /<div class="mt-1 text-xs text-muted-foreground">(Resets|Yenilenir)/, language);
    assert.match(html, /<small class="text-xs font-normal text-muted-foreground">(used|kullanıldı)<\/small>/, language);
    assert.doesNotMatch(html, /text-\[11px\]/, language);
  }
});

test("the status phrase may wrap, and only the percentage stays on one line", () => {
  // The weekly window is not reported: its phrase is the longest the card shows.
  const usage: AccountUsage = {
    accountId: "a",
    status: "ready",
    stale: false,
    checkedAt,
    fiveHour: { usedPercent: 20, resetsAt: later },
  };
  for (const language of ["en", "tr"]) {
    const html = render(usage, language);
    const strongs = html.match(/<strong[^>]*>/g) ?? [];
    assert.equal(strongs.length, 2, language);
    for (const tag of strongs)
      assert.doesNotMatch(tag, /whitespace-nowrap/, language);
    assert.match(
      html,
      language === "tr"
        ? /<span class="whitespace-nowrap">%20<\/span> <small class="text-xs font-normal text-muted-foreground">kullanıldı<\/small>/
        : /<span class="whitespace-nowrap">20%<\/span> <small class="text-xs font-normal text-muted-foreground">used<\/small>/,
      language,
    );
    assert.match(
      html,
      /<span class="whitespace-nowrap">—<\/span> <small class="text-xs font-normal text-muted-foreground">(No limit reported|Limit bildirilmiyor)<\/small>/,
      language,
    );
  }
});

test("the card shows what is used, %20 kullanıldı in Turkish and 20% used in English, and its bar fills with the same share", () => {
  const usage: AccountUsage = {
    accountId: "a",
    status: "ready",
    stale: false,
    checkedAt,
    fiveHour: { usedPercent: 20, resetsAt: later },
  };
  const tr = render(usage, "tr");
  const en = render(usage, "en");
  assert.match(tr, />%20<\/span> <small[^>]*>kullanıldı<\/small>/);
  assert.match(en, />20%<\/span> <small[^>]*>used<\/small>/);
  // Not 20.0%: one rounded figure from the shared helper.
  assert.doesNotMatch(tr, />\d+%</);
  // The number and the bar say the same thing: the fill is the used share, as on Claude's usage page.
  assert.match(tr, /aria-valuenow="20"/);
  assert.match(tr, /aria-valuetext="%20 kullanıldı"/);
  assert.match(en, /aria-valuetext="20% used"/);
  assert.match(tr, /style="width:20%"/);
  assert.doesNotMatch(tr, /style="width:80%"/);
});

test("what is used is rounded down, so only a full window reads 100", () => {
  const shown = (usedPercent: number) =>
    render({
      accountId: "a",
      status: "ready",
      stale: false,
      checkedAt,
      fiveHour: { usedPercent, resetsAt: later },
    });
  assert.match(shown(93.5), />93%<\/span> <small[^>]*>used<\/small>/);
  assert.match(shown(99.9), />99%<\/span> <small[^>]*>used<\/small>/);
  assert.match(shown(100), />100%<\/span> <small[^>]*>used<\/small>/);
});
