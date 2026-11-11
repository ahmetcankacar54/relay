import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AuthManager, type AuthBrowser } from "../electron/core/auth";
import {
  localCallback,
  signInNavigationAllowed,
  signInPartition,
} from "../electron/core/auth-page-policy";
import type { AuthFlow } from "../shared/types";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean) {
  for (let n = 0; n < 200; n++) {
    if (fn()) return;
    await wait(25);
  }
  throw new Error("Timed out");
}
const handed =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=c&state=s&redirect_uri=http%3A%2F%2Flocalhost%3A65076%2Fcallback";
const printed =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=c&state=s&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback";

test("the sign-in window may visit Anthropic's sites, sign-in providers and the CLI's own callback only", () => {
  const callback = localCallback(handed);
  assert.equal(callback?.host, "localhost:65076");
  assert.equal(localCallback(printed), undefined);
  for (const ok of [
    "https://claude.ai/login",
    "https://claude.com/cai/oauth/authorize?x=1",
    "https://platform.claude.com/oauth/code/success",
    "https://www.anthropic.com/legal",
    "https://accounts.google.com/o/oauth2/auth",
    "http://localhost:65076/callback?code=abc",
  ])
    assert.equal(signInNavigationAllowed(ok, callback), true, ok);
  for (const no of [
    "https://claude.ai.evil.test/",
    "https://evil.test/?claude.ai",
    "http://claude.ai/login",
    "http://localhost:65077/callback",
    "http://localhost:65076/other",
    "https://user:pw@claude.ai/",
    "file:///etc/passwd",
  ])
    assert.equal(signInNavigationAllowed(no, callback), false, no);
  assert.equal(signInNavigationAllowed("http://localhost:65076/callback"), false);
  assert.equal(signInPartition("abc"), "persist:relay-auth-abc");
});

async function fixture(
  t: any,
  body: string,
  handOff: boolean,
  open?: (url: string) => Promise<void>,
  verify: () => Promise<boolean | string> = async () => true,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-auth-window-"));
  const file = path.join(root, "cli");
  await fs.writeFile(file, `#!${process.execPath}\n${body}`, { mode: 0o700 });
  const events: AuthFlow[] = [];
  const shown: [string, string][] = [];
  const closed: string[] = [];
  const opened: string[] = [];
  const auth = new AuthManager(
    verify,
    (f) => events.push(f),
    open ?? (async (u) => void opened.push(u)),
    15_000,
  );
  const pages = new Map<string, string>();
  const browser: AuthBrowser = {
    env: (attempt) => ({ RELAY_TEST_PAGE: path.join(root, `${attempt}.url`), RELAY_TEST_HAND: handOff ? "1" : "" }),
    take: async (attempt) => {
      try {
        const url = await fs.readFile(path.join(root, `${attempt}.url`), "utf8");
        await fs.rm(path.join(root, `${attempt}.url`));
        pages.set(attempt, url);
        return url;
      } catch {
        return undefined;
      }
    },
    show: (account, url) => void shown.push([account, url]),
    close: (account) => void closed.push(account),
  };
  auth.browser = browser;
  t.after(async () => {
    await auth.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });
  const id = randomUUID();
  const flow = auth.start(id, file, root, { ...process.env } as Record<string, string>);
  return { auth, events, shown, closed, opened, id, flow };
}

// The CLI stand-in is a shebang script, which Windows cannot run, as in auth.test.ts.
// A CLI that prints the paste-code page, hands the localhost page to BROWSER, then waits for "approval".
const cli = `
const fs = require("fs");
console.log("Opening browser to sign in…");
console.log("If the browser didn't open, visit: ${printed}");
if (process.env.RELAY_TEST_HAND) fs.writeFileSync(process.env.RELAY_TEST_PAGE, "${handed}");
setTimeout(() => process.exit(0), 900);
`;

test("the page the CLI hands to BROWSER opens in the system browser; Relay's window is the other way in", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t, cli, true);
  await until(() => f.opened.length === 1);
  // The localhost page, not the paste-a-code one the CLI printed, and no window of Relay's.
  assert.deepEqual(f.opened, [handed]);
  assert.deepEqual(f.shown, []);
  const waiting = f.events.find((e) => e.status === "waiting");
  assert.ok(waiting?.browserReady && waiting.windowAvailable && !waiting.inWindow);
  // "Reopen browser" opens the same page again.
  await f.auth.reopen(f.id, f.flow.id, "browser");
  assert.deepEqual(f.opened, [handed, handed]);
  // "Open in Relay window": the flow now owns that window and closes it when the sign-in ends.
  await f.auth.reopen(f.id, f.flow.id, "window");
  assert.deepEqual(f.shown, [[f.id, handed]]);
  assert.equal(f.events.at(-1)?.inWindow, true);
  await until(() => f.events.at(-1)?.status === "connected");
  assert.deepEqual(f.closed, [f.id]);
});

test("a sign-in approved in the system browser never opens or closes Relay's window", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t, cli, true);
  await until(() => f.events.at(-1)?.status === "connected");
  assert.deepEqual(f.opened, [handed]);
  assert.deepEqual(f.shown, []);
  assert.deepEqual(f.closed, []);
});

test("a system browser that cannot be opened leaves Relay's window", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t, cli, true, async () => {
    throw new Error("no browser");
  });
  await until(() => f.shown.length === 1);
  assert.deepEqual(f.shown, [[f.id, handed]]);
  assert.ok(f.events.some((e) => e.status === "waiting" && e.inWindow));
});

test("a CLI that hands nothing over gets its printed page opened after a few seconds", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t, cli.replace("setTimeout(() => process.exit(0), 900)", "setTimeout(() => process.exit(0), 7000)"), false);
  await wait(1500);
  assert.equal(f.opened.length, 0);
  await until(() => f.opened.length === 1);
  assert.deepEqual(f.opened, [printed]);
  assert.deepEqual(f.shown, []);
});

test("a sign-in that does not fit the profile fails with the reason verification gives", { skip: process.platform === "win32" }, async (t) => {
  const reason = "Tarayıcıda başka bir Claude hesabıyla giriş yapıldı.";
  const f = await fixture(t, cli, true, undefined, async () => reason);
  await until(() => f.events.at(-1)?.status === "failed");
  assert.equal(f.events.at(-1)?.error, reason);
});
