import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { Store, settingsSchema } from "../electron/core/store";
import {
  missingIdentity,
  parseUsage,
  retryTime,
  UsageManager,
  verifyIdentity,
} from "../electron/core/usage";
import {
  credentialService,
  parseCredential,
  readCredential,
  UsageError,
} from "../electron/core/usage-credentials";
import { DEFAULT_SETTINGS, type AccountUsage } from "../shared/types";
import { remaining, suggestedAccount } from "../shared/usage";
async function fixture(t: any) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-usage-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  const a = store.create({ name: "A", kind: "personal" });
  store.update((s) => {
    s.accounts[0].auth = {
      loggedIn: true,
      email: "a@example.test",
      checkedAt: "2026-10-13",
    };
  });
  return { store, a: store.account(a.id), root };
}
const limits = {
  five_hour: { utilization: 91.3, resets_at: "2026-10-13T16:00:00Z" },
  seven_day: { utilization: 30, resets_at: "2026-10-16T16:00:00Z" },
};
const credential = {
  accessToken: "fixture-secret-never-rendered",
  expiresAt: Date.parse("2026-10-14T00:00:00Z"),
  scopes: ["user:profile"],
};
const profile = {
  account: { email_address: "a@example.test", uuid: "account-a" },
  organization: { uuid: "org-a" },
};
test("quota parsing distinguishes unavailable windows, full quota and partial quota", () => {
  const value = parseUsage(limits);
  assert.ok(Math.abs(remaining(value.fiveHour)! - 8.7) < 0.0001);
  assert.equal(remaining(value.sevenDay), 70);
  assert.equal(
    parseUsage({ five_hour: { utilization: 100 }, seven_day: null }).sevenDay,
    undefined,
  );
  assert.equal(
    remaining(parseUsage({ five_hour: { utilization: 100 } }).fiveHour),
    0,
  );
  assert.equal(
    remaining(parseUsage({ five_hour: { utilization: 0 } }).fiveHour),
    100,
  );
  for (const bad of [-1, 101, NaN, Infinity, "20"])
    assert.throws(() => parseUsage({ five_hour: { utilization: bad } }));
  assert.throws(() => parseUsage({ five_hour: null, seven_day: null }));
  assert.throws(() =>
    parseUsage({ five_hour: { utilization: 10, resets_at: "bad" } }),
  );
});
test("usage credentials are profile-scoped, read-only and never use a global fallback", async (t) => {
  const f = await fixture(t);
  assert.notEqual(
    credentialService(f.store.profile(f.a.id)),
    credentialService(path.join(f.root, "different")),
  );
  assert.match(
    credentialService(f.store.profile(f.a.id)),
    /^Claude Code-credentials-[a-f0-9]{8}$/,
  );
  assert.throws(() =>
    parseCredential(JSON.stringify({ mcpOAuth: { token: "wrong" } })),
  );
  const file = path.join(f.store.profile(f.a.id), ".credentials.json");
  await fs.writeFile(file, JSON.stringify({ claudeAiOauth: credential }));
  assert.deepEqual(
    await readCredential(f.store.profile(f.a.id), false, "unused", "linux"),
    credential,
  );
  await fs.unlink(file);
  await assert.rejects(
    readCredential(f.store.profile(f.a.id), false, "unused", "linux"),
    /credentials-missing/,
  );
  const foreign = path.join(f.root, "foreign.json");
  await fs.writeFile(foreign, JSON.stringify({ claudeAiOauth: credential }));
  await fs.symlink(foreign, file);
  await assert.rejects(
    readCredential(f.store.profile(f.a.id), false, "unused", "linux"),
    /credentials-missing/,
  );
});
test("macOS reads the CLI credential through the security tool, falls back to the CLI file and bounds a consent wait", async (t) => {
  const f = await fixture(t);
  const profileDir = f.store.profile(f.a.id);
  const tool = path.join(f.root, "fake-security");
  const credential = {
    accessToken: "fixture-access",
    expiresAt: 4_102_444_800_000,
    scopes: ["user:profile"],
  };
  const script = (body: string) =>
    fs.writeFile(tool, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  await script(
    `[ "$1" = find-generic-password ] && [ "$2" = -s ] && [ "$3" = "${credentialService(profileDir)}" ] && [ "$4" = -w ] || exit 9\necho '${JSON.stringify({ claudeAiOauth: credential })}'`,
  );
  assert.deepEqual(
    await readCredential(profileDir, false, tool, "darwin"),
    credential,
  );
  const hex = Buffer.from(
    JSON.stringify({ claudeAiOauth: credential }),
  ).toString("hex");
  await script(`echo ${hex}`);
  assert.deepEqual(
    await readCredential(profileDir, false, tool, "darwin"),
    credential,
  );
  await script("exit 44");
  await assert.rejects(
    readCredential(profileDir, false, tool, "darwin"),
    /credentials-missing/,
  );
  await fs.writeFile(
    path.join(profileDir, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: credential }),
  );
  assert.deepEqual(
    await readCredential(profileDir, false, tool, "darwin"),
    credential,
  );
  await script("exit 51");
  await assert.rejects(
    readCredential(profileDir, false, tool, "darwin"),
    /keychain-locked/,
  );
});
test("profile verification rejects a wrong account and wrong Desktop organization", async (t) => {
  const f = await fixture(t);
  verifyIdentity(f.a, profile);
  assert.throws(
    () =>
      verifyIdentity(f.a, { account: { email_address: "other@example.test" } }),
    /identity-mismatch/,
  );
  assert.throws(
    () => verifyIdentity({ ...f.a, auth: undefined }, profile),
    /identity-mismatch/,
  );
  const a = {
    ...f.a,
    desktop: { accountUuid: "account-a", orgId: "other-org", savedAt: "" },
  };
  assert.throws(() => verifyIdentity(a, profile), /identity-mismatch/);
});
test("known CLI account and organization IDs cannot be bypassed by matching email", async (t) => {
  const f = await fixture(t);
  const account = {
    ...f.a,
    auth: { ...f.a.auth!, accountUuid: "account-a", orgId: "org-a" },
  };
  verifyIdentity(account, profile);
  assert.throws(
    () =>
      verifyIdentity(account, {
        ...profile,
        account: { ...profile.account, uuid: "other-account" },
      }),
    /identity-mismatch/,
  );
  assert.throws(
    () =>
      verifyIdentity(account, {
        ...profile,
        organization: { uuid: "other-org" },
      }),
    /identity-mismatch/,
  );
  assert.throws(
    () =>
      verifyIdentity(account, {
        account: { email_address: profile.account.email_address },
      }),
    /identity-mismatch/,
  );
  // A corroborated account ID survives an email change; legacy profiles still require matching email.
  verifyIdentity(
    { ...account, auth: { ...account.auth, email: undefined } },
    profile,
  );
  assert.throws(
    () =>
      verifyIdentity(
        {
          ...account,
          auth: {
            ...account.auth,
            accountUuid: undefined,
            email: "other@example.test",
          },
        },
        profile,
      ),
    /identity-mismatch/,
  );
  assert.throws(
    () =>
      verifyIdentity(
        {
          ...account,
          desktop: {
            accountUuid: "other-account",
            orgId: "org-a",
            savedAt: "",
          },
        },
        profile,
      ),
    /identity-mismatch/,
  );
});
test("usage deduplicates requests, hides secrets, retains stale data after 429, honors Retry-After", async (t) => {
  const f = await fixture(t);
  let now = Date.parse("2026-10-13T12:00:00Z"),
    requests = 0,
    fail = false;
  const manager = new UsageManager(
    f.store,
    async (_profile, prompt) => {
      assert.equal(prompt, false);
      return credential;
    },
    async (endpoint) => {
      requests++;
      if (fail) throw new UsageError("rate-limited", now + 600_000);
      return endpoint === "profile" ? profile : limits;
    },
    () => now,
  );
  const [a, b] = await Promise.all([
    manager.refresh(f.a.id),
    manager.refresh(f.a.id),
  ]);
  assert.equal(a.status, "ready");
  assert.deepEqual(a, b);
  assert.equal(requests, 2);
  assert.equal(
    JSON.stringify(manager.snapshot()).includes(credential.accessToken),
    false,
  );
  await manager.refresh(f.a.id);
  assert.equal(requests, 2);
  now += 300_000;
  fail = true;
  const old = await manager.refresh(f.a.id);
  assert.equal(old.stale, true);
  assert.equal(old.issue, "rate-limited");
  assert.deepEqual(old.fiveHour, a.fiveHour);
  now += 60_000;
  await manager.refresh(f.a.id, true);
  assert.equal(requests, 3);
  now += 600_000;
  await manager.refresh(f.a.id);
  assert.equal(requests, 4);
  assert.equal(retryTime("120", now), now + 120_000);
  assert.equal(
    retryTime(new Date(now + 600_000).toUTCString(), now),
    now + 600_000,
  );
});
test("an expired credential does not get refreshed or sent; wrong identity clears old quota", async (t) => {
  const f = await fixture(t);
  let requests = 0,
    now = Date.parse("2026-10-13T12:00:00Z"),
    wrong = false;
  const expired = new UsageManager(
    f.store,
    async () => ({ ...credential, expiresAt: 0 }),
    async () => {
      requests++;
      return {};
    },
    () => now,
  );
  assert.equal((await expired.refresh(f.a.id)).issue, "expired");
  assert.equal(requests, 0);
  const manager = new UsageManager(
    f.store,
    async () => credential,
    async (endpoint) =>
      endpoint === "profile" ? (wrong ? {} : profile) : limits,
    () => now,
  );
  await manager.refresh(f.a.id);
  now += 300_000;
  wrong = true;
  const u = await manager.refresh(f.a.id);
  assert.equal(u.issue, "identity-mismatch");
  assert.equal(u.fiveHour, undefined);
});
test("confirmed reconnect clears obsolete auth, permission and transient waits and resets failures", async (t) => {
  for (const issue of [
    "expired",
    "scope",
    "credentials-missing",
    "keychain-locked",
    "unavailable",
  ] as const) {
    await t.test(issue, async (t) => {
      const f = await fixture(t);
      let now = Date.parse("2026-10-13T12:00:00Z"),
        failing = true,
        reads = 0;
      const manager = new UsageManager(
        f.store,
        async () => {
          reads++;
          if (failing) throw new UsageError(issue);
          return credential;
        },
        async (endpoint) => (endpoint === "profile" ? profile : limits),
        () => now,
      );
      const first = await manager.refresh(f.a.id);
      assert.equal(first.issue, issue);
      now = Date.parse(first.retryAt!);
      const second = await manager.refresh(f.a.id);
      assert.equal(Date.parse(second.retryAt!), now + 240_000);
      manager.invalidate(f.a.id);
      const newFailure = await manager.refresh(f.a.id);
      assert.equal(reads, 3, "reconnect permits an immediate new read");
      assert.equal(Date.parse(newFailure.retryAt!), now + 120_000);
      failing = false;
      manager.invalidate(f.a.id);
      assert.equal((await manager.refresh(f.a.id)).status, "ready");
      assert.equal(reads, 4);
    });
  }
});
test("confirmed reconnect preserves a server Retry-After and exposes why polling waits", async (t) => {
  const f = await fixture(t);
  let now = Date.parse("2026-10-13T12:00:00Z"),
    limited = false,
    reads = 0;
  const retryAt = now + 900_000;
  const manager = new UsageManager(
    f.store,
    async () => {
      reads++;
      return credential;
    },
    async (endpoint) => {
      if (limited) throw new UsageError("rate-limited", retryAt);
      return endpoint === "profile" ? profile : limits;
    },
    () => now,
  );
  await manager.refresh(f.a.id);
  now += 60_000;
  limited = true;
  assert.equal((await manager.refresh(f.a.id)).issue, "rate-limited");
  manager.invalidate(f.a.id);
  const waiting = manager.snapshot()[f.a.id];
  assert.equal(waiting.issue, "rate-limited");
  assert.equal(waiting.retryAt, new Date(retryAt).toISOString());
  assert.equal(waiting.fiveHour, undefined, "old login's quota is removed");
  assert.equal(waiting.stale, false);
  manager.invalidate(f.a.id);
  await manager.refresh(f.a.id, true);
  manager.tick();
  assert.equal(reads, 2, "neither reconnect nor manual refresh bypasses 429");
  now = retryAt;
  limited = false;
  assert.equal((await manager.refresh(f.a.id)).status, "ready");
  assert.equal(reads, 3);
});
test("an earlier login's in-flight completion cannot overwrite or undeduplicate its replacement", async (t) => {
  for (const oldFails of [false, true]) {
    for (const oldFinishesFirst of [false, true]) {
      await t.test(
        `${oldFails ? "failure" : "success"}, old finishes ${oldFinishesFirst ? "first" : "last"}`,
        async (t) => {
          const f = await fixture(t);
          const deferred = <T>() => {
            let resolve!: (value: T) => void, reject!: (error: unknown) => void;
            const promise = new Promise<T>((yes, no) => {
              resolve = yes;
              reject = no;
            });
            return { promise, resolve, reject };
          };
          const oldUsage = deferred<unknown>(),
            newUsage = deferred<unknown>(),
            oldStarted = deferred<void>(),
            newStarted = deferred<void>();
          let reads = 0,
            requests = 0;
          const manager = new UsageManager(
            f.store,
            async () => ({
              ...credential,
              accessToken: ++reads === 1 ? "old-fixture" : "new-fixture",
            }),
            async (endpoint, token) => {
              requests++;
              if (endpoint === "profile") return profile;
              const old = token === "old-fixture";
              (old ? oldStarted : newStarted).resolve();
              return (old ? oldUsage : newUsage).promise;
            },
            () => Date.parse("2026-10-13T12:00:00Z"),
          );
          const original = manager.refresh(f.a.id);
          await oldStarted.promise;
          manager.invalidate(f.a.id);
          const replacement = manager.refresh(f.a.id);
          await newStarted.promise;
          const finishOld = async () => {
            if (oldFails) oldUsage.reject(new UsageError("expired"));
            else oldUsage.resolve(limits);
            await original;
          };
          const finishNew = async () => {
            newUsage.resolve({ five_hour: { utilization: 12 } });
            await replacement;
          };
          if (oldFinishesFirst) {
            await finishOld();
            assert.equal(manager.snapshot()[f.a.id].status, "loading");
            assert.equal(manager.snapshot()[f.a.id].fiveHour, undefined);
            assert.equal(manager.refresh(f.a.id), replacement);
            await finishNew();
          } else {
            await finishNew();
            await finishOld();
          }
          const latest = manager.snapshot()[f.a.id];
          assert.equal(latest.status, "ready");
          assert.equal(latest.issue, undefined);
          assert.equal(latest.fiveHour?.usedPercent, 12);
          assert.equal(reads, 2);
          assert.equal(requests, 4);
        },
      );
    }
  }
});
test("old usage never silently becomes 100% after reset; manual polling mode does not poll", async (t) => {
  const f = await fixture(t);
  let now = Date.parse("2026-10-13T12:00:00Z"),
    reads = 0;
  const manager = new UsageManager(
    f.store,
    async () => {
      reads++;
      return credential;
    },
    async (endpoint) => (endpoint === "profile" ? profile : limits),
    () => now,
  );
  f.store.update((s) => {
    s.settings.usageRefreshMinutes = 0;
  });
  manager.tick();
  assert.equal(reads, 0);
  await manager.refresh(f.a.id);
  now = Date.parse("2026-10-13T16:01:00Z");
  const u = manager.snapshot()[f.a.id];
  assert.equal(u.stale, true);
  assert.equal(u.fiveHour!.usedPercent, 91.3);
});
test("legacy preferences migrate without losing accounts and updates survive reload", async (t) => {
  const f = await fixture(t);
  const old = JSON.parse(await fs.readFile(f.store.file, "utf8"));
  delete old.settings;
  await fs.writeFile(f.store.file, JSON.stringify(old));
  const migrated = new Store(f.root);
  assert.deepEqual(migrated.state.settings, DEFAULT_SETTINGS);
  assert.equal(migrated.account(f.a.id).name, "A");
  migrated.update((s) => {
    s.settings.desktopHistoryTransfer = "off";
    s.settings.usageRefreshMinutes = 15;
  });
  assert.equal(new Store(f.root).state.settings.desktopHistoryTransfer, "off");
  assert.equal(new Store(f.root).state.settings.usageRefreshMinutes, 15);
  assert.throws(() =>
    settingsSchema.partial().parse({ usageRefreshMinutes: 1 }),
  );
  assert.throws(() => settingsSchema.partial().parse({ autoSwitch: true }));
});
test("suggestions require fresh five-hour data, use weekly data when reported and stay in the same sharing group", async (t) => {
  const f = await fixture(t),
    now = Date.parse("2026-10-13T12:00:00Z");
  const active = {
    ...f.a,
    desktop: { accountUuid: "a", orgId: "x", savedAt: "" },
  };
  const personal = { ...active, id: "b", name: "B" },
    work = { ...personal, id: "c", group: "work:secret" };
  const u: AccountUsage = {
    accountId: active.id,
    status: "ready",
    stale: false,
    checkedAt: new Date(now).toISOString(),
    fiveHour: { usedPercent: 95 },
    sevenDay: { usedPercent: 40 },
  };
  const usage = {
    [active.id]: u,
    b: { ...u, accountId: "b", fiveHour: { usedPercent: 10 } },
    c: { ...u, accountId: "c", fiveHour: { usedPercent: 1 } },
  };
  assert.equal(
    suggestedAccount(
      active,
      [active, personal, work],
      usage,
      DEFAULT_SETTINGS,
      now,
    )?.id,
    "b",
  );
  assert.equal(
    suggestedAccount(
      active,
      [active, personal, work],
      { ...usage, b: { ...usage.b, stale: true } },
      DEFAULT_SETTINGS,
      now,
    ),
    undefined,
  );
  assert.equal(
    suggestedAccount(
      active,
      [active, personal],
      { ...usage, b: { ...usage.b, fiveHour: undefined } },
      DEFAULT_SETTINGS,
      now,
    ),
    undefined,
  );
  assert.equal(
    suggestedAccount(
      active,
      [active, personal],
      { ...usage, b: { ...usage.b, sevenDay: undefined } },
      DEFAULT_SETTINGS,
      now,
    )?.id,
    "b",
  );
  assert.equal(
    suggestedAccount(
      active,
      [active, personal],
      usage,
      { ...DEFAULT_SETTINGS, suggestAccounts: false },
      now,
    ),
    undefined,
  );
});

