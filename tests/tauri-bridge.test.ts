import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mock, test } from "node:test";
import ts from "typescript";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { errorMessage } from "../src/data/error-message";
import {
  applyLegacyStorage,
  CHANNELS,
  EVENT_CHANNELS,
  LEGACY_STORAGE_CHANNEL,
  SEND_CHANNELS,
  tauriRelayApi,
  tauriSwitchApi,
} from "../src/data/tauri-bridge";

// The Tauri API reads `window.__TAURI_INTERNALS__`; Node's global object stands in for the window.
Object.assign(globalThis, { window: globalThis });

type Kind = "invoke" | "send" | "on";
type Call = { cmd: string; args: Record<string, unknown> };

/** Each preload method's IPC kind and channel, read from the preload source. */
function preloadTable(
  file: string,
): Map<string, { kind: Kind; channel: string }> {
  const source = ts.createSourceFile(
    file,
    readFileSync(new URL(`../${file}`, import.meta.url), "utf8"),
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  const table = new Map<string, { kind: Kind; channel: string }>();
  const firstCall = (
    node: ts.Node,
  ): { kind: Kind; channel: string } | undefined => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "ipcRenderer" &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    )
      return {
        kind: node.expression.name.text as Kind,
        channel: node.arguments[0].text,
      };
    return ts.forEachChild(node, firstCall);
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "api" &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const property of node.initializer.properties) {
        const call = firstCall(property);
        assert.ok(
          property.name && ts.isIdentifier(property.name) && call,
          property.getText(),
        );
        table.set(property.name.text, call);
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return table;
}

