import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { DesktopHost } from "../electron/core/desktop";
import { DesktopManager } from "../electron/core/desktop";
import { Store } from "../electron/core/store";
import { createSealer, type Sealer } from "../electron/core/vault-crypto";
import { loadVaultKey } from "../electron/core/vault-key";
import { markVaultFormat } from "../electron/core/vault-migration";
import { jsonBytes, writeBytes } from "../electron/core/desktop-files";
import { runCli } from "../cli/src/main";
import type { CliDeps } from "../cli/src/deps";
import type { CliIO } from "../cli/src/io";
import { fakeSecurity } from "./fake-security";
import { extensionWorld } from "./extension-world";

export interface FixtureOptions {
  tty?: boolean;
  answers?: (string | undefined)[];
  env?: Record<string, string>;
  appVersion?: string;
  gui?: boolean;
}

/** A Relay data folder, a Claude folder and a fake Claude host for running the CLI in-process. */
export async function cliFixture(t: any, options: FixtureOptions = {}) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-")));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const home = path.join(temp, "Relay");
  const claude = path.join(temp, "Claude");
  fs.mkdirSync(claude, { recursive: true });
  // An empty stand-in bundle, so checks that look for Claude.app find one.
  fs.mkdirSync(path.join(temp, "Claude.app", "Contents", "MacOS"), { recursive: true });
  fs.writeFileSync(path.join(temp, "Claude.app", "Contents", "MacOS", "Claude"), "");
  const security = fakeSecurity({});
  t.after(security.remove);
  const state = {
    running: false,
    quits: 0,
    starts: 0,
    failQuit: undefined as Error | undefined,
    onQuit: undefined as undefined | (() => void),
    onWrite: undefined as undefined | (() => void),
  };
  const host = (sealer: Sealer): DesktopHost => ({
    available: async () => true,
    running: async () => {
      state.onWrite?.();
      return state.running;
    },
    quit: async () => {
      state.quits++;
      state.onQuit?.();
      if (state.failQuit) throw state.failQuit;
      state.running = false;
    },
    launch: async () => {
      state.running = true;
      state.starts++;
    },
    seal: (text) => sealer.seal(text),
    unseal: (data) => sealer.unseal(data),
  });
  // A home of its own for browsers, and a storage like LevelDB's for the Claude extension.
  const extension = extensionWorld(temp);
  // As the shipped CLI: no LevelDB library, so the extension step is never run from here.
  extension.state.available = false;
  const out: string[] = [],
    err: string[] = [];
  const answers = [...(options.answers ?? [])];
  let signalHandler: ((signal: NodeJS.Signals) => void) | undefined;
  const io: CliIO = {
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    isTTY: options.tty ?? false,
    prompt: async (question) => {
      out.push(question);
      return answers.shift();
    },
    env: {
      RELAY_HOME: home,
      RELAY_CLAUDE_DIR: claude,
      RELAY_CLAUDE_APP: path.join(temp, "Claude.app"),
      LANG: "en_US.UTF-8",
      ...options.env,
    },
    cwd: temp,
    now: () => Date.now(),
    pid: process.pid,
    onSignal: (handler) => {
      signalHandler = handler;
    },
  };
  const deps: Partial<CliDeps> = {
    host,
    securityTool: security.tool,
    request: async () => {
      throw new Error("no network in tests");
    },
    claude: () => undefined,
    spawn,
    processList: async () => "",
    relayAppVersion: async () => options.appVersion,
    guiSession: () => options.gui ?? true,
    selfPath: path.join(temp, "relay-cli.js"),
    transcriptRoot: path.join(temp, ".claude"),
    extension: { system: extension.system, storage: extension.storage },
  };
  let secret = 0;
  /** Signs a new account in to the fixture's Claude folder; its secrets carry FIXTURE-SECRET. */
  async function accountInDesktop(orgCount = 1) {
    const n = ++secret;
    const accountUuid = randomUUID();
    const orgs = Array.from({ length: orgCount }, () => randomUUID());
    await writeBytes(
      claude,
      "config.json",
      jsonBytes({
        "oauth:tokenCacheV2": `FIXTURE-SECRET-${n}`,
        lastKnownAccountUuid: accountUuid,
      }),
    );
    await writeBytes(claude, "Cookies", Buffer.from(`FIXTURE-SECRET-cookie-${n}`));
    for (const org of orgs)
      fs.mkdirSync(path.join(claude, "claude-code-sessions", accountUuid, org), {
        recursive: true,
      });
    return { accountUuid, orgs };
  }
  let sealer: Sealer | undefined;
  async function vaultSealer() {
    if (!sealer) {
      sealer = createSealer(await loadVaultKey({ tool: security.tool, mayCreate: true }));
      await markVaultFormat(path.join(home, "desktop-vault"));
    }
    return sealer;
  }
  /** Saves an account through the core, as an earlier `relay add` or the app would have. */
  async function saved(name: string, group?: string) {
    const signed = await accountInDesktop();
    const store = new Store(home);
    const account = store.create({ name, kind: group ? "work" : "personal", group });
    const manager = new DesktopManager(claude, store, host(await vaultSealer()), path.join(temp, ".claude"));
    await manager.initialize();
    await manager.capture(account.id, signed.orgs[0]);
    state.quits = 0;
    state.starts = 0;
    return { ...new Store(home).account(account.id), orgs: signed.orgs };
  }
  return {
    temp,
    home,
    claude,
    io,
    deps,
    security,
    state,
    extension,
    vaultSealer,
    accountInDesktop,
    saved,
    store: () => new Store(home, { by: "cli", backupOnOpen: false, migrateOnOpen: false }),
    run: (...argv: string[]) => runCli(argv, io, deps),
    out: () => out.join("\n"),
    err: () => err.join("\n"),
    clear: () => {
      out.length = 0;
      err.length = 0;
    },
    signal: (sig: NodeJS.Signals = "SIGINT") => signalHandler?.(sig),
    hasSignalHandler: () => !!signalHandler,
  };
}