test("50-account polling has at most two concurrent readers and isolates each profile", async (t) => {
  const f = await fixture(t);
  for (let i = 1; i < 50; i++)
    f.store.create({ name: `Account ${i}`, kind: "personal" });
  f.store.update((s) =>
    s.accounts.forEach((a) => {
      a.auth = { ...f.a.auth! };
    }),
  );
  let active = 0,
    peak = 0;
  const seen = new Set<string>();
  const manager = new UsageManager(
    f.store,
    async (profilePath) => {
      active++;
      peak = Math.max(peak, active);
      seen.add(profilePath);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      return credential;
    },
    async (endpoint) => (endpoint === "profile" ? profile : limits),
    () => Date.parse("2026-10-13T12:00:00Z"),
  );
  const results = await Promise.all(
    f.store.state.accounts.map((a) => manager.refresh(a.id)),
  );
  assert.equal(peak, 2);
  assert.equal(seen.size, 50);
  assert.ok(results.every((r) => r.status === "ready"));
});
test("cached quota disappears immediately when the profile's identity changes", async (t) => {
  const f = await fixture(t);
  const manager = new UsageManager(
    f.store,
    async () => credential,
    async (endpoint) => (endpoint === "profile" ? profile : limits),
    () => Date.parse("2026-10-13T12:00:00Z"),
  );
  await manager.refresh(f.a.id);
  assert.ok(manager.snapshot()[f.a.id].fiveHour);
  f.store.update((s) => {
    s.accounts[0].auth!.email = "new@example.test";
  });
  assert.equal(manager.snapshot()[f.a.id].fiveHour, undefined);
  assert.equal(manager.snapshot()[f.a.id].status, "idle");
});
test("cached quota disappears when CLI UUID or organization changes with the same email", async (t) => {
  for (const field of ["accountUuid", "orgId"] as const) {
    await t.test(field, async (t) => {
      const f = await fixture(t);
      const accountUuid = "11111111-1111-4111-8111-111111111111",
        orgId = "22222222-2222-4222-8222-222222222222",
        changedId = "33333333-3333-4333-8333-333333333333";
      f.store.update((s) => {
        s.accounts[0].auth = { ...s.accounts[0].auth!, accountUuid, orgId };
      });
      const manager = new UsageManager(
        f.store,
        async () => credential,
        async (endpoint) =>
          endpoint === "profile"
            ? {
                account: { ...profile.account, uuid: accountUuid },
                organization: { uuid: orgId },
              }
            : limits,
        () => Date.parse("2026-10-13T12:00:00Z"),
      );
      assert.equal((await manager.refresh(f.a.id)).status, "ready");
      f.store.update((s) => {
        s.accounts[0].auth![field] = changedId;
      });
      const current = manager.snapshot()[f.a.id];
      assert.equal(current.fiveHour, undefined);
      assert.equal(current.status, "idle");
    });
  }
});
test("a model-specific weekly window at its limit is reported without becoming a main window", () => {
  const parsed = parseUsage({
    five_hour: { utilization: 40, resets_at: "2026-10-13T20:00:00Z" },
    seven_day: { utilization: 70, resets_at: "2026-10-18T05:00:00Z" },
    seven_day_opus: { utilization: 100, resets_at: "2026-10-18T05:00:00Z" },
    seven_day_oauth_apps: null,
  });
  assert.equal(parsed.otherLimitReached, true);
  assert.equal(parsed.fiveHour?.usedPercent, 40);
  assert.equal(
    parseUsage({
      five_hour: { utilization: 10 },
      seven_day_opus: { utilization: 20 },
    }).otherLimitReached,
    undefined,
  );
});
test("a verified read restores identity fields an older registry lost, never changing existing ones", async (t) => {
  const f = await fixture(t);
  const accountUuid = "11111111-1111-4111-8111-111111111111",
    orgId = "22222222-2222-4222-8222-222222222222";
  f.store.update((s) => {
    s.accounts[0].desktop = {
      accountUuid,
      orgId,
      savedAt: "2026-10-13T00:00:00.000Z",
    };
  });
  const verified = {
    account: { email_address: "a@example.test", uuid: accountUuid },
    organization: { uuid: orgId, name: "Example Org" },
  };
  const manager = new UsageManager(
    f.store,
    async () => credential,
    async (endpoint) => (endpoint === "profile" ? verified : limits),
    () => Date.parse("2026-10-13T12:00:00Z"),
  );
  const result = await manager.refresh(f.a.id);
  assert.equal(result.status, "ready");
  const repaired = f.store.account(f.a.id);
  assert.equal(repaired.auth?.accountUuid, accountUuid);
  assert.equal(repaired.auth?.orgId, orgId);
  assert.equal(repaired.auth?.orgName, "Example Org");
  assert.equal(repaired.desktop?.email, "a@example.test");
  assert.equal(manager.snapshot()[f.a.id].status, "ready");
  // A response for a different organization repairs nothing.
  assert.equal(
    missingIdentity(
      { ...repaired, auth: { ...repaired.auth!, orgId: undefined } },
      { ...verified, organization: { uuid: randomUUID() } },
    ),
    undefined,
  );
});
