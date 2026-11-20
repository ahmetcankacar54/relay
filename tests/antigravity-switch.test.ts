import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AntigravitySwitcher,
  AntigravityVault,
  antigravityProcesses,
  parseSignIn,
  writeAntigravitySettings,
  type AntigravitySwitchPorts,
} from "../electron/core/antigravity-switch";

const G1 = "11111111-1111-4111-8111-111111111111";
const G2 = "22222222-2222-4222-8222-222222222222";
const accounts = [
  { id: G1, provider: "antigravity" as const, auth: { loggedIn: true, email: "One@Example.test", checkedAt: "2026-11-20T00:00:00Z" } },
  { id: G2, provider: "antigravity" as const, auth: { loggedIn: true, email: "two@example.test", checkedAt: "2026-11-20T00:00:00Z" } },
];

/** A sign-in as Antigravity 2.x stores it: go-keyring's prefix and base64 JSON. */
const signIn = (email: string, refresh = `r-${email}`, access = "a") =>
  "go-keyring-base64:" +
  Buffer.from(
    JSON.stringify({
      token: { access_token: access, token_type: "Bearer", refresh_token: refresh, expiry: "2026-11-20T01:00:00Z", expires_in: 3599 },
      auth_method: "consumer",
      id_token_email: email,
      writer_id: "w",
    }),
  ).toString("base64");

function fakes(start: { item?: string; open?: boolean; agy?: number; settings?: Record<string, unknown> } = {}) {
  const log: string[] = [];
  const world = {
    item: start.item,
    open: start.open ?? true,
    agy: start.agy ?? 0,
    settings: { ...(start.settings ?? {}) } as Record<string, unknown>,
    /** What the app writes into the Keychain as it quits (an old token written back). */
    onQuit: undefined as string | undefined,
    /** The app ignores quit (a confirmation is open). */
    stuck: false,
    /** What the user signs in with on the app's sign-in screen, after this many polls. */
    signInAfter: undefined as { polls: number; item: string } | undefined,
  };
  let polls = 0;
  const ports: AntigravitySwitchPorts = {
    keychain: {
      read: async () => world.item,
      write: async (text) => {
        log.push("write");
        world.item = text;
      },
      remove: async () => {
        log.push("remove");
        world.item = undefined;
      },
    },
    settings: {
      read: async () => world.settings,
      write: async (values) => {
        log.push("settings");
        Object.assign(world.settings, values);
      },
    },
    processes: async () => ({ app: world.open, agy: world.agy }),
    quit: async () => {
      log.push("quit");
      if (world.stuck) return;
      if (world.onQuit) world.item = world.onQuit;
      world.open = false;
    },
    launch: async () => {
      log.push("launch");
      world.open = true;
    },
    sleep: async () => {
      polls++;
      if (world.signInAfter && polls >= world.signInAfter.polls && world.item === undefined) world.item = world.signInAfter.item;
    },
  };
  return { world, ports, log };
}

function vaultIn(dir: string) {
  return new AntigravityVault(dir, (text) => Buffer.from(text), (data) => data.toString("utf8"));
}