/** A fake Tauri runtime for the `main` webview: records every IPC call; listens settle on demand. */
function fakeTauri(
  reply: (cmd: string, args: Record<string, unknown>) => unknown = () => null,
  label = "main",
) {
  const calls: Call[] = [];
  const pendingListens: (() => void)[] = [];
  let holdListens = false;
  mockWindows(label);
  mockIPC((cmd, payload) => {
    const args = payload as Record<string, unknown>;
    calls.push({ cmd, args });
    if (cmd === "plugin:event|listen") {
      // The event id Tauri hands back; the fake reuses the callback id.
      if (!holdListens) return args.handler;
      // The project's lib predates Promise.withResolvers.
      return new Promise((resolve) =>
        pendingListens.push(() => resolve(args.handler)),
      );
    }
    if (cmd === "plugin:event|unlisten") return null;
    return reply(cmd, args);
  });
  const internals = (
    globalThis as unknown as {
      __TAURI_INTERNALS__: { runCallback(id: number, data: unknown): void };
    }
  ).__TAURI_INTERNALS__;
  return {
    calls,
    hold: () => (holdListens = true),
    settleListens: () => pendingListens.splice(0).forEach((settle) => settle()),
    /** Delivers an event to every listener registered for it, as the app's `emit_to` does. */
    emit(event: string, payload: unknown) {
      for (const call of calls)
        if (call.cmd === "plugin:event|listen" && call.args.event === event)
          internals.runCallback(call.args.handler as number, {
            event,
            id: call.args.handler,
            payload,
          });
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("every preload method keeps its channel and its kind of call", () => {
  const preload = preloadTable("electron/preload.ts");
  const bridge = new Map<string, { kind: Kind; channel: string }>();
  for (const [method, channel] of Object.entries(CHANNELS))
    bridge.set(method, { kind: "invoke", channel });
  for (const [method, channel] of Object.entries(SEND_CHANNELS))
    bridge.set(method, { kind: "send", channel });
  for (const [method, channel] of Object.entries(EVENT_CHANNELS))
    bridge.set(method, { kind: "on", channel });
  assert.equal(preload.size, 128);
  assert.deepEqual(Object.fromEntries(bridge), Object.fromEntries(preload));
  // The built API has exactly those methods.
  assert.deepEqual(
    Object.keys(tauriRelayApi()).sort(),
    [...preload.keys()].sort(),
  );

  const switchPreload = preloadTable("electron/switch-preload.ts");
  assert.deepEqual(Object.fromEntries(switchPreload), {
    onScene: { kind: "on", channel: "relay:switch-scene" },
    ready: { kind: "send", channel: "relay:switch-ready" },
  });
  assert.deepEqual(
    Object.keys(tauriSwitchApi()).sort(),
    [...switchPreload.keys()].sort(),
  );
});

test("a call goes through relay_invoke with its channel and arguments, and returns the reply", async () => {
  const fake = fakeTauri((_cmd, args) => ({ echoed: args.channel }));
  const api = tauriRelayApi();
  assert.deepEqual(await api.snapshot(), { echoed: "relay:snapshot" });
  await api.reopenLogin("acct", "attempt", "browser");
  await api.setAccountSwitchAt("acct", 80);
  assert.deepEqual(fake.calls, [
    { cmd: "relay_invoke", args: { channel: "relay:snapshot", args: [] } },
    {
      cmd: "relay_invoke",
      args: {
        channel: "relay:reopen-login",
        args: ["acct", "attempt", "browser"],
      },
    },
    {
      cmd: "relay_invoke",
      args: { channel: "relay:account-switch-at", args: ["acct", 80] },
    },
  ]);
  // Every invoke method reaches its own channel.
  fake.calls.length = 0;
  const methods = api as unknown as Record<
    string,
    (...args: unknown[]) => Promise<unknown>
  >;
  for (const method of Object.keys(CHANNELS)) await methods[method]("x");
  assert.deepEqual(
    fake.calls.map((call) => call.args.channel),
    Object.values(CHANNELS),
  );
  assert.ok(fake.calls.every((call) => call.cmd === "relay_invoke"));
  clearMocks();
});

test("a send goes through relay_send and returns nothing", async () => {
  const fake = fakeTauri();
  const api = tauriRelayApi();
  assert.equal(api.terminalResize("run", 120, 40), undefined);
  api.terminalWrite("run", "ls\r");
  api.setPanelHeight(480);
  api.closePanel();
  tauriSwitchApi().ready();
  await flush();
  assert.deepEqual(fake.calls, [
    {
      cmd: "relay_send",
      args: { channel: "relay:resize", args: ["run", 120, 40] },
    },
    {
      cmd: "relay_send",
      args: { channel: "relay:write", args: ["run", "ls\r"] },
    },
    { cmd: "relay_send", args: { channel: "relay:panel-size", args: [480] } },
    { cmd: "relay_send", args: { channel: "relay:panel-close", args: [] } },
    { cmd: "relay_send", args: { channel: "relay:switch-ready", args: [] } },
  ]);
  clearMocks();
});

test("a listener hears its own window's events with the sent arguments, until it unsubscribes", async () => {
  const fake = fakeTauri(undefined, "panel");
  const api = tauriRelayApi();
  const navigate = mock.fn();
  const visibility = mock.fn();
  const off = api.onNavigate(navigate);
  api.onPanelVisibility(visibility);
  await flush();
  const listens = fake.calls.filter(
    (call) => call.cmd === "plugin:event|listen",
  );
  assert.deepEqual(
    listens.map((call) => [call.args.event, call.args.target]),
    [
      ["relay:navigate", { kind: "Webview", label: "panel" }],
      ["relay:panel-visibility", { kind: "Webview", label: "panel" }],
    ],
  );
  fake.emit("relay:navigate", ["usage", "plan"]);
  assert.deepEqual(
    navigate.mock.calls.map((call) => call.arguments),
    [["usage", "plan"]],
  );
  // The preload hands the panel a strict boolean.
  fake.emit("relay:panel-visibility", ["yes"]);
  fake.emit("relay:panel-visibility", [true]);
  assert.deepEqual(
    visibility.mock.calls.map((call) => call.arguments),
    [[false], [true]],
  );

  off();
  off();
  await flush();
  const unlistens = fake.calls.filter(
    (call) => call.cmd === "plugin:event|unlisten",
  );
  assert.deepEqual(
    unlistens.map((call) => call.args),
    [{ event: "relay:navigate", eventId: listens[0].args.handler }],
  );
  const warn = mock.method(console, "warn", () => {});
  fake.emit("relay:navigate", ["overview"]);
  warn.mock.restore();
  assert.equal(navigate.mock.callCount(), 1);
  clearMocks();
});

test("an unsubscribe before the listener registers unlistens once it does", async () => {
  const fake = fakeTauri();
  fake.hold();
  const changed = mock.fn();
  const off = tauriRelayApi().onChanged(changed);
  off();
  await flush();
  assert.equal(
    fake.calls.filter((call) => call.cmd === "plugin:event|unlisten").length,
    0,
  );
  fake.settleListens();
  await flush();
  assert.deepEqual(
    fake.calls
      .filter((call) => call.cmd === "plugin:event|unlisten")
      .map((call) => call.args.event),
    ["relay:changed"],
  );
  clearMocks();
});

test("a call made after a subscribe reaches the app after the listener registers", async () => {
  // The switch window subscribes, then says it is ready; the app answers with the story at once.
  const fake = fakeTauri(undefined, "switch");
  fake.hold();
  const scene = mock.fn();
  const api = tauriSwitchApi();
  api.onScene(scene);
  api.ready();
  await flush();
  assert.deepEqual(
    fake.calls.map((call) => call.cmd),
    ["plugin:event|listen"],
  );
  fake.settleListens();
  await flush();
  assert.deepEqual(
    fake.calls.map((call) => call.cmd),
    ["plugin:event|listen", "relay_send"],
  );
  fake.emit("relay:switch-scene", [{ step: "start" }]);
  assert.deepEqual(
    scene.mock.calls.map((call) => call.arguments),
    [[{ step: "start" }]],
  );
  clearMocks();
});

test("a refused call rejects with the Error Electron gives, which errorMessage reads the same way", async () => {
  fakeTauri(() => Promise.reject("Account not found."));
  const error = await tauriRelayApi()
    .removeAccount("missing")
    .then(
      () => assert.fail("resolved"),
      (rejected: unknown) => rejected,
    );
  assert.ok(error instanceof Error);
  assert.equal(
    error.message,
    "Error invoking remote method 'relay:remove-account': Error: Account not found.",
  );
  assert.equal(errorMessage(error), "Account not found.");
  clearMocks();
});

test("Electron's saved window preferences fill only the keys this webview lacks", async () => {
  const stored = new Map([["relay.language", "tr"]]);
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
    },
  });
  let legacy: unknown = {
    "relay.language": "de",
    "relay.private": "off",
    "relay.sidebar-size": '{"width":240}',
    "relay.not-a-string": 3,
  };
  const fake = fakeTauri(() => legacy);
  await applyLegacyStorage();
  assert.deepEqual(fake.calls, [
    {
      cmd: "relay_invoke",
      args: { channel: LEGACY_STORAGE_CHANNEL, args: [] },
    },
  ]);
  assert.deepEqual(Object.fromEntries(stored), {
    "relay.language": "tr",
    "relay.private": "off",
    "relay.sidebar-size": '{"width":240}',
  });
  // After the first launch the app has nothing more to hand over.
  legacy = null;
  await applyLegacyStorage();
  assert.equal(stored.size, 3);
  clearMocks();
});
