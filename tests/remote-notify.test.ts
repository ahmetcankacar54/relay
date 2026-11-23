import test from "node:test";
import assert from "node:assert/strict";
import {
  RemoteNotifier,
  ntfyRequest,
  postRemoteNotice,
  webhookPayload,
  type RemoteDeps,
  type RemoteNotice,
} from "../electron/core/remote-notify";
import { remoteNotifySettings, remoteNotifyUrl } from "../shared/remote-notify";
import { settingsPatchSchema } from "../electron/core/store";
import { DEFAULT_SETTINGS } from "../shared/types";

const NOW = Date.parse("2026-10-13T06:00:00Z");
const TOKEN = "sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdef";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbHRvQGV4YW1wbGUuY29tIn0.c2lnbmF0dXJlLXNpZ25hdHVyZQ";
const EMAIL = "alto@example.com";
const ACCOUNT_ID = "3f2c8a51-7d4e-4b1a-9c6f-0e8d2b7a4c19";
const ORG_ID = "9b1e7c42-5a3d-4f8e-b2c6-1d0a9e8f7b35";

/** An event whose every text field carries a planted secret, as a careless caller might pass it. */
const leaky: RemoteNotice = {
  event: "limit-near",
  accountName: EMAIL,
  window: "five_hour",
  usedPercent: 91.7,
  resetsAt: new Date(NOW + 3_600_000).toISOString(),
  title: `${EMAIL} is at 91% ${TOKEN}`,
  message: `org ${ORG_ID} account ${ACCOUNT_ID} bearer ${JWT}`,
};
const secrets = [TOKEN, JWT, EMAIL, ACCOUNT_ID, ORG_ID, "sk-ant", "example.com"];

/** A fetch that records each call and answers from `answers` in turn. */
function recorder(answers: (number | Error | "hang")[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: URL, init: RequestInit) => {
    calls.push({ url: String(url), init });
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (answer === "hang")
      return new Promise((_, reject) =>
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason)),
      );
    if (answer instanceof Error) throw answer;
    return new Response(answer === 204 ? null : `echo ${String(url)}`, { status: answer });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}
function deps(fetch: typeof globalThis.fetch, logs: string[] = [], sleeps: number[] = []): RemoteDeps {
  return {
    version: () => "0.29.0",
    fetch,
    now: () => NOW,
    log: (line) => logs.push(line),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    timeoutMs: 20,
    retryMs: 1_234,
  };
}

test("only https, or http to this computer, without a user name or password, is a target", () => {
  for (const ok of [
    "https://ntfy.sh/relay-alto",
    "https://example.com/hooks/relay?x=1",
    "http://localhost:8080/relay",
    "http://127.0.0.1/relay",
    "http://[::1]:2586/relay",
    "  https://ntfy.sh/relay  ",
  ])
    assert.ok(remoteNotifyUrl(ok), ok);
  for (const bad of [
    "",
    "ntfy.sh/relay",
    "http://example.com/relay",
    "http://192.168.1.10/relay",
    "ftp://example.com/relay",
    "javascript:alert(1)",
    "https://user:secret@example.com/hook",
    `https://example.com/${"a".repeat(2_000)}`,
  ])
    assert.equal(remoteNotifyUrl(bad), undefined, bad);
  // The saved settings refuse the same URLs; without one the group is off.
  const events = { limit: true, reset: false, autoSwitch: true, signIn: true };
  assert.ok(settingsPatchSchema.parse({ remoteNotify: { url: "https://ntfy.sh/relay", kind: "ntfy", events } }));
  assert.ok(settingsPatchSchema.parse({ remoteNotify: { kind: "webhook", events } }));
  assert.throws(() =>
    settingsPatchSchema.parse({ remoteNotify: { url: "http://example.com/relay", kind: "ntfy", events } }),
  );
  assert.throws(() => settingsPatchSchema.parse({ remoteNotify: { kind: "slack", events } }));
  assert.throws(() => settingsPatchSchema.parse({ remoteNotify: { kind: "ntfy", events: { limit: true } } }));
  assert.deepEqual(remoteNotifySettings(DEFAULT_SETTINGS), {
    kind: "ntfy",
    events: { limit: true, reset: true, autoSwitch: true, signIn: true },
  });
});

test("neither the webhook JSON nor the ntfy post carries a token, an email or an id", () => {
  const payload = webhookPayload(leaky, new Date(NOW), "0.29.0");
  assert.deepEqual(Object.keys(payload).sort(), [
    "account",
    "at",
    "event",
    "relayVersion",
    "resetsAt",
    "usedPercent",
    "window",
  ]);
  assert.deepEqual(payload.account, { name: "[email]" });
  assert.equal(payload.usedPercent, 91);
  assert.equal(payload.window, "five_hour");
  assert.equal(payload.at, new Date(NOW).toISOString());
  const ntfy = ntfyRequest(leaky);
  for (const text of [JSON.stringify(payload), ntfy.body, JSON.stringify(ntfy.headers)])
    for (const secret of secrets) assert.ok(!text.includes(secret), `${secret} in ${text}`);
  // A plain account name passes as it is.
  assert.deepEqual(webhookPayload({ ...leaky, accountName: "Alto" }, new Date(NOW), "0.29.0").account, {
    name: "Alto",
  });
});