async function withDir(fn: (dir: string) => Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-switch-"));
  try {
    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("a sign-in names its Google account from id_token_email, or from the id_token, and only Antigravity's format counts", () => {
  assert.deepEqual(parseSignIn(signIn("One@Example.test")), { valid: true, email: "one@example.test" });
  const jwt = `x.${Buffer.from(JSON.stringify({ email: "two@example.test" })).toString("base64url")}.y`;
  const old = "go-keyring-base64:" + Buffer.from(JSON.stringify({ token: { refresh_token: "r" }, id_token: jwt })).toString("base64");
  assert.deepEqual(parseSignIn(old), { valid: true, email: "two@example.test" });
  assert.deepEqual(parseSignIn('{"token":{}}'), { valid: false });
  assert.deepEqual(parseSignIn("go-keyring-base64:" + Buffer.from('{"token":{}}').toString("base64")), { valid: false });
  assert.deepEqual(parseSignIn(undefined), { valid: false });
});

test("the app's account is read from the Keychain item and its sign-in is kept for that Relay account", async () => {
  await withDir(async (dir) => {
    const { ports } = fakes({ item: signIn("one@example.test"), settings: { "agy.onboarding.lastLoginUsername": "one@example.test", "agy.onboarding.lastLoginIsGcpTos": "false" } });
    const vault = vaultIn(dir);
    const switcher = new AntigravitySwitcher(ports, vault, () => accounts);
    assert.deepEqual(await switcher.current(), { accountId: G1 });
    const saved = await vault.load(G1);
    assert.equal(saved?.raw, signIn("one@example.test"));
    assert.deepEqual(saved?.onboarding, { "agy.onboarding.lastLoginUsername": "one@example.test", "agy.onboarding.lastLoginIsGcpTos": "false" });
    assert.deepEqual((await switcher.state()).saved, [G1]);
  });
});

test("a switch closes the app, keeps what it wrote on the way out, puts the other sign-in in, sets its terms keys and opens it again", async () => {
  await withDir(async (dir) => {
    const { world, ports, log } = fakes({ item: signIn("one@example.test", "r1", "a1"), agy: 2 });
    const vault = vaultIn(dir);
    await vault.save(G2, { email: "two@example.test", raw: signIn("two@example.test"), onboarding: { "agy.onboarding.lastLoginUsername": "two@example.test" } });
    // The app refreshes its token while quitting and writes it back.
    world.onQuit = signIn("one@example.test", "r1", "a2");
    const switcher = new AntigravitySwitcher(ports, vault, () => accounts, () => {}, () => 1000);
    const result = await switcher.switchTo(G2);
    assert.deepEqual(result, { kind: "switched", accountId: G2, agyRunning: 2, at: 1000 });
    assert.equal(world.item, signIn("two@example.test"));
    assert.equal(world.open, true);
    assert.equal(world.settings["agy.onboarding.lastLoginUsername"], "two@example.test");
    // The newest copy of the account it left, written during the quit, is the one kept.
    assert.equal((await vault.load(G1))?.raw, signIn("one@example.test", "r1", "a2"));
    assert.deepEqual(log, ["quit", "write", "settings", "launch"]);
  });
});

test("a switch leaves a closed app closed, and does nothing when the app is already on the account", async () => {
  await withDir(async (dir) => {
    const { world, ports, log } = fakes({ item: signIn("one@example.test"), open: false });
    const vault = vaultIn(dir);
    await vault.save(G2, { email: "two@example.test", raw: signIn("two@example.test") });
    const switcher = new AntigravitySwitcher(ports, vault, () => accounts);
    assert.equal((await switcher.switchTo(G2)).kind, "switched");
    assert.equal(world.open, false);
    assert.deepEqual(log, ["write"]);
    log.length = 0;
    assert.equal((await switcher.switchTo(G2)).kind, "switched");
    assert.deepEqual(log, []);
  });
});

test("a switch stops without touching the Keychain when the app will not close, or the account has no saved sign-in", async () => {
  await withDir(async (dir) => {
    const { world, ports, log } = fakes({ item: signIn("one@example.test") });
    world.stuck = true;
    const vault = vaultIn(dir);
    const switcher = new AntigravitySwitcher(ports, vault, () => accounts);
    assert.equal((await switcher.switchTo(G2)).reason, "not-saved");
    await vault.save(G2, { email: "two@example.test", raw: signIn("two@example.test") });
    const result = await switcher.switchTo(G2);
    assert.equal(result.kind, "failed");
    assert.equal(result.reason, "still-running");
    assert.equal(world.item, signIn("one@example.test"));
    assert.ok(!log.includes("write"));
  });
});

test("a sign-in of a Google account Relay does not have is kept aside before a switch overwrites it", async () => {
  await withDir(async (dir) => {
    const { ports } = fakes({ item: signIn("stranger@example.test") });
    const vault = vaultIn(dir);
    await vault.save(G2, { email: "two@example.test", raw: signIn("two@example.test") });
    const switcher = new AntigravitySwitcher(ports, vault, () => accounts);
    assert.deepEqual(await switcher.current(), { other: true });
    assert.equal((await switcher.switchTo(G2)).kind, "switched");
    // Its own slot, named by its e-mail's hash.
    const [slot] = fs.readdirSync(path.join(dir, "antigravity-app")).filter((n) => n.startsWith("other-"));
    const other = JSON.parse(fs.readFileSync(path.join(dir, "antigravity-app", slot), "utf8"));
    assert.equal(other.raw, signIn("stranger@example.test"));
  });
});

test("saving another account's sign-in takes the current one off this Mac without signing out, waits for the new one and keeps it", async () => {
  await withDir(async (dir) => {
    const { world, ports, log } = fakes({ item: signIn("one@example.test") });
    world.signInAfter = { polls: 3, item: signIn("two@example.test") };
    const vault = vaultIn(dir);
    let changes = 0;
    const switcher = new AntigravitySwitcher(ports, vault, () => accounts, () => changes++);
    await switcher.beginSignIn(G2);
    assert.deepEqual(log.slice(0, 3), ["quit", "remove", "launch"]);
    // The wait runs on after the call returns.
    for (let i = 0; i < 500 && (await switcher.state()).busy; i++) await new Promise((r) => setImmediate(r));
    const state = await switcher.state();
    assert.equal(state.busy, undefined);
    assert.equal(state.result?.kind, "saved");
    assert.deepEqual(state.saved.sort(), [G1, G2].sort());
    assert.equal((await vault.load(G1))?.raw, signIn("one@example.test"));
    assert.equal((await vault.load(G2))?.raw, signIn("two@example.test"));
    assert.ok(changes > 0);
  });
});

test("cancelling a sign-in puts the earlier one back and opens the app on it", async () => {
  await withDir(async (dir) => {
    const { world, ports } = fakes({ item: signIn("one@example.test") });
    const vault = vaultIn(dir);
    const switcher = new AntigravitySwitcher(ports, vault, () => accounts);
    await switcher.beginSignIn(G2);
    assert.equal(world.item, undefined);
    assert.equal((await switcher.state()).busy, "signing-in");
    switcher.cancelSignIn();
    for (let i = 0; i < 500 && (await switcher.state()).busy; i++) await new Promise((r) => setImmediate(r));
    assert.equal((await switcher.state()).result?.kind, "cancelled");
    assert.equal(world.item, signIn("one@example.test"));
    assert.equal(world.open, true);
  });
});

test("one Antigravity step at a time", async () => {
  await withDir(async (dir) => {
    const { ports } = fakes({ item: signIn("one@example.test") });
    const switcher = new AntigravitySwitcher(ports, vaultIn(dir), () => accounts);
    await switcher.beginSignIn(G2);
    await assert.rejects(switcher.switchTo(G1), /busy/);
    switcher.cancelSignIn();
  });
});

test("Antigravity's processes are told apart in a ps listing: the app bundle's, and each agy", () => {
  const ps = [
    "    1 /sbin/launchd",
    "  200 /Applications/Antigravity.app/Contents/MacOS/Antigravity",
    "  201 /Applications/Antigravity.app/Contents/Resources/bin/language_server",
    "  300 /Users/u/.local/bin/agy",
    "  301 agy",
    "  302 /Users/u/.gemini/antigravity/bin/agentapi",
    "  400 /usr/bin/agyx",
  ].join("\n");
  assert.deepEqual(antigravityProcesses(ps), { app: true, agy: 2 });
  assert.deepEqual(antigravityProcesses("    1 /sbin/launchd\n  201 /Applications/Antigravity.app/Contents/Resources/bin/language_server"), { app: true, agy: 0 });
  assert.deepEqual(antigravityProcesses("    1 /sbin/launchd"), { app: false, agy: 0 });
  // The app's helper started from its own folder keeps it counted as running; agy's own helpers do not.
  assert.deepEqual(antigravityProcesses("  302 /Users/u/.gemini/antigravity/bin/agentapi\n  303 /Users/u/.gemini/antigravity-cli/bin/agentapi"), { app: true, agy: 0 });
});

test("the app's settings file keeps every other key, and only terms keys are written", async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, "app_storage.json");
    fs.writeFileSync(file, JSON.stringify({ keep: "1", "agy.onboarding.lastLoginUsername": "one@example.test" }), { mode: 0o600 });
    await writeAntigravitySettings(file, { "agy.onboarding.lastLoginUsername": "two@example.test", other: "no" });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { keep: "1", "agy.onboarding.lastLoginUsername": "two@example.test" });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    fs.symlinkSync(file, path.join(dir, "link.json"));
    await assert.rejects(writeAntigravitySettings(path.join(dir, "link.json"), {}));
  });
});

