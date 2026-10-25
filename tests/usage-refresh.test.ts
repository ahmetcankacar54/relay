import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import type { Account } from "../shared/types";
import {
  parseCredential,
  type UsageCredential,
} from "../electron/core/usage-credentials";
import {
  anthropicUnreachable,
  needsUsageCredentialRefresh,
  UsageCredentialRefresher,
  USAGE_REFRESH_MAX_ATTEMPTS,
  USAGE_REFRESH_OFFLINE_RETRY_MS,
  USAGE_REFRESH_RETRY_MS,
  type UsageRefreshCommand,
} from "../electron/core/usage-refresh";

const now = Date.parse("2026-10-13T18:00:00Z");
async function fixture(t: any) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "relay-refresh-"));
  const profile = await fs.realpath(temporary);
  t.after(() => fs.rm(profile, { recursive: true, force: true }));
  const account: Account = {
    id: randomUUID(),
    name: "Fixture",
    kind: "personal",
    group: "personal",
    color: "blue",
    createdAt: new Date(now).toISOString(),
    auth: {
      loggedIn: true,
      checkedAt: new Date(now).toISOString(),
      accountUuid: randomUUID(),
      orgId: randomUUID(),
      email: "a@example.test",
    },
  };
  const old: UsageCredential = {
    accessToken: "fixture-old-access",
    refreshToken: "fixture-old-refresh",
    expiresAt: now - 1,
    scopes: ["user:profile", "user:inference", "user:sessions:claude_code"],
    clientId: "fixture-client",
  };
  const replacement: UsageCredential = {
    ...old,
    accessToken: "fixture-new-access",
    refreshToken: "fixture-new-refresh",
    expiresAt: now + 3_600_000,
  };
  let saved = old;
  const calls: UsageRefreshCommand[] = [];
  let run: (command: UsageRefreshCommand) => Promise<void> = async () => {
    saved = replacement;
  };
  let serverProfile: unknown = {
    account: {
      uuid: account.auth!.accountUuid,
      email_address: account.auth!.email,
    },
    organization: { uuid: account.auth!.orgId },
  };
  let allowed = true;
  const requests: string[] = [];
  const deps = {
    executable: async () => path.join(profile, "fake-claude"),
    read: async (directory: string, prompt: boolean) => {
      assert.equal(directory, profile);
      assert.equal(prompt, false);
      return saved;
    },
    run: async (command: UsageRefreshCommand) => {
      calls.push(command);
      await run(command);
    },
    request: async (endpoint: "profile" | "usage", token: string) => {
      requests.push(endpoint);
      assert.equal(token, saved.accessToken);
      return serverProfile;
    },
    canProceed: () => allowed,
    now: () => now,
    platform: "linux" as const,
    environment: {
      ANTHROPIC_API_KEY: "foreign-secret",
      CLAUDE_CONFIG_DIR: "/foreign",
      CLAUDE_CODE_OAUTH_TOKEN: "foreign-access",
      CLAUDECODE: "nested",
      ELECTRON_RUN_AS_NODE: "1",
      NODE_OPTIONS: "--require foreign",
      PATH: "/fixture/bin",
    },
  };
  return {
    profile,
    account,
    old,
    replacement,
    calls,
    requests,
    deps,
    save: (value: UsageCredential) => {
      saved = value;
    },
    run: (value: typeof run) => {
      run = value;
    },
    server: (value: unknown) => {
      serverProfile = value;
    },
    allow: (value: boolean) => {
      allowed = value;
    },
    refresher: new UsageCredentialRefresher(deps),
  };
}

