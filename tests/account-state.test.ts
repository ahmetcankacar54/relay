import test from "node:test";
import assert from "node:assert/strict";
import {
  cliNeedsReconnect,
  desktopCliMismatch,
  duplicateCliAccount,
} from "../shared/account-state";
import type { Account } from "../shared/types";

const account = (
  id: string,
  accountUuid = "account-a",
  orgId = "org-a",
): Account => ({
  id,
  name: id,
  kind: "personal",
  group: "personal",
  color: "olive",
  createdAt: "2026-10-13",
  auth: {
    loggedIn: true,
    email: "a@example.test",
    accountUuid,
    orgId,
    checkedAt: "2026-10-13",
  },
});
test("expired usage requires reconnect even when the last CLI status was logged in", () => {
  const a = account("a");
  assert.equal(
    cliNeedsReconnect(a, {
      accountId: a.id,
      status: "error",
      stale: false,
      issue: "expired",
    }),
    true,
  );
  assert.equal(
    cliNeedsReconnect(a, {
      accountId: a.id,
      status: "error",
      stale: false,
      issue: "keychain-locked",
    }),
    false,
  );
  assert.equal(
    cliNeedsReconnect(a, {
      accountId: a.id,
      status: "error",
      stale: false,
      issue: "unavailable",
    }),
    false,
  );
});
test("duplicate connection needs both verified account and organization identities", () => {
  const a = account("a"),
    b = account("b"),
    c = account("c", "account-a", "org-b");
  assert.equal(duplicateCliAccount(a, [a, b, c])?.id, b.id);
  assert.equal(duplicateCliAccount(a, [a, c]), undefined);
  b.auth!.accountUuid = undefined;
  assert.equal(duplicateCliAccount(a, [a, b]), undefined);
});
test("Desktop and CLI identity mismatch stays visible while reconnecting usage", () => {
  const a = account("a");
  a.desktop = {
    accountUuid: "account-a",
    orgId: "org-a",
    savedAt: "2026-10-13",
  };
  assert.equal(desktopCliMismatch(a), false);
  a.auth!.orgId = "org-b";
  assert.equal(desktopCliMismatch(a), true);
  a.auth!.loggedIn = false;
  assert.equal(desktopCliMismatch(a), false);
});
