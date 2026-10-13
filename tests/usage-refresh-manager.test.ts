import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { Store } from "../electron/core/store";
import { UsageManager } from "../electron/core/usage";
import {
  UsageError,
  type UsageCredential,
} from "../electron/core/usage-credentials";
import { UsageCredentialRefresher } from "../electron/core/usage-refresh";
import type { AccountUsage } from "../shared/types";

const NOW = Date.parse("2026-10-13T18:00:00Z");
const old: UsageCredential = {
  accessToken: "fixture-old-access-secret",
  refreshToken: "fixture-old-refresh-secret",
  expiresAt: NOW + 300_000,
  scopes: ["user:profile", "user:inference"],
};
const replacement: UsageCredential = {
  ...old,
  accessToken: "fixture-new-authoritative-secret",
  refreshToken: "fixture-new-refresh-secret",
  expiresAt: NOW + 3_600_000,
};
const limits = {
  five_hour: { utilization: 24, resets_at: "2026-10-13T22:00:00Z" },
  seven_day: { utilization: 48, resets_at: "2026-10-18T08:00:00Z" },
};
async function fixture(t: any) {
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), "relay-refresh-manager-"),
  );
  const root = await fs.realpath(temporary);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  const created = store.create({ name: "Enrolled", kind: "personal" });
  const accountUuid = randomUUID(),
    orgId = randomUUID();
  store.update((s) => {
    s.accounts[0].auth = {
      loggedIn: true,
      accountUuid,
      orgId,
      email: "enrolled@example.test",
      checkedAt: new Date(NOW).toISOString(),
    };
    s.accounts[0].desktop = {
      accountUuid,
      orgId,
      savedAt: new Date(NOW).toISOString(),
    };
  });
  const account = store.account(created.id);
  const profile = {
    account: { uuid: accountUuid, email_address: account.auth!.email },
    organization: { uuid: orgId },
  };
  return { store, account, profile, directory: store.profile(account.id) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function assertNoSecrets(value: unknown) {
  const serialized = JSON.stringify(value);
  for (const secret of [
    old.accessToken,
    old.refreshToken!,
    replacement.accessToken,
    replacement.refreshToken!,
    "provider-error-secret",
  ])
    assert.equal(serialized.includes(secret), false);
}

test("usage proactively renews at the five-minute boundary and only reads quotas with the authoritative token", async (t) => {
  const f = await fixture(t);
  const requests: [string, string][] = [],
    samples: AccountUsage[] = [];
  let renewals = 0;
  const manager = new UsageManager(
    f.store,
    async (directory, prompt) => {
      assert.equal(directory, f.directory);
      assert.equal(prompt, false);
      return old;
    },
    async (endpoint, token) => {
      requests.push([endpoint, token]);
      return endpoint === "profile" ? f.profile : limits;
    },
    () => NOW,
    (account, usage) => {
      assert.equal(account.auth!.accountUuid, f.account.auth!.accountUuid);
      samples.push(usage);
    },
    async (account, supplied, force) => {
      renewals++;
      assert.deepEqual(account, f.account);
      assert.deepEqual(supplied, old);
      assert.equal(force, false);
      return replacement;
    },
  );
  const first = manager.refresh(f.account.id),
    duplicate = manager.refresh(f.account.id);
  assert.equal(first, duplicate);
  const result = await first;
  assert.equal(renewals, 1);
  assert.deepEqual(requests, [
    ["profile", replacement.accessToken],
    ["usage", replacement.accessToken],
  ]);
  assert.equal(result.status, "ready");
  assert.equal(result.fiveHour!.usedPercent, 24);
  assert.equal(samples.length, 1);
  assert.deepEqual(samples[0], result);
  assertNoSecrets([result, manager.snapshot(), samples]);
});

test("usage does not proactively rotate a credential just beyond the five-minute boundary", async (t) => {
  const f = await fixture(t);
  let renewals = 0;
  const manager = new UsageManager(
    f.store,
    async () => ({ ...old, expiresAt: NOW + 300_001 }),
    async (endpoint, token) => {
      assert.equal(token, old.accessToken);
      return endpoint === "profile" ? f.profile : limits;
    },
    () => NOW,
    undefined,
    async () => {
      renewals++;
      return replacement;
    },
  );
  assert.equal((await manager.refresh(f.account.id)).status, "ready");
  assert.equal(renewals, 0);
});

test("a pending credential attempt invokes reconciliation even when the saved access token is fresh beyond five minutes", async (t) => {
  const f = await fixture(t);
  const supplied = { ...old, expiresAt: NOW + 3_600_000 };
  let reconciliations = 0,
    probes = 0;
  const requests: [string, string][] = [];
  const manager = new UsageManager(
    f.store,
    async () => supplied,
    async (endpoint, token) => {
      requests.push([endpoint, token]);
      return endpoint === "profile" ? f.profile : limits;
    },
    () => NOW,
    undefined,
    async (account, credential, force) => {
      reconciliations++;
      assert.deepEqual(account, f.account);
      assert.equal(credential, supplied);
      assert.equal(force, false);
      return replacement;
    },
    (account) => {
      probes++;
      assert.deepEqual(account, f.account);
      return true;
    },
  );
  const result = await manager.refresh(f.account.id);
  assert.equal(result.status, "ready");
  assert.equal(reconciliations, 1);
  assert.equal(probes, 1);
  assert.deepEqual(requests, [
    ["profile", replacement.accessToken],
    ["usage", replacement.accessToken],
  ]);
});

test("a genuine pending journal blocks fresh quota reads until a confirmed browser replacement is reread and verified", async (t) => {
  const f = await fixture(t);
  const unverified = { ...old, expiresAt: NOW + 3_600_000 };
  let saved: UsageCredential = unverified;
  let exchanges = 0,
    samples = 0;
  const requests: [string, string][] = [];
  const request = async (endpoint: "profile" | "usage", token: string) => {
    requests.push([endpoint, token]);
    assert.equal(token, replacement.accessToken);
    return endpoint === "profile" ? f.profile : limits;
  };
  const refresher = new UsageCredentialRefresher({
    platform: "linux",
    executable: async () => path.join(f.directory, "fixture-cli"),
    read: async () => saved,
    request,
    run: async () => {
      exchanges++;
      throw new Error("provider-error-secret");
    },
    now: () => NOW,
  });
  await assert.rejects(
    refresher.refresh(f.account, f.directory, unverified, true),
    /expired/,
  );
  assert.equal(refresher.hasPending(f.directory), true);
  const reconciliations: boolean[] = [];
  const manager = new UsageManager(
    f.store,
    async () => saved,
    request,
    () => NOW,
    () => {
      samples++;
    },
    async (account, credential, force) => {
      reconciliations.push(!!force);
      return refresher.refresh(account, f.directory, credential, force);
    },
    () => refresher.hasPending(f.directory),
  );
  const blocked = await manager.refresh(f.account.id);
  assert.equal(blocked.issue, "expired");
  assert.equal(samples, 0);
  assert.equal(requests.length, 0);
  assert.deepEqual(reconciliations, [false]);
  assert.equal(exchanges, 1);
  // Connected-login lifecycle: invalidate cached failure, then reread the new
  // isolated credential. Presence of a replacement alone does not clear intent.
  saved = replacement;
  manager.invalidate(f.account.id);
  assert.equal(refresher.hasPending(f.directory), true);
  const result = await manager.refresh(f.account.id);
  assert.equal(result.status, "ready");
  assert.equal(samples, 1);
  assert.equal(exchanges, 1);
  assert.deepEqual(reconciliations, [false, false]);
  assert.deepEqual(requests, [
    ["profile", replacement.accessToken],
    ["profile", replacement.accessToken],
    ["usage", replacement.accessToken],
  ]);
  assert.equal(refresher.hasPending(f.directory), false);
  assertNoSecrets([blocked, result, manager.snapshot()]);
});

test("a fresh saved replacement without a refresh token reconciles pending intent through scope and server identity proof", async (t) => {
  const f = await fixture(t);
  let saved: UsageCredential = old;
  let exchanges = 0,
    samples = 0,
    reconciliations = 0;
  const verifyStarted = deferred<void>(),
    verification = deferred<unknown>();
  const requests: [string, string][] = [];
  const request = async (endpoint: "profile" | "usage", token: string) => {
    requests.push([endpoint, token]);
    assert.equal(token, replacement.accessToken);
    if (requests.length === 1) {
      assert.equal(endpoint, "profile");
      verifyStarted.resolve();
      return verification.promise;
    }
    return endpoint === "profile" ? f.profile : limits;
  };
  const refresher = new UsageCredentialRefresher({
    platform: "linux",
    executable: async () => path.join(f.directory, "fixture-cli"),
    read: async () => saved,
    request,
    run: async () => {
      exchanges++;
      throw new Error("provider-error-secret");
    },
    now: () => NOW,
  });
  await assert.rejects(
    refresher.refresh(f.account, f.directory, old),
    /expired/,
  );
  saved = { ...replacement, refreshToken: undefined };
  const manager = new UsageManager(
    f.store,
    async () => saved,
    request,
    () => NOW,
    () => {
      samples++;
    },
    async (account, credential, force) => {
      reconciliations++;
      assert.equal(force, false);
      assert.equal(credential.refreshToken, undefined);
      assert.deepEqual(credential.scopes, old.scopes);
      return refresher.refresh(account, f.directory, credential, force);
    },
    () => refresher.hasPending(f.directory),
  );
  const pending = manager.refresh(f.account.id);
  await verifyStarted.promise;
  assert.equal(refresher.hasPending(f.directory), true);
  assert.equal(samples, 0);
  assert.equal(reconciliations, 1);
  assert.equal(exchanges, 1);
  verification.resolve(f.profile);
  const result = await pending;
  assert.equal(result.status, "ready");
  assert.equal(samples, 1);
  assert.equal(exchanges, 1);
  assert.equal(refresher.hasPending(f.directory), false);
  assert.deepEqual(requests, [
    ["profile", replacement.accessToken],
    ["profile", replacement.accessToken],
    ["usage", replacement.accessToken],
  ]);
  assertNoSecrets([result, manager.snapshot()]);
});

test("pending reconciliation and pending-probe failures remain safe errors without quota fallback", async (t) => {
  for (const failure of ["probe", "reconciliation"] as const) {
    await t.test(failure, async (t) => {
      const f = await fixture(t);
      let requests = 0,
        samples = 0,
        reconciliations = 0;
      const error = () => {
        throw new Error(
          `provider-error-secret ${old.accessToken} ${old.refreshToken}`,
        );
      };
      const manager = new UsageManager(
        f.store,
        async () => ({ ...old, expiresAt: NOW + 3_600_000 }),
        async () => {
          requests++;
          return limits;
        },
        () => NOW,
        () => {
          samples++;
        },
        async () => {
          reconciliations++;
          return error();
        },
        () => (failure === "probe" ? error() : true),
      );
      const failed = await manager.refresh(f.account.id);
      assert.equal(failed.issue, "unavailable");
      assert.equal(requests, 0);
      assert.equal(samples, 0);
      assert.equal(reconciliations, failure === "probe" ? 0 : 1);
      await manager.refresh(f.account.id);
      assert.equal(reconciliations, failure === "probe" ? 0 : 1);
      assertNoSecrets([failed, manager.snapshot()]);
    });
  }
});

test("a profile 401 forces one renewal before expiry and retries identity and quotas with the new token", async (t) => {
  const f = await fixture(t);
  const requests: [string, string][] = [];
  let renewals = 0,
    samples = 0;
  const manager = new UsageManager(
    f.store,
    async () => ({ ...old, expiresAt: NOW + 3_600_000 }),
    async (endpoint, token) => {
      requests.push([endpoint, token]);
      if (token === old.accessToken) throw new UsageError("expired");
      return endpoint === "profile" ? f.profile : limits;
    },
    () => NOW,
    () => {
      samples++;
    },
    async (account, supplied, force) => {
      renewals++;
      assert.equal(account.id, f.account.id);
      assert.equal(force, true);
      assert.equal(supplied.accessToken, old.accessToken);
      return replacement;
    },
  );
  assert.equal((await manager.refresh(f.account.id)).status, "ready");
  assert.equal(renewals, 1);
  assert.equal(samples, 1);
  assert.deepEqual(requests, [
    ["profile", old.accessToken],
    ["profile", replacement.accessToken],
    ["usage", replacement.accessToken],
  ]);
});

test("manager and refresher verify the saved replacement before reading usage with that same token", async (t) => {
  const f = await fixture(t);
  let saved = old,
    exchanges = 0,
    samples = 0;
  const requests: [string, string][] = [];
  const request = async (endpoint: "profile" | "usage", token: string) => {
    requests.push([endpoint, token]);
    assert.equal(token, replacement.accessToken);
    return endpoint === "profile" ? f.profile : limits;
  };
  const refresher = new UsageCredentialRefresher({
    platform: "linux",
    executable: async () => path.join(f.directory, "fixture-cli"),
    read: async () => saved,
    request,
    run: async () => {
      exchanges++;
      saved = replacement;
    },
    now: () => NOW,
  });
  const manager = new UsageManager(
    f.store,
    async () => saved,
    request,
    () => NOW,
    () => {
      samples++;
    },
    (account, supplied, force) =>
      refresher.refresh(account, f.directory, supplied, force),
  );
  const result = await manager.refresh(f.account.id);
  assert.equal(result.status, "ready");
  assert.equal(exchanges, 1);
  assert.equal(samples, 1);
  assert.deepEqual(requests, [
    ["profile", replacement.accessToken],
    ["profile", replacement.accessToken],
    ["usage", replacement.accessToken],
  ]);
  assertNoSecrets([result, manager.snapshot()]);
});

test("a replacement profile 401 never triggers a second rotation after either proactive or forced renewal", async (t) => {
  for (const proactive of [true, false]) {
    await t.test(proactive ? "proactive" : "forced", async (t) => {
      const f = await fixture(t);
      let renewals = 0,
        requests = 0,
        samples = 0;
      const manager = new UsageManager(
        f.store,
        async () => ({
          ...old,
          expiresAt: NOW + (proactive ? 300_000 : 3_600_000),
        }),
        async (endpoint) => {
          requests++;
          assert.equal(endpoint, "profile");
          throw new UsageError("expired");
        },
        () => NOW,
        () => {
          samples++;
        },
        async (_account, _supplied, force) => {
          renewals++;
          assert.equal(force, !proactive);
          return replacement;
        },
      );
      const result = await manager.refresh(f.account.id);
      assert.equal(result.issue, "expired");
      assert.equal(result.status, "error");
      assert.equal(renewals, 1);
      assert.equal(requests, proactive ? 1 : 2);
      assert.equal(samples, 0);
      await manager.refresh(f.account.id);
      assert.equal(renewals, 1);
      assertNoSecrets([result, manager.snapshot()]);
    });
  }
});

test("invalidation during rotation prevents subsequent requests, samples and old completion cache writes", async (t) => {
  for (const proactive of [true, false]) {
    await t.test(proactive ? "proactive" : "forced", async (t) => {
      const f = await fixture(t);
      const started = deferred<void>(),
        rotation = deferred<UsageCredential>();
      let requests = 0,
        samples = 0,
        renewals = 0;
      const manager = new UsageManager(
        f.store,
        async () => ({
          ...old,
          expiresAt: NOW + (proactive ? 300_000 : 3_600_000),
        }),
        async () => {
          requests++;
          throw new UsageError("expired");
        },
        () => NOW,
        () => {
          samples++;
        },
        async () => {
          renewals++;
          started.resolve();
          return rotation.promise;
        },
      );
      const pending = manager.refresh(f.account.id);
      await started.promise;
      manager.invalidate(f.account.id);
      rotation.resolve(replacement);
      const result = await pending;
      assert.equal(renewals, 1);
      assert.equal(requests, proactive ? 0 : 1);
      assert.equal(samples, 0);
      assert.equal(result.status, "idle");
      assert.equal(result.fiveHour, undefined);
      assert.deepEqual(manager.snapshot()[f.account.id], result);
    });
  }
});

test("rotation callback failures hide provider details and tokens without fallback requests or a second attempt", async (t) => {
  const f = await fixture(t);
  let renewals = 0,
    requests = 0,
    samples = 0;
  const manager = new UsageManager(
    f.store,
    async () => old,
    async () => {
      requests++;
      return limits;
    },
    () => NOW,
    () => {
      samples++;
    },
    async () => {
      renewals++;
      throw new Error(
        `provider-error-secret ${old.accessToken} ${old.refreshToken}`,
      );
    },
  );
  const [first, second] = await Promise.all([
    manager.refresh(f.account.id),
    manager.refresh(f.account.id),
  ]);
  assert.deepEqual(first, second);
  assert.equal(first.issue, "unavailable");
  assert.equal(renewals, 1);
  assert.equal(requests, 0);
  assert.equal(samples, 0);
  await manager.refresh(f.account.id);
  assert.equal(renewals, 1);
  assertNoSecrets([first, manager.snapshot()]);
});

test("an uncertain exchange remains blocked after the manager's retry delay without rotating the same credential again", async (t) => {
  const f = await fixture(t);
  let now = NOW,
    exchanges = 0,
    requests = 0,
    samples = 0;
  const refresher = new UsageCredentialRefresher({
    platform: "linux",
    executable: async () => path.join(f.directory, "fixture-cli"),
    read: async () => old,
    request: async () => {
      requests++;
      return f.profile;
    },
    run: async () => {
      exchanges++;
      throw new Error("provider-error-secret");
    },
    now: () => now,
  });
  const manager = new UsageManager(
    f.store,
    async () => old,
    async () => {
      requests++;
      return limits;
    },
    () => now,
    () => {
      samples++;
    },
    (account, supplied, force) =>
      refresher.refresh(account, f.directory, supplied, force),
  );
  const failed = await manager.refresh(f.account.id);
  assert.equal(failed.issue, "expired");
  assert.equal(exchanges, 1);
  now = Date.parse(failed.retryAt!) + 1;
  const retried = await manager.refresh(f.account.id);
  assert.equal(retried.issue, "expired");
  assert.equal(exchanges, 1);
  assert.equal(requests, 0);
  assert.equal(samples, 0);
  assertNoSecrets([failed, retried, manager.snapshot()]);
});

test("an expired or profile-less replacement is rejected before server reads and history samples", async (t) => {
  const cases: [string, UsageCredential, string][] = [
    ["expired", { ...replacement, expiresAt: NOW }, "expired"],
    [
      "missing-profile-scope",
      { ...replacement, scopes: ["user:inference"] },
      "scope",
    ],
  ];
  for (const [name, credential, issue] of cases) {
    await t.test(name, async (t) => {
      const f = await fixture(t);
      let requests = 0,
        samples = 0;
      const manager = new UsageManager(
        f.store,
        async () => old,
        async () => {
          requests++;
          return limits;
        },
        () => NOW,
        () => {
          samples++;
        },
        async () => credential,
      );
      assert.equal((await manager.refresh(f.account.id)).issue, issue);
      assert.equal(requests, 0);
      assert.equal(samples, 0);
    });
  }
});

test("a renewed token must still verify the enrolled UUID and Desktop organization before quotas", async (t) => {
  for (const field of ["account", "organization"] as const) {
    await t.test(field, async (t) => {
      const f = await fixture(t);
      let requests = 0,
        samples = 0;
      const manager = new UsageManager(
        f.store,
        async () => old,
        async (endpoint, token) => {
          requests++;
          assert.equal(endpoint, "profile");
          assert.equal(token, replacement.accessToken);
          return {
            ...f.profile,
            [field]: { ...f.profile[field], uuid: randomUUID() },
          };
        },
        () => NOW,
        () => {
          samples++;
        },
        async () => replacement,
      );
      assert.equal(
        (await manager.refresh(f.account.id)).issue,
        "identity-mismatch",
      );
      assert.equal(requests, 1);
      assert.equal(samples, 0);
    });
  }
});

test("missing refresh tokens or required scopes cannot start a credential exchange through the manager", async (t) => {
  const cases: [string, UsageCredential][] = [
    [
      "missing-refresh-token",
      { ...old, expiresAt: NOW - 1, refreshToken: undefined },
    ],
    ["missing-profile-scope", { ...old, scopes: ["user:inference"] }],
    ["missing-inference-scope", { ...old, scopes: ["user:profile"] }],
  ];
  for (const [name, credential] of cases) {
    await t.test(name, async (t) => {
      const f = await fixture(t);
      let exchanges = 0,
        requests = 0,
        samples = 0;
      const refresher = new UsageCredentialRefresher({
        platform: "linux",
        executable: async () => path.join(f.directory, "never-executed-cli"),
        read: async () => credential,
        request: async () => {
          requests++;
          return f.profile;
        },
        run: async () => {
          exchanges++;
        },
        now: () => NOW,
      });
      const manager = new UsageManager(
        f.store,
        async () => credential,
        async () => {
          requests++;
          return limits;
        },
        () => NOW,
        () => {
          samples++;
        },
        (account, supplied, force) =>
          refresher.refresh(account, f.directory, supplied, force),
      );
      const result = await manager.refresh(f.account.id);
      assert.equal(result.status, "error");
      assert.equal(exchanges, 0);
      assert.equal(requests, 0);
      assert.equal(samples, 0);
      assertNoSecrets([result, manager.snapshot()]);
    });
  }
});

test("usage forwards explicit interaction consent to both proactive and forced credential renewal", async (t) => {
  for (const allowInteraction of [false, true]) {
    for (const force of [false, true]) {
      await t.test(
        `${allowInteraction ? "foreground" : "background"}-${force ? "401" : "expiry"}`,
        async (t) => {
          const f = await fixture(t);
          const supplied = {
            ...old,
            expiresAt: NOW + (force ? 3_600_000 : 300_000),
          };
          const prompts: boolean[] = [];
          const renewals: {
            force: boolean | undefined;
            interaction: boolean | undefined;
          }[] = [];
          const manager = new UsageManager(
            f.store,
            async (_profile, allowPrompt) => {
              prompts.push(allowPrompt);
              return supplied;
            },
            async (endpoint, token) => {
              if (token === old.accessToken) throw new UsageError("expired");
              return endpoint === "profile" ? f.profile : limits;
            },
            () => NOW,
            undefined,
            async (_account, _credential, forced, interaction) => {
              renewals.push({ force: forced, interaction });
              return replacement;
            },
          );
          const result = await manager.refresh(f.account.id, allowInteraction);
          assert.equal(result.status, "ready");
          assert.deepEqual(prompts, [allowInteraction]);
          assert.deepEqual(renewals, [
            { force, interaction: allowInteraction },
          ]);
          assertNoSecrets([result, manager.snapshot()]);
        },
      );
    }
  }
});

test("macOS background renewal keeps still-valid verified quotas and explicit renewal replaces the connection without waiting for cache expiry", async (t) => {
  const f = await fixture(t);
  let saved = old,
    executions = 0,
    executableLookups = 0;
  const requests: [string, string][] = [];
  const interactions: (boolean | undefined)[] = [];
  const prompts: boolean[] = [];
  const samples: AccountUsage[] = [];
  const request = async (endpoint: "profile" | "usage", token: string) => {
    requests.push([endpoint, token]);
    return endpoint === "profile" ? f.profile : limits;
  };
  const refresher = new UsageCredentialRefresher({
    platform: "darwin",
    executable: async () => {
      executableLookups++;
      return path.join(f.directory, "mock-cli");
    },
    read: async (_profile, allowPrompt) => {
      assert.equal(allowPrompt, false);
      return saved;
    },
    request,
    run: async () => {
      executions++;
      saved = replacement;
    },
    now: () => NOW,
  });
  const manager = new UsageManager(
    f.store,
    async (_profile, allowPrompt) => {
      prompts.push(allowPrompt);
      return saved;
    },
    request,
    () => NOW,
    (_account, usage) => {
      samples.push(usage);
    },
    (account, credential, force, allowInteraction) => {
      interactions.push(allowInteraction);
      return refresher.refresh(
        account,
        f.directory,
        credential,
        force,
        allowInteraction,
      );
    },
    () => refresher.hasPending(f.directory),
  );
  const background = await manager.refresh(f.account.id);
  assert.equal(background.status, "ready");
  assert.equal(background.stale, false);
  assert.equal(background.issue, undefined);
  assert.equal(background.connectionRenewalRequired, true);
  assert.equal(background.fiveHour!.usedPercent, 24);
  assert.equal(background.sevenDay!.usedPercent, 48);
  assert.equal(executions, 0);
  assert.equal(
    executableLookups,
    0,
    "background reads must not even resolve a command that can open Keychain",
  );
  assert.equal(
    refresher.hasPending(f.directory),
    false,
    "read-only refusal must not create an uncertain rotation journal",
  );
  assert.deepEqual(requests, [
    ["profile", old.accessToken],
    ["usage", old.accessToken],
  ]);
  // The user approves connection renewal immediately, within the normal
  // one-minute read cache. This explicit action must run rather than no-op.
  const foreground = await manager.refresh(f.account.id, true);
  assert.equal(foreground.status, "ready");
  assert.equal(foreground.connectionRenewalRequired, undefined);
  assert.equal(executions, 1);
  assert.equal(executableLookups, 1);
  assert.equal(refresher.hasPending(f.directory), false);
  assert.deepEqual(prompts, [false, true]);
  assert.deepEqual(interactions, [false, true]);
  assert.deepEqual(requests.slice(2), [
    ["profile", replacement.accessToken],
    ["profile", replacement.accessToken],
    ["usage", replacement.accessToken],
  ]);
  assert.equal(samples.length, 2);
  assertNoSecrets([background, foreground, manager.snapshot(), samples]);
});

test("renewal refusal falls back only for a still-valid token with no pending attempt, and other errors never read quotas", async (t) => {
  const cases = [
    {
      name: "expired-token",
      expiresAt: NOW,
      pending: false,
      issue: "renewal-required",
    },
    {
      name: "pending-intent",
      expiresAt: NOW + 300_000,
      pending: true,
      issue: "renewal-required",
    },
    {
      name: "uncertain-exchange",
      expiresAt: NOW + 300_000,
      pending: false,
      issue: "expired",
    },
    {
      name: "read-denied",
      expiresAt: NOW + 300_000,
      pending: false,
      issue: "keychain-locked",
    },
    {
      name: "profile-error",
      expiresAt: NOW + 300_000,
      pending: false,
      issue: "identity-mismatch",
    },
  ] as const;
  for (const entry of cases) {
    await t.test(entry.name, async (t) => {
      const f = await fixture(t);
      let requests = 0,
        samples = 0,
        renewals = 0;
      const manager = new UsageManager(
        f.store,
        async () => ({ ...old, expiresAt: entry.expiresAt }),
        async () => {
          requests++;
          return limits;
        },
        () => NOW,
        () => {
          samples++;
        },
        async (_account, _credential, force, interaction) => {
          renewals++;
          assert.equal(force, false);
          assert.equal(interaction, false);
          throw new UsageError(entry.issue);
        },
        () => entry.pending,
      );
      const result = await manager.refresh(f.account.id);
      assert.equal(result.status, "error");
      assert.equal(result.issue, entry.issue);
      assert.equal(result.connectionRenewalRequired, undefined);
      assert.equal(result.checkedAt, undefined);
      assert.equal(result.fiveHour, undefined);
      assert.equal(requests, 0);
      assert.equal(samples, 0);
      assert.equal(renewals, 1);
      assertNoSecrets([result, manager.snapshot()]);
    });
  }
});

test("a 401 after background renewal refusal cannot publish fresh quotas or launch a second interactive command", async (t) => {
  const f = await fixture(t);
  const renewals: [boolean | undefined, boolean | undefined][] = [];
  const requests: [string, string][] = [];
  let samples = 0;
  const manager = new UsageManager(
    f.store,
    async () => old,
    async (endpoint, token) => {
      requests.push([endpoint, token]);
      throw new UsageError("expired");
    },
    () => NOW,
    () => {
      samples++;
    },
    async (_account, _credential, force, interaction) => {
      renewals.push([force, interaction]);
      throw new UsageError("renewal-required");
    },
  );
  const result = await manager.refresh(f.account.id);
  assert.equal(result.status, "error");
  assert.equal(result.issue, "renewal-required");
  assert.equal(result.connectionRenewalRequired, undefined);
  assert.equal(result.checkedAt, undefined);
  assert.equal(result.fiveHour, undefined);
  assert.equal(samples, 0);
  assert.deepEqual(requests, [["profile", old.accessToken]]);
  assert.deepEqual(renewals, [
    [false, false],
    [true, false],
  ]);
  assertNoSecrets([result, manager.snapshot()]);
});

test("explicit user renewal bypasses a local renewal-required backoff while background retries remain blocked", async (t) => {
  const f = await fixture(t);
  let reads = 0;
  const interactions: (boolean | undefined)[] = [];
  const manager = new UsageManager(
    f.store,
    async () => {
      reads++;
      return { ...old, expiresAt: NOW };
    },
    async (endpoint, token) => {
      assert.equal(token, replacement.accessToken);
      return endpoint === "profile" ? f.profile : limits;
    },
    () => NOW,
    undefined,
    async (_account, _credential, _force, interaction) => {
      interactions.push(interaction);
      if (!interaction) throw new UsageError("renewal-required");
      return replacement;
    },
  );
  const first = await manager.refresh(f.account.id);
  assert.equal(first.issue, "renewal-required");
  assert.equal((await manager.refresh(f.account.id)).issue, "renewal-required");
  assert.equal(reads, 1);
  const explicit = await manager.refresh(f.account.id, true);
  assert.equal(explicit.status, "ready");
  assert.equal(reads, 2);
  assert.deepEqual(interactions, [false, true]);
  assertNoSecrets([first, explicit, manager.snapshot()]);
});

test("an explicit renewal cannot bypass server Retry-After even when retained quotas have a connection-renewal flag", async (t) => {
  const f = await fixture(t);
  let now = NOW,
    reads = 0,
    renewals = 0,
    requests = 0;
  const retryAt = NOW + 600_000;
  const manager = new UsageManager(
    f.store,
    async () => {
      reads++;
      return old;
    },
    async (endpoint) => {
      requests++;
      if (now > NOW) throw new UsageError("rate-limited", retryAt);
      return endpoint === "profile" ? f.profile : limits;
    },
    () => now,
    undefined,
    async () => {
      renewals++;
      throw new UsageError("renewal-required");
    },
  );
  assert.equal(
    (await manager.refresh(f.account.id)).connectionRenewalRequired,
    true,
  );
  now += 60_001;
  const limited = await manager.refresh(f.account.id);
  assert.equal(limited.issue, "rate-limited");
  assert.equal(limited.retryAt, new Date(retryAt).toISOString());
  assert.equal(limited.connectionRenewalRequired, true);
  const counts = { reads, renewals, requests };
  const explicit = await manager.refresh(f.account.id, true);
  assert.deepEqual(explicit, limited);
  assert.deepEqual({ reads, renewals, requests }, counts);
  assertNoSecrets([limited, explicit, manager.snapshot()]);
});