test("refresh token parser retains bounded main-process refresh fields and excludes malformed values", () => {
  const base = { accessToken: "fixture", scopes: ["user:profile"] };
  const value = parseCredential(
    JSON.stringify({
      claudeAiOauth: {
        ...base,
        refreshToken: "refresh",
        refreshTokenExpiresAt: now,
        clientId: "client",
        secret: "do-not-return",
      },
    }),
  );
  assert.equal(value.refreshToken, "refresh");
  assert.equal(value.clientId, "client");
  assert.equal(value.refreshTokenExpiresAt, now);
  assert.equal("secret" in value, false);
  for (const refreshToken of ["bad\nvalue", "x".repeat(16_385), 123])
    assert.equal(
      parseCredential(
        JSON.stringify({ claudeAiOauth: { ...base, refreshToken } }),
      ).refreshToken,
      undefined,
    );
  assert.throws(() =>
    parseCredential(
      JSON.stringify({ claudeAiOauth: { ...base, accessToken: "bad\0value" } }),
    ),
  );
  assert.throws(() =>
    parseCredential(
      '{"claudeAiOauth":{"accessToken":"fixture","expiresAt":1e999,"scopes":[]}}',
    ),
  );
});
test("credential refresh runs five minutes before expiry and does not invent expiry for unknown tokens", () => {
  assert.equal(
    needsUsageCredentialRefresh(
      { accessToken: "x", scopes: [], expiresAt: now + 300_000 },
      now,
    ),
    true,
  );
  assert.equal(
    needsUsageCredentialRefresh(
      { accessToken: "x", scopes: [], expiresAt: now + 300_001 },
      now,
    ),
    false,
  );
  assert.equal(
    needsUsageCredentialRefresh({ accessToken: "x", scopes: [] }, now),
    false,
  );
});
test("supported refresh exchanges once in an isolated hidden auth command, preserves scopes and verifies server identity", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(
    await f.refresher.refresh(f.account, f.profile, f.old),
    f.replacement,
  );
  assert.equal(f.calls.length, 1);
  const c = f.calls[0];
  assert.deepEqual(c.args, [
    "--safe-mode",
    "--settings",
    '{"disableAllHooks":true}',
    "auth",
    "login",
    "--claudeai",
  ]);
  assert.equal(c.cwd, f.profile);
  assert.equal(c.env.CLAUDE_CONFIG_DIR, f.profile);
  assert.equal(c.env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN, f.old.refreshToken);
  assert.equal(c.env.CLAUDE_CODE_OAUTH_SCOPES, f.old.scopes.join(" "));
  assert.equal(c.env.CLAUDE_CODE_OAUTH_TOKEN, f.old.accessToken);
  assert.equal(c.env.CLAUDE_CODE_OAUTH_CLIENT_ID, f.old.clientId);
  for (const key of [
    "ANTHROPIC_API_KEY",
    "CLAUDECODE",
    "ELECTRON_RUN_AS_NODE",
    "NODE_OPTIONS",
  ])
    assert.equal(c.env[key], undefined);
  assert.deepEqual(f.requests, ["profile"]);
  assert.equal(f.refresher.anyActive, false);
  assert.deepEqual(await fs.readdir(f.profile), []);
});
test("simultaneous refreshes and separate refresher instances share one profile exchange", async (t) => {
  const f = await fixture(t);
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.run(async () => {
    await wait;
    f.save(f.replacement);
  });
  const first = f.refresher.refresh(f.account, f.profile, f.old);
  const other = new UsageCredentialRefresher(f.deps);
  assert.equal(f.refresher.anyActive, true);
  assert.equal(other.isRefreshing(f.account.id), true);
  assert.equal(other.isRefreshing(f.profile), true);
  const second = other.refresh(f.account, f.profile, f.old);
  assert.equal(first, second);
  await assert.rejects(
    other.refresh(
      { ...f.account, auth: { ...f.account.auth!, orgId: randomUUID() } },
      f.profile,
      f.old,
    ),
    /identity-mismatch/,
  );
  release();
  await Promise.all([first, second]);
  assert.equal(f.calls.length, 1);
});
test("timeout or uncertain rotation persists a nonsecret barrier across app restart and never exchanges the same pair twice", async (t) => {
  const f = await fixture(t);
  f.run(async () => {
    throw new Error("timeout fixture-secret-must-not-propagate");
  });
  await assert.rejects(
    f.refresher.refresh(f.account, f.profile, f.old),
    /expired/,
  );
  const journal = await fs.readFile(
    path.join(f.profile, ".relay-usage-refresh.json"),
    "utf8",
  );
  assert.equal(journal.includes("fixture-old-access"), false);
  assert.equal(journal.includes("fixture-old-refresh"), false);
  const restarted = new UsageCredentialRefresher(f.deps);
  await assert.rejects(
    restarted.refresh(f.account, f.profile, f.old),
    /expired/,
  );
  assert.equal(f.calls.length, 1);
  f.save(f.replacement);
  assert.deepEqual(
    await restarted.refresh(f.account, f.profile, f.replacement),
    f.replacement,
  );
  assert.equal(f.calls.length, 1);
  assert.deepEqual(await fs.readdir(f.profile), []);
});
test("a command error after saved replacement is reconciled without a second exchange", async (t) => {
  const f = await fixture(t);
  f.run(async () => {
    f.save(f.replacement);
    throw new Error("post-save exit");
  });
  assert.deepEqual(
    await f.refresher.refresh(f.account, f.profile, f.old),
    f.replacement,
  );
  assert.equal(f.calls.length, 1);
});
test("successful CLI exit without persisted replacement never becomes fresh usage", async (t) => {
  const f = await fixture(t);
  f.run(async () => {});
  await assert.rejects(
    f.refresher.refresh(f.account, f.profile, f.old),
    /expired/,
  );
  assert.deepEqual(f.requests, []);
  await assert.rejects(
    f.refresher.refresh(f.account, f.profile, f.old),
    /expired/,
  );
  assert.equal(f.calls.length, 1);
});
test("saved credentials from a different account or organization fail identity verification and retain the attempt", async (t) => {
  for (const kind of ["account", "organization"]) {
    const f = await fixture(t);
    f.server({
      account: {
        uuid: kind === "account" ? randomUUID() : f.account.auth!.accountUuid,
        email_address: f.account.auth!.email,
      },
      organization: {
        uuid: kind === "organization" ? randomUUID() : f.account.auth!.orgId,
      },
    });
    await assert.rejects(
      f.refresher.refresh(f.account, f.profile, f.old),
      /identity-mismatch/,
    );
    assert.ok(await fs.stat(path.join(f.profile, ".relay-usage-refresh.json")));
    assert.equal(f.calls.length, 1);
  }
});
test("existing official refresh lock, denied profile guard and inference-less credentials block before any exchange", async (t) => {
  const f = await fixture(t);
  const lock = path.join(f.profile, ".oauth_refresh.lock");
  await fs.mkdir(lock);
  await assert.rejects(
    f.refresher.refresh(f.account, f.profile, f.old),
    /unavailable/,
  );
  assert.ok((await fs.stat(lock)).isDirectory());
  assert.equal(f.calls.length, 0);
  await fs.rmdir(lock);
  f.allow(false);
  await assert.rejects(
    f.refresher.refresh(f.account, f.profile, f.old),
    /unavailable/,
  );
  assert.equal(f.calls.length, 0);
  f.allow(true);
  f.save({ ...f.old, scopes: ["user:profile"] });
  await assert.rejects(
    f.refresher.refresh(f.account, f.profile, {
      ...f.old,
      scopes: ["user:profile"],
    }),
    /expired/,
  );
  assert.equal(f.calls.length, 0);
});
test("missing/expired refresh token and unknown enrolled identity require browser reconnection", async (t) => {
  for (const missing of [true, false]) {
    const f = await fixture(t);
    const credential = missing
      ? { ...f.old, refreshToken: undefined }
      : { ...f.old, refreshTokenExpiresAt: now - 1 };
    f.save(credential);
    await assert.rejects(
      f.refresher.refresh(f.account, f.profile, credential),
      /expired/,
    );
    assert.equal(f.calls.length, 0);
  }
  const f = await fixture(t);
  await assert.rejects(
    f.refresher.refresh(
      { ...f.account, auth: { ...f.account.auth!, accountUuid: undefined } },
      f.profile,
      f.old,
    ),
    /identity-mismatch/,
  );
  assert.equal(f.calls.length, 0);
});
test("server 401 can force refresh before local expiry, while an already replaced fresh pair skips exchange", async (t) => {
  const f = await fixture(t);
  const stillValid = { ...f.old, expiresAt: now + 3_600_000 };
  f.save(stillValid);
  assert.deepEqual(
    await f.refresher.refresh(f.account, f.profile, stillValid, true),
    f.replacement,
  );
  assert.equal(f.calls.length, 1);
  const g = await fixture(t);
  g.save(g.replacement);
  assert.deepEqual(
    await g.refresher.refresh(g.account, g.profile, g.old),
    g.replacement,
  );
  assert.equal(g.calls.length, 0);
});
test("dropped credential scopes or corrupt uncertainty journal cannot silently restart rotation", async (t) => {
  const f = await fixture(t);
  f.run(async () => {
    f.save({ ...f.replacement, scopes: ["user:profile"] });
  });
  await assert.rejects(
    f.refresher.refresh(f.account, f.profile, f.old),
    /scope/,
  );
  assert.ok(await fs.stat(path.join(f.profile, ".relay-usage-refresh.json")));
  await assert.rejects(
    f.refresher.refresh(f.account, f.profile, {
      ...f.replacement,
      scopes: ["user:profile"],
    }),
    /scope/,
  );
  assert.equal(f.calls.length, 1);
  const g = await fixture(t);
  await fs.writeFile(
    path.join(g.profile, ".relay-usage-refresh.json"),
    "{broken",
  );
  await assert.rejects(
    g.refresher.refresh(g.account, g.profile, g.old),
    /expired/,
  );
  assert.equal(g.calls.length, 0);
});
test("symlinked profiles, global default profile and symlinked journals are refused", async (t) => {
  const f = await fixture(t);
  const alias = path.join(f.profile, "alias");
  await fs.symlink(f.profile, alias);
  await assert.rejects(
    f.refresher.refresh(f.account, alias, f.old),
    /credentials-missing/,
  );
  await assert.rejects(
    f.refresher.refresh(f.account, "relative-profile", f.old),
    /credentials-missing/,
  );
  await assert.rejects(
    f.refresher.refresh(f.account, path.join(os.homedir(), ".claude"), f.old),
    /credentials-missing/,
  );
  await fs.writeFile(path.join(f.profile, "other"), "{}");
  await fs.symlink(
    path.join(f.profile, "other"),
    path.join(f.profile, ".relay-usage-refresh.json"),
  );
  await assert.rejects(
    f.refresher.refresh(f.account, f.profile, f.old),
    /expired/,
  );
  assert.equal(f.calls.length, 0);
});
test("lost official lock ownership preserves the rotation barrier and never removes the replacement lock", async (t) => {
  const f = await fixture(t);
  const vendorLock = path.join(f.profile, ".oauth_refresh.lock");
  f.run(async () => {
    f.save(f.replacement);
    await fs.rename(vendorLock, path.join(f.profile, "old-vendor-lock"));
    await fs.mkdir(vendorLock);
  });
  await assert.rejects(
    f.refresher.refresh(f.account, f.profile, f.old),
    /expired/,
  );
  assert.ok((await fs.stat(vendorLock)).isDirectory());
  assert.ok(await fs.stat(path.join(f.profile, ".relay-usage-refresh.json")));
  assert.equal(f.calls.length, 1);
});
test("a credential replaced by another process before acquiring the vendor lock is re-read and never rotated again", async (t) => {
  const f = await fixture(t);
  let checks = 0;
  const deps = {
    ...f.deps,
    canProceed: () => {
      if (++checks === 3) f.save(f.replacement);
      return true;
    },
  };
  const refresher = new UsageCredentialRefresher(deps);
  assert.deepEqual(
    await refresher.refresh(f.account, f.profile, f.old),
    f.replacement,
  );
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.requests, ["profile"]);
});
test("a concurrent replacement cannot drop requested scopes before the vendor lock is acquired", async (t) => {
  const f = await fixture(t);
  let checks = 0;
  const deps = {
    ...f.deps,
    canProceed: () => {
      if (++checks === 3)
        f.save({ ...f.replacement, scopes: ["user:profile"] });
      return true;
    },
  };
  await assert.rejects(
    new UsageCredentialRefresher(deps).refresh(f.account, f.profile, f.old),
    /scope/,
  );
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.requests, []);
});
test("a saved replacement whose identity proof failed transiently reconciles while fresh without another exchange", async (t) => {
  const f = await fixture(t);
  let proofFails = true;
  const deps = {
    ...f.deps,
    request: async (endpoint: "profile" | "usage", token: string) => {
      if (proofFails) throw new Error("temporary network failure");
      return f.deps.request(endpoint, token);
    },
  };
  const refresher = new UsageCredentialRefresher(deps);
  await assert.rejects(
    refresher.refresh(f.account, f.profile, f.old),
    /temporary network failure/,
  );
  assert.equal(refresher.hasPending(f.profile), true);
  proofFails = false;
  assert.deepEqual(
    await refresher.refresh(f.account, f.profile, f.replacement),
    f.replacement,
  );
  assert.equal(refresher.hasPending(f.profile), false);
  assert.equal(f.calls.length, 1);
});
test("macOS background renewal runs one isolated exchange like other platforms", async (t) => {
  const f = await fixture(t);
  const refresher = new UsageCredentialRefresher({
    ...f.deps,
    platform: "darwin",
  });
  assert.deepEqual(
    await refresher.refresh(f.account, f.profile, f.old),
    f.replacement,
  );
  assert.equal(f.calls.length, 1);
  assert.equal(refresher.hasPending(f.profile), false);
});
test("an unconfirmed exchange is retried after a delay or on request, then requires reconnecting", async (t) => {
  const f = await fixture(t);
  let clock = now;
  const refresher = new UsageCredentialRefresher({
    ...f.deps,
    now: () => clock,
  });
  f.run(async () => {
    throw new Error("network");
  });
  await assert.rejects(
    refresher.refresh(f.account, f.profile, f.old),
    /expired/,
  );
  assert.equal(f.calls.length, 1);
  assert.equal(refresher.hasPending(f.profile), true);
  // The unchanged pair is not exchanged again in the background right away.
  await assert.rejects(
    refresher.refresh(f.account, f.profile, f.old),
    /expired/,
  );
  assert.equal(f.calls.length, 1);
  // An explicit renewal may retry immediately.
  await assert.rejects(
    refresher.refresh(f.account, f.profile, f.old, false, true),
    /expired/,
  );
  assert.equal(f.calls.length, 2);
  // After the delay, a background read retries once more and then stops.
  clock += USAGE_REFRESH_RETRY_MS;
  await assert.rejects(
    refresher.refresh(f.account, f.profile, f.old),
    /expired/,
  );
  assert.equal(f.calls.length, USAGE_REFRESH_MAX_ATTEMPTS);
  clock += USAGE_REFRESH_RETRY_MS;
  await assert.rejects(
    refresher.refresh(f.account, f.profile, f.old, false, true),
    /expired/,
  );
  assert.equal(f.calls.length, USAGE_REFRESH_MAX_ATTEMPTS);
  // A browser reconnect saves a new pair, which reconciles the barrier.
  const reconnected = { ...f.replacement, expiresAt: clock + 3_600_000 };
  f.save(reconnected);
  assert.deepEqual(
    await refresher.refresh(f.account, f.profile, f.old),
    reconnected,
  );
  assert.equal(refresher.hasPending(f.profile), false);
});
test("macOS background pending reconciliation verifies an already saved replacement without interactive permission or exchange", async (t) => {
  const f = await fixture(t);
  const refresher = new UsageCredentialRefresher({
    ...f.deps,
    platform: "darwin",
  });
  f.run(async () => {
    throw new Error("uncertain fixture");
  });
  await assert.rejects(
    refresher.refresh(f.account, f.profile, f.old, false, true),
    /expired/,
  );
  assert.equal(refresher.hasPending(f.profile), true);
  f.save(f.replacement);
  assert.deepEqual(
    await refresher.refresh(f.account, f.profile, f.replacement),
    f.replacement,
  );
  assert.equal(f.calls.length, 1);
  assert.equal(refresher.hasPending(f.profile), false);
  assert.deepEqual(f.requests, ["profile"]);
});

