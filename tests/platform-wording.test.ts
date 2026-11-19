import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RelayContext, type Relay } from "../src/data/relay-context";
import { keychainWords, macWording } from "../src/data/platform";
import { keychainHint } from "../src/features/DesktopActionReview";
import { UsageCard } from "../src/features/UsageCard";
import { removedNotice } from "../src/pages/accounts/RemoveAccountDialog";
import { DEFAULT_SETTINGS, type Account, type AccountUsage } from "../shared/types";
import { accountHealth, usageSignInStatus } from "../src/lib/account-health";

const en = (_tr: string, en: string) => en;

test("Mac and Keychain wording stays on macOS, the preview and before the platform is known", () => {
  for (const p of [undefined, "darwin", "preview"]) assert.equal(macWording(p), true, String(p));
  for (const p of ["linux", "win32"]) assert.equal(macWording(p), false, p);
  assert.equal(keychainWords("darwin", en).allow, "Allow Keychain access");
  assert.equal(keychainWords("linux", en).allow, "Allow keyring access");
  assert.match(keychainHint("linux")[1], /KWallet or Secret Service/);
  assert.match(keychainHint(undefined)[1], /Relay Safe Storage/);
  assert.match(removedNotice("C", { signedOut: false }, en, "linux"), /Its saved sign-in can stay\.$/);
  assert.match(removedNotice("C", { signedOut: false }, en), /Its Keychain item can stay\.$/);
});

test("a locked keyring is the account's status on Linux, the Keychain on macOS", () => {
  const account = {
    id: "a",
    name: "A",
    desktop: { accountUuid: "u", orgId: "o", savedAt: "" },
    auth: { loggedIn: true, email: "a@example.com", checkedAt: "" },
  } as Account;
  const usage: AccountUsage = { accountId: "a", status: "error", stale: true, issue: "keychain-locked" };
  const status = (platform?: string) =>
    accountHealth(account, usage, { active: false, desktopRunning: false, waiting: false, platform }, en).label;
  assert.equal(status(), "Keychain access needed");
  assert.equal(status("darwin"), "Keychain access needed");
  assert.equal(status("linux"), "Keyring access needed");
  assert.equal(usageSignInStatus(account, usage, false, en, "linux").label, "Connected · Keyring access needed");
  assert.equal(usageSignInStatus(account, usage, false, en).label, "Connected · Keychain access needed");
});

test("on Linux the usage card asks for keyring access, not the Keychain", () => {
  const usage: AccountUsage = { accountId: "a", status: "error", stale: true, issue: "keychain-locked" };
  const card = (platform?: string) =>
    renderToStaticMarkup(
      createElement(
        RelayContext.Provider,
        { value: { data: platform ? { diagnostics: { platform } } : undefined } as unknown as Relay },
        createElement(UsageCard, {
          usage,
          settings: DEFAULT_SETTINGS,
          t: en,
          language: "en",
          refresh: () => {},
          connect: () => {},
        }),
      ),
    );
  const linux = card("linux");
  assert.match(linux, /Relay needs keyring access \(KWallet or Secret Service\) to read limits\./);
  assert.match(linux, />Allow keyring access</);
  assert.doesNotMatch(linux, /Keychain/);
  const mac = card("darwin");
  assert.match(mac, /Relay needs Keychain access to read limits\./);
  assert.match(mac, />Allow Keychain access</);
});