test("nothing is overwritten or removed when the sign-in in use cannot be kept first", async () => {
  await withDir(async (dir) => {
    const { world, ports, log } = fakes({ item: signIn("one@example.test") });
    const vault = vaultIn(dir);
    await vault.save(G2, { email: "two@example.test", raw: signIn("two@example.test") });
    const broken = Object.assign(Object.create(Object.getPrototypeOf(vault)), vault, {
      save: async () => {
        throw new Error("disk full");
      },
      savePending: async () => {
        throw new Error("disk full");
      },
    }) as AntigravityVault;
    const switcher = new AntigravitySwitcher(ports, broken, () => accounts);
    const result = await switcher.switchTo(G2);
    assert.deepEqual([result.kind, result.reason], ["failed", "save"]);
    assert.equal(world.item, signIn("one@example.test"));
    assert.ok(!log.includes("write") && !log.includes("quit"));
    // A new account's sign-in does not start either.
    world.item = signIn("one@example.test", "fresh");
    await switcher.beginSignIn(G2);
    assert.equal((await switcher.state()).result?.reason, "save");
    assert.equal(world.item, signIn("one@example.test", "fresh"));
    assert.ok(!log.includes("remove"));
  });
});

test("a switch that moved the sign-in but could not open the app again says so", async () => {
  await withDir(async (dir) => {
    const { world, ports } = fakes({ item: signIn("one@example.test") });
    ports.launch = async () => {
      throw new Error("open failed");
    };
    const vault = vaultIn(dir);
    await vault.save(G2, { email: "two@example.test", raw: signIn("two@example.test") });
    const result = await new AntigravitySwitcher(ports, vault, () => accounts).switchTo(G2);
    assert.deepEqual([result.kind, result.reason], ["failed", "launch"]);
    assert.equal(world.item, signIn("two@example.test"));
  });
});