test("a renewal that falls on a dropped network waits two minutes, counts nothing and asks for no sign-in", async (t) => {
  const f = await fixture(t);
  let clock = now;
  let offline = true;
  const refresher = new UsageCredentialRefresher({
    ...f.deps,
    now: () => clock,
    unreachable: async () => offline,
  });
  f.run(async () => {
    throw new Error("network");
  });
  // No answer from Anthropic: transient, retried soon.
  await assert.rejects(refresher.refresh(f.account, f.profile, f.old), (e: any) => {
    assert.equal(e.issue, "unavailable");
    assert.equal(e.retryAt, clock + USAGE_REFRESH_OFFLINE_RETRY_MS);
    assert.equal(e.detail, "refresh: no network");
    return true;
  });
  assert.equal(f.calls.length, 1);
  // Within the two minutes a background read neither exchanges nor asks for a sign-in.
  clock += USAGE_REFRESH_OFFLINE_RETRY_MS - 1;
  await assert.rejects(refresher.refresh(f.account, f.profile, f.old), /unavailable/);
  assert.equal(f.calls.length, 1);
  // Many offline tries never use up the attempts a real refusal gets.
  for (let i = 0; i < USAGE_REFRESH_MAX_ATTEMPTS + 1; i++) {
    clock += USAGE_REFRESH_OFFLINE_RETRY_MS;
    await assert.rejects(refresher.refresh(f.account, f.profile, f.old), /unavailable/);
  }
  assert.equal(f.calls.length, USAGE_REFRESH_MAX_ATTEMPTS + 2);
  // Back online, the next exchange renews the sign-in.
  offline = false;
  clock += USAGE_REFRESH_OFFLINE_RETRY_MS;
  const renewed = { ...f.replacement, expiresAt: clock + 3_600_000 };
  f.run(async () => {
    f.save(renewed);
  });
  assert.deepEqual(await refresher.refresh(f.account, f.profile, f.old), renewed);
  assert.equal(refresher.hasPending(f.profile), false);
});