test("ntfy gets the text as its body and Title, Tags and Priority as headers", () => {
  const plain = ntfyRequest({ event: "limit-ready", accountName: "Alto", title: "Alto is ready again", message: "The 5-hour limit reset." });
  assert.equal(plain.body, "The 5-hour limit reset.");
  assert.equal(plain.headers.Title, "Alto is ready again");
  assert.equal(plain.headers.Tags, "white_check_mark,relay");
  assert.equal(plain.headers["Content-Type"], "text/plain; charset=utf-8");
  assert.equal(plain.headers.Priority, undefined);
  assert.equal(ntfyRequest(leaky).headers.Priority, "high");
  // A title outside ASCII is RFC 2047 encoded, which fetch accepts and ntfy decodes.
  const turkish = ntfyRequest({ event: "auto-switch", title: "Otomatik geçiş", message: "" });
  const encoded = /^=\?UTF-8\?B\?(.+)\?=$/.exec(turkish.headers.Title);
  assert.ok(encoded);
  assert.equal(Buffer.from(encoded[1], "base64").toString("utf8"), "Otomatik geçiş");
  assert.equal(turkish.body, "Otomatik geçiş");
  assert.doesNotThrow(() => new Headers(turkish.headers));
});

test("a webhook post is JSON, refuses redirects and reports its status", async () => {
  const { calls, fetch } = recorder([204]);
  const result = await postRemoteNotice({ url: "https://example.com/hooks/relay", kind: "webhook" }, { ...leaky, event: "test" }, deps(fetch));
  assert.deepEqual(result, { ok: true, status: 204 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal((calls[0].init.headers as Record<string, string>)["Content-Type"], "application/json");
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.event, "test");
  assert.equal(body.relayVersion, "0.29.0");
});

test("a timeout is tried once more after the backoff, then reported, never thrown", async () => {
  const logs: string[] = [],
    sleeps: number[] = [];
  const { calls, fetch } = recorder(["hang"]);
  const url = "https://ntfy.sh/relay-private-topic";
  const result = await postRemoteNotice({ url, kind: "ntfy" }, leaky, deps(fetch, logs, sleeps));
  assert.deepEqual(result, { ok: false, reason: "failed", error: "timeout" });
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [1_234]);
  assert.equal(logs.length, 1);
  assert.ok(!logs[0].includes("relay-private-topic") && !logs[0].includes("ntfy.sh"), logs[0]);
});

test("a 5xx or a network failure is retried once, a 4xx is final, and errors never name the URL", async () => {
  const server = recorder([503, 200]);
  assert.deepEqual(
    await postRemoteNotice({ url: "https://ntfy.sh/relay", kind: "ntfy" }, leaky, deps(server.fetch)),
    { ok: true, status: 200 },
  );
  assert.equal(server.calls.length, 2);
  const refused = recorder([403]);
  assert.deepEqual(
    await postRemoteNotice({ url: "https://ntfy.sh/relay", kind: "ntfy" }, leaky, deps(refused.fetch)),
    { ok: false, reason: "failed", status: 403, error: "HTTP 403" },
  );
  assert.equal(refused.calls.length, 1);
  const url = "https://hooks.example.com/secret-path";
  const down = recorder([new TypeError(`fetch failed for ${url}`)]);
  const result = await postRemoteNotice({ url, kind: "webhook" }, leaky, deps(down.fetch));
  assert.equal(down.calls.length, 2);
  assert.equal(result.ok, false);
  assert.ok(!JSON.stringify(result).includes("secret-path") && !JSON.stringify(result).includes("hooks.example.com"));
  // Without a URL nothing is sent; a refused URL never reaches fetch.
  const idle = recorder([200]);
  assert.deepEqual(await postRemoteNotice({ kind: "ntfy" }, leaky, deps(idle.fetch)), { ok: false, reason: "off" });
  assert.deepEqual(
    await postRemoteNotice({ url: "http://example.com/x", kind: "ntfy" }, leaky, deps(idle.fetch)),
    { ok: false, reason: "invalid-url" },
  );
  assert.equal(idle.calls.length, 0);
});

test("the notifier posts only the events that are on, and only with a URL", async () => {
  const { calls, fetch } = recorder([200]);
  let remoteNotify: typeof DEFAULT_SETTINGS.remoteNotify = undefined;
  const notifier = new RemoteNotifier({ ...deps(fetch), settings: () => ({ remoteNotify }) });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  notifier.notify(leaky);
  await settle();
  assert.equal(calls.length, 0);
  remoteNotify = {
    url: "https://ntfy.sh/relay",
    kind: "ntfy",
    events: { limit: false, reset: true, autoSwitch: true, signIn: true },
  };
  notifier.notify(leaky);
  notifier.notify({ event: "test", title: "x", message: "" });
  await settle();
  assert.equal(calls.length, 0);
  notifier.notify({ event: "limit-ready", accountName: "Alto", window: "seven_day", title: "Alto is ready again", message: "" });
  notifier.notify({ event: "auto-switch", accountName: "Vertex", title: "Automatic switch", message: "" });
  notifier.notify({ event: "sign-in-ended", accountName: "Cirrus", title: "Sign-in ended", message: "" });
  await settle();
  assert.deepEqual(
    calls.map((c) => (c.init.headers as Record<string, string>).Tags),
    ["white_check_mark,relay", "twisted_rightwards_arrows,relay", "key,relay"],
  );
  // The test button posts whatever the events say.
  assert.deepEqual(await notifier.test({ url: "https://ntfy.sh/relay", kind: "ntfy" }, leaky), { ok: true, status: 200 });
});
