import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../electron/core/store";
import {
  runQuotaStarter,
  type QuotaStarterOptions,
} from "../electron/core/routine-runner";
import { planningAccount } from "./planning-fixtures";
const NOW = Date.parse("2026-10-13T06:00:00Z");
async function fixture(t: any) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-starter-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new Store(dir),
    account = planningAccount(randomUUID());
  account.auth!.accountUuid = randomUUID();
  account.auth!.orgId = randomUUID();
  store.update((state) => {
    state.accounts = [account];
    state.executable = process.execPath;
  });
  const profile = store.profile(account.id);
  await fs.mkdir(profile, { recursive: true });
  await fs.writeFile(
    path.join(profile, ".config.json"),
    JSON.stringify({
      oauthAccount: {
        accountUuid: account.auth!.accountUuid,
        organizationUuid: account.auth!.orgId,
        emailAddress: "fixture@example.test",
      },
    }),
  );
  const commands: { file: string; args: string[]; options: any }[] = [];
  let help =
    "--safe-mode --tools --strict-mcp-config --setting-sources --no-session-persistence --permission-prompts";
  let modelError: Error | undefined;
  let credentialCalls = 0,
    guard = true;
  const options: QuotaStarterOptions = {
    policyPaths: [],
    now: () => NOW,
    guard: async () => guard,
    execute: (async (file: string, args: string[], options: any) => {
      commands.push({ file, args, options });
      if (file === "/usr/bin/defaults")
        throw Object.assign(new Error("Fixture absent preferences"), {
          code: 1,
          stderr: "Domain com.anthropic.claudecode does not exist",
        });
      if (args[0] === "--help") return { stdout: help, stderr: "" };
      if (modelError) throw modelError;
      return {
        stdout: JSON.stringify({
          subtype: "success",
          result: "OK",
          is_error: false,
        }),
        stderr: "",
      };
    }) as NonNullable<QuotaStarterOptions["execute"]>,
  };
  const credentials = async (dir: string, prompt: boolean) => {
    credentialCalls++;
    assert.equal(dir, profile);
    assert.equal(prompt, false);
    return {
      accessToken: "fixture-only-token",
      expiresAt: NOW + 60_000,
      scopes: ["user:inference"],
    };
  };
  return {
    store,
    account,
    profile,
    commands,
    options,
    credentials,
    credentialCalls: () => credentialCalls,
    setHelp: (value: string) => {
      help = value;
    },
    setError: (value: Error) => {
      modelError = value;
    },
    setGuard: (value: boolean) => {
      guard = value;
    },
  };
}
test("starter fake process uses isolated temporary cwd, token environment only and removes cwd", async (t) => {
  const f = await fixture(t);
  await runQuotaStarter(f.store, f.account, f.credentials, f.options);
  const model = f.commands.find((c) => c.args[0] === "--print")!;
  assert.ok(model);
  assert.notEqual(model.options.cwd, f.profile);
  assert.notEqual(model.options.cwd, f.store.root);
  assert.ok(
    path.basename(model.options.cwd).startsWith("relay-quota-starter-"),
  );
  assert.equal(model.options.env.CLAUDE_CONFIG_DIR, f.profile);
  assert.equal(model.options.env.CLAUDE_CODE_OAUTH_TOKEN, "fixture-only-token");
  assert.ok(!model.args.some((arg) => arg.includes("fixture-only-token")));
  assert.equal(model.options.shell, false);
  assert.equal(f.credentialCalls(), 1);
  await assert.rejects(fs.stat(model.options.cwd));
});
test("unsupported CLI refuses before credentials and never attempts a model fallback", async (t) => {
  const f = await fixture(t);
  f.setHelp("--tools");
  await assert.rejects(
    runQuotaStarter(f.store, f.account, f.credentials, f.options),
    /routine-cli-unsupported/,
  );
  assert.equal(f.credentialCalls(), 0);
  assert.equal(
    f.commands.some((c) => c.args[0] === "--print"),
    false,
  );
});
test("Team, unknown and endpoint-managed policy refuse automatic execution", async (t) => {
  for (const mode of ["team", "unknown", "policy"] as const) {
    const f = await fixture(t);
    if (mode !== "policy") f.account.auth!.subscription = mode;
    else {
      const file = path.join(f.store.root, "fixture-policy.json");
      await fs.writeFile(file, "{}");
      f.options.policyPaths = [file];
    }
    await assert.rejects(
      runQuotaStarter(f.store, f.account, f.credentials, f.options),
      /routine-policy-unverified/,
    );
    assert.equal(f.commands.length, 0);
    assert.equal(f.credentialCalls(), 0);
  }
});
test("revoked settings before or during credential acquisition never send a prompt", async (t) => {
  for (const phase of ["before", "during"] as const) {
    const f = await fixture(t);
    if (phase === "before") f.setGuard(false);
    const credentials = async (dir: string, prompt: boolean) => {
      const credential = await f.credentials(dir, prompt);
      f.setGuard(false);
      return credential;
    };
    await assert.rejects(
      runQuotaStarter(f.store, f.account, credentials, f.options),
      /routine-settings-changed/,
    );
    assert.equal(
      f.commands.some((c) => c.args[0] === "--print"),
      false,
    );
  }
});
test("child process failures never expose credential or CLI output strings", async (t) => {
  const f = await fixture(t);
  f.setError(
    new Error("fake credential fixture-only-token and private output"),
  );
  await assert.rejects(
    runQuotaStarter(f.store, f.account, f.credentials, f.options),
    (error: Error) => {
      assert.equal(error.message, "routine-request-failed");
      assert.ok(!error.message.includes("fixture-only-token"));
      return true;
    },
  );
});
test("aborting Relay-owned routine startup never touches other process IDs", async (t) => {
  const f = await fixture(t),
    controller = new AbortController();
  f.options.signal = controller.signal;
  controller.abort();
  await assert.rejects(
    runQuotaStarter(f.store, f.account, f.credentials, f.options),
    /routine-settings-changed/,
  );
  assert.equal(f.commands.length, 0);
});