test("a cancel while the app is still closing stops before the sign-in is taken off this Mac", async () => {
  await withDir(async (dir) => {
    const { world, ports, log } = fakes({ item: signIn("one@example.test") });
    const switcher = new AntigravitySwitcher(ports, vaultIn(dir), () => accounts);
    const quit = ports.quit;
    ports.quit = async () => {
      switcher.cancelSignIn();
      await quit();
    };
    await switcher.beginSignIn(G2);
    const state = await switcher.state();
    assert.equal(state.busy, undefined);
    assert.equal(state.result?.kind, "cancelled");
    assert.equal(world.item, signIn("one@example.test"));
    assert.ok(!log.includes("remove"));
    assert.equal(world.open, true);
  });
});

test("a cancel puts the earlier sign-in back even when the app will not close, and a Relay that quit mid-way puts it back at start", async () => {
  await withDir(async (dir) => {
    const { world, ports } = fakes({ item: signIn("one@example.test") });
    const vault = vaultIn(dir);
    const switcher = new AntigravitySwitcher(ports, vault, () => accounts);
    await switcher.beginSignIn(G2);
    world.stuck = true;
    switcher.cancelSignIn();
    for (let i = 0; i < 500 && (await switcher.state()).busy; i++) await new Promise((r) => setImmediate(r));
    assert.equal((await switcher.state()).result?.kind, "cancelled");
    assert.equal(world.item, signIn("one@example.test"));
    assert.equal(await vault.loadPending(), undefined);

    // Relay quit during a wait: the item is gone and the pending copy is on disk.
    await vault.savePending(signIn("one@example.test"));
    world.item = undefined;
    await new AntigravitySwitcher(ports, vault, () => accounts).recover();
    assert.equal(world.item, signIn("one@example.test"));
    assert.equal(await vault.loadPending(), undefined);
    // A sign-in made since is left alone.
    await vault.savePending(signIn("one@example.test"));
    world.item = signIn("two@example.test");
    await new AntigravitySwitcher(ports, vault, () => accounts).recover();
    assert.equal(world.item, signIn("two@example.test"));
  });
});

test("a background reading that began before a switch does not save over what the switch kept", async () => {
  await withDir(async (dir) => {
    const { world, ports } = fakes({ item: signIn("one@example.test", "r1", "old") });
    const vault = vaultIn(dir);
    await vault.save(G2, { email: "two@example.test", raw: signIn("two@example.test") });
    let release!: () => void;
    const read = ports.keychain.read;
    let hold = true;
    ports.keychain.read = async () => {
      const value = await read();
      if (hold) {
        hold = false;
        await new Promise<void>((r) => (release = r));
      }
      return value;
    };
    const switcher = new AntigravitySwitcher(ports, vault, () => accounts);
    const peek = switcher.current();
    await new Promise((r) => setImmediate(r));
    world.onQuit = signIn("one@example.test", "r1", "new");
    world.item = signIn("one@example.test", "r1", "new");
    assert.equal((await switcher.switchTo(G2)).kind, "switched");
    release();
    await peek;
    assert.equal((await vault.load(G1))?.raw, signIn("one@example.test", "r1", "new"));
  });
});

test("removing an account from Relay deletes its saved app sign-in", async () => {
  await withDir(async (dir) => {
    const { ports } = fakes({ item: signIn("one@example.test") });
    const vault = vaultIn(dir);
    const switcher = new AntigravitySwitcher(ports, vault, () => accounts);
    await switcher.current();
    assert.ok(await vault.load(G1));
    await switcher.forget(G1);
    assert.equal(await vault.load(G1), undefined);
    assert.deepEqual((await switcher.state()).saved, []);
  });
});

