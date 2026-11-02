import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../electron/core/store";
import { UsageCredentialRefresher } from "../electron/core/usage-refresh";
import { acquireProfileLock } from "../electron/core/profile-lock";
import { childReady } from "./lock-child";

const NOW = Date.parse("2026-10-19T09:00:00.000Z");
test("a refresh does not run while another process holds the account's profile lock", async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "relay-refresh-lock-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  const created = store.create({ name: "A", kind: "personal" });
  const accountUuid = randomUUID(),
    orgId = randomUUID();
  store.update((s) => {
    s.accounts[0].auth = { loggedIn: true, accountUuid, orgId, checkedAt: new Date(NOW).toISOString() };
  });
  const account = store.account(created.id);
  const locks = path.join(root, "profiles", ".locks");
  const holder = await childReady("profile-lock-child.ts", [locks, account.id, "shared"]);
  t.after(() => holder.kill());
  let runs = 0;
  const refresher = new UsageCredentialRefresher({
    platform: "linux",
    executable: async () => path.join(root, "fixture-cli"),
    read: async () => ({ accessToken: "old", expiresAt: NOW - 1, scopes: [] }),
    run: async () => {
      runs++;
    },
    now: () => NOW,
    profileLock: (id) => acquireProfileLock(locks, id, "exclusive"),
  });
  await assert.rejects(
    refresher.refresh(account, store.profile(account.id), { accessToken: "old", expiresAt: NOW - 1, scopes: [] }, true),
    (e: any) => e.issue === "unavailable",
  );
  assert.equal(runs, 0);
});
