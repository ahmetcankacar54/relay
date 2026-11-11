import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AuthManager, authorizationURL } from "../electron/core/auth";
import type { AuthFlow } from "../shared/types";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Generous: a spawned CLI can take seconds to start while the whole suite runs in parallel.
async function until(fn: () => boolean) {
  for (let n = 0; n < 500; n++) {
    if (fn()) return;
    await wait(20);
  }
  throw new Error("Timed out");
}
async function fixture(
  t: any,
  body: string,
  verify = async () => true,
  timeout = 15_000,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-auth-"));
  const file = path.join(root, "cli");
  await fs.writeFile(file, `#!${process.execPath}\n${body}`, { mode: 0o700 });
  const events: AuthFlow[] = [];
  const opened: string[] = [];
  const auth = new AuthManager(
    verify,
    (f) => events.push(f),
    async (url) => {
      opened.push(url);
    },
    timeout,
  );
  t.after(async () => {
    await auth.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });
  const start = (id: string = randomUUID()) =>
    auth.start(id, file, root, { ...process.env } as Record<string, string>);
  return { root, auth, events, opened, start };
}
const url =
  "https://claude.ai/oauth/authorize?client_id=fixture&state=private-state&redirect_uri=http%3A%2F%2Flocalhost%3A9999";

test("OAuth links accept only exact official HTTPS authorization origins", () => {
  assert.equal(authorizationURL(url), url);
  const current = url.replace("claude.ai/oauth", "claude.com/cai/oauth");
  assert.equal(authorizationURL(current), current);
  for (const invalid of [
    url.replace("claude.ai", "claude.ai.evil.test"),
    url.replace("https", "http"),
    url.replace("claude.ai", "user:secret@claude.ai"),
    url.replace("claude.ai", "claude.ai:444"),
    url.replace("/oauth/authorize", "/arbitrary"),
    "https://claude.ai/oauth/authorize?client_id=x",
  ])
    assert.equal(authorizationURL(invalid), undefined);
});
test(
  "hidden sign-in is idempotent, handles split URLs, reopens, verifies without renderer, and exposes no secrets",
  { skip: process.platform === "win32" },
  async (t) => {
    let verified = 0;
    const f = await fixture(
      t,
      `process.stdout.write(${JSON.stringify(url.slice(0, 45))}); setTimeout(()=>process.stdout.write(${JSON.stringify(url.slice(45) + "\nPaste code here if prompted:\n")}),40); process.stdin.once('data',()=>{console.log('Login successful'); process.exit(0)});`,
      async () => {
        verified++;
        return true;
      },
    );
    const flow = f.start();
    assert.equal(f.start(flow.accountId).id, flow.id);
    await until(() => f.auth.list()[0].browserReady);
    assert.equal(f.auth.list()[0].codeRequested, true);
    await f.auth.reopen(flow.accountId, flow.id);
    assert.deepEqual(f.opened, [url]);
    assert.throws(() =>
      f.auth.submitCode(flow.accountId, flow.id, "code\ncommand"),
    );
    f.auth.submitCode(flow.accountId, flow.id, "private-code");
    await until(() => f.auth.list()[0].status === "connected");
    assert.equal(verified, 1);
    assert(!JSON.stringify(f.events).includes("private-state"));
    assert(!JSON.stringify(f.events).includes("private-code"));
    await assert.rejects(f.auth.reopen(flow.accountId, flow.id));
  },
);
test(
  "failed login cannot be reported as connected by a previously valid account",
  { skip: process.platform === "win32" },
  async (t) => {
    let reads = 0;
    const f = await fixture(t, "process.exit(1)", async () => {
      reads++;
      return true;
    });
    f.start();
    await until(() => f.auth.list()[0].status === "failed");
    assert.equal(reads, 0);
  },
);
test(
  "cancel disposes child; retry rejects stale callbacks and attempts stay independent",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(
      t,
      `console.log(${JSON.stringify(url)}); setInterval(()=>{},1000)`,
    );
    const a = f.start(),
      b = f.start();
    await until(() => f.auth.list().every((f) => f.browserReady));
    await f.auth.cancel(a.accountId, a.id);
    assert.equal(f.auth.list().find((x) => x.id === b.id)!.status, "waiting");
    const retry = f.start(a.accountId);
    assert.notEqual(a.id, retry.id);
    await assert.rejects(f.auth.reopen(a.accountId, a.id), /artık geçerli/);
    assert.equal(f.auth.list().length, 2);
  },
);
test(
  "timeout and missing executable produce terminal failure states",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t, "setInterval(()=>{},1000)", undefined, 100);
    f.start();
    await until(() => f.auth.list()[0].status === "failed");
    assert.equal(f.auth.active(f.auth.list()[0].accountId), false);
    const id = randomUUID();
    f.auth.start(id, path.join(f.root, "missing"), f.root, {});
    await until(
      () => f.auth.list().find((f) => f.accountId === id)?.status === "failed",
    );
  },
);
test(
  "cancelling during verification cannot resurrect a completed attempt",
  { skip: process.platform === "win32" },
  async (t) => {
    let finish!: (v: boolean) => void;
    const f = await fixture(
      t,
      "process.exit(0)",
      () =>
        new Promise<boolean>((r) => {
          finish = r;
        }),
    );
    const flow = f.start();
    await until(() => f.auth.list()[0].status === "verifying");
    await f.auth.cancel(flow.accountId, flow.id);
    finish(true);
    await wait(30);
    assert.equal(f.auth.list()[0].status, "cancelled");
  },
);