test("two Google accounts Relay does not have keep a sign-in each; the second never overwrites the first", async () => {
  await withDir(async (dir) => {
    const vault = vaultIn(dir);
    await vault.saveOther(signIn("first@example.test"));
    await vault.saveOther(signIn("second@example.test"));
    await vault.saveOther(signIn("first@example.test", "r-newer"));
    const others = fs.readdirSync(path.join(dir, "antigravity-app")).filter((n) => n.startsWith("other-"));
    assert.equal(others.length, 2);
    // Still no account slot: list() names Relay accounts only.
    assert.deepEqual(await vault.list(), []);
  });
});

test("a sign-in that cannot be put back keeps its copy on disk, and the next start puts it back", async () => {
  await withDir(async (dir) => {
    const { world, ports } = fakes({ item: signIn("one@example.test") });
    let writable = true;
    const failing: AntigravitySwitchPorts = {
      ...ports,
      keychain: {
        ...ports.keychain,
        write: async (text) => {
          if (!writable) throw new Error("locked");
          await ports.keychain.write(text);
        },
      },
      // The app will not open on its sign-in screen: the step fails after the item was taken off.
      launch: async () => {
        throw new Error("no app");
      },
    };
    const vault = vaultIn(dir);
    const switcher = new AntigravitySwitcher(failing, vault, () => accounts);
    writable = false;
    await switcher.beginSignIn(G2);
    assert.equal(world.item, undefined);
    assert.equal(await vault.loadPending(), signIn("one@example.test"));
    assert.equal((await switcher.state()).result?.kind, "failed");
    // Next start, the Keychain works again: the sign-in goes back and its copy goes.
    writable = true;
    await new AntigravitySwitcher(failing, vault, () => accounts).recover();
    assert.equal(world.item, signIn("one@example.test"));
    assert.equal(await vault.loadPending(), undefined);
  });
});

test("a background reading that crossed a switch neither saves its older sign-in nor stands as current", async () => {
  await withDir(async (dir) => {
    const { world, ports } = fakes({ item: signIn("one@example.test", "r-old") });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let first = true;
    const gated: AntigravitySwitchPorts = {
      ...ports,
      keychain: {
        ...ports.keychain,
        read: async () => {
          if (!first) return ports.keychain.read();
          first = false;
          const seen = world.item;
          await gate;
          return seen;
        },
      },
    };
    const vault = vaultIn(dir);
    await vault.save(G2, { email: "two@example.test", raw: signIn("two@example.test") });
    const switcher = new AntigravitySwitcher(gated, vault, () => accounts);
    const peek = switcher.current();
    // Meanwhile the app renewed its token, and the user switches to the other account.
    world.item = signIn("one@example.test", "r-new");
    assert.equal((await switcher.switchTo(G2)).kind, "switched");
    release();
    await peek;
    assert.equal((await vault.load(G1))?.raw, signIn("one@example.test", "r-new"));
    assert.deepEqual(await switcher.current(), { accountId: G2 });
  });
});

test("an app that is asked to quit but does not close in time is opened again", async () => {
  await withDir(async (dir) => {
    const { world, ports, log } = fakes({ item: signIn("one@example.test") });
    world.stuck = true;
    const vault = vaultIn(dir);
    await vault.save(G2, { email: "two@example.test", raw: signIn("two@example.test") });
    const result = await new AntigravitySwitcher(ports, vault, () => accounts).switchTo(G2);
    assert.equal(result.reason, "still-running");
    assert.deepEqual(log.filter((l) => l === "quit" || l === "launch"), ["quit", "launch"]);
    // Nothing was written: the sign-in in use stays.
    assert.equal(world.item, signIn("one@example.test"));
  });
});

test("a failure that is not the Keychain's is not called one", async () => {
  await withDir(async (dir) => {
    const { ports } = fakes({ item: signIn("one@example.test") });
    const broken: AntigravitySwitchPorts = { ...ports, processes: async () => Promise.reject(new Error("ps timed out")) };
    const vault = vaultIn(dir);
    await vault.save(G2, { email: "two@example.test", raw: signIn("two@example.test") });
    const result = await new AntigravitySwitcher(broken, vault, () => accounts).switchTo(G2);
    assert.equal(result.kind, "failed");
    assert.equal(result.reason, "unexpected");
  });
});