test("a renewal Anthropic answered but saved nothing for still counts and waits half an hour", async (t) => {
  const f = await fixture(t);
  const refresher = new UsageCredentialRefresher({
    ...f.deps,
    unreachable: async () => false,
  });
  f.run(async () => {
    throw new Error("refused");
  });
  await assert.rejects(refresher.refresh(f.account, f.profile, f.old), (e: any) => {
    assert.equal(e.issue, "expired");
    assert.equal(e.detail, "refresh: no new sign-in saved");
    return true;
  });
  await assert.rejects(refresher.refresh(f.account, f.profile, f.old), /expired/);
  assert.equal(f.calls.length, 1);
});

test("Anthropic is unreachable only when a request gets no answer at all", async () => {
  const answer = async () => new Response(null, { status: 404 });
  assert.equal(await anthropicUnreachable(answer as typeof fetch), false);
  const refused = async () => new Response(null, { status: 403 });
  assert.equal(await anthropicUnreachable(refused as typeof fetch), false);
  const offline = async () => {
    throw new TypeError("fetch failed");
  };
  assert.equal(await anthropicUnreachable(offline as typeof fetch), true);
  const slow = async () => {
    throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
  };
  assert.equal(await anthropicUnreachable(slow as typeof fetch), true);
  const other = async () => {
    throw new Error("something else");
  };
  assert.equal(await anthropicUnreachable(other as typeof fetch), false);
});
