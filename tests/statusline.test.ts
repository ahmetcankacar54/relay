import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  STATUSLINE_FILE,
  STATUSLINE_STALE_MS,
  renderStatusline,
  type StatuslineSnapshot,
} from "../shared/statusline";
import { buildStatuslineSnapshot } from "../electron/core/statusline-file";
import {
  ClaudeSettingsUnreadable,
  installStatusline,
  isRelayStatusline,
  statuslineCommand,
  statuslineSetup,
  uninstallStatusline,
} from "../electron/core/claude-statusline";
import {
  findRelayCli,
  isRelayCli,
  loginShellRelay,
  relayCliCandidates,
} from "../electron/core/relay-cli-path";
import { RELAY_CLI_INSTALL, RELAY_CLI_PACKAGE } from "../shared/cli-package";
import { readStatuslineSnapshot, statuslineText } from "../cli/src/statusline";
import { runCli } from "../cli/src/main";
import type { CliIO } from "../cli/src/io";
import type { Account, AccountUsage } from "../shared/types";

const NOW = Date.parse("2026-11-23T12:00:00Z");
const vertex = randomUUID();
const alto = randomUUID();
const person = { accountUuid: randomUUID(), orgId: randomUUID() };

function temp(t: { after: (fn: () => void) => void }) {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "relay-statusline-")),
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function snapshot(
  overrides: Partial<StatuslineSnapshot> = {},
): StatuslineSnapshot {
  return {
    version: 1,
    generatedAt: NOW,
    formatLocale: "en-GB",
    profiles: "/data/Relay/profiles",
    desktopAccountId: vertex,
    terminalFollows: true,
    accounts: [
      {
        id: vertex,
        name: "Vertex",
        identities: [person],
        fiveHour: {
          used: 42,
          resetsAt: NOW + 2 * 3600_000,
          resets: "renews 14:00",
        },
        week: {
          used: 18,
          resetsAt: NOW + 3 * 86_400_000,
          resets: "renews Thu 09:00",
        },
      },
      {
        id: alto,
        name: "Alto",
        identities: [],
        fiveHour: { used: 7 },
        week: { used: 61 },
      },
    ],
    text: {
      fiveHour: "5 h {percent}",
      week: "week {percent}",
      viaGateway: "via gateway",
      updatedAgo: "updated {age}",
    },
    ...overrides,
  };
}

const plain = (_style: string, text: string) => text;
const render = (
  snap: StatuslineSnapshot,
  input: object,
  more: {
    configDir?: string;
    signIn?: { accountUuid: string; orgId: string };
    now?: number;
  } = {},
) =>
  renderStatusline({
    snapshot: snap,
    input,
    configDir: more.configDir,
    signIn: () => more.signIn,
    now: more.now ?? NOW,
    paint: plain,
  });

test("the line names the terminal's sign-in, its five-hour and weekly use and the next renewal", () => {
  assert.equal(
    render(snapshot(), { session_id: "s1" }, { signIn: person }),
    "Vertex · 5 h 42% · week 18% · renews 14:00",
  );
});

test("Claude Code's own rate limits on stdin win over Relay's last read", () => {
  const input = {
    session_id: "s1",
    rate_limits: {
      five_hour: { used_percentage: 63.7, resets_at: NOW / 1000 + 3600 },
      seven_day: { used_percentage: 20 },
    },
  };
  assert.equal(
    render(snapshot(), input, { signIn: person }),
    "Vertex · 5 h 63% · week 20% · renews 14:00",
  );
});

test("a session the gateway carried names the gateway's account", () => {
  const snap = snapshot({ gateway: { sessions: { "s-gw": alto } } });
  assert.equal(
    render(snap, { session_id: "s-gw" }, { signIn: person }),
    "Alto · via gateway · 5 h 7% · week 61%",
  );
  // Another session is still the terminal's sign-in.
  assert.match(
    render(snap, { session_id: "other" }, { signIn: person }),
    /^Vertex · 5 h 42%/,
  );
});

test("a Relay profile in CLAUDE_CONFIG_DIR (relay run) is that account", () => {
  const snap = snapshot();
  assert.match(
    render(
      snap,
      {},
      { configDir: path.join(snap.profiles, alto), signIn: person },
    ),
    /^Alto · /,
  );
  // A folder elsewhere falls through to the sign-in.
  assert.match(
    render(snap, {}, { configDir: "/elsewhere/" + alto, signIn: person }),
    /^Vertex · /,
  );
});

test("without a readable sign-in the terminal follows the Claude app's account, unless it is set not to", () => {
  assert.match(render(snapshot(), {}), /^Vertex · /);
  assert.equal(render(snapshot({ terminalFollows: false }), {}), "");
  // An unknown sign-in names no account but still shows Claude Code's own figures.
  assert.equal(
    render(
      snapshot(),
      { rate_limits: { five_hour: { used_percentage: 5 } } },
      { signIn: { accountUuid: "x", orgId: "y" } },
    ),
    "5 h 5%",
  );
});

test("a period that renewed since the read is left out, with the week's renewal shown only without a five-hour figure", () => {
  // Written a minute ago, read before the five-hour period renewed: its figure is gone, so the
  // week's renewal is the next one the line knows.
  const later = NOW + 3 * 3600_000;
  assert.equal(
    render(
      snapshot({ generatedAt: later - 60_000 }),
      {},
      { signIn: person, now: later },
    ),
    "Vertex · week 18% · renews Thu 09:00",
  );
  const weekOnly = snapshot({
    accounts: [
      {
        id: vertex,
        name: "Vertex",
        identities: [person],
        week: {
          used: 50,
          resetsAt: NOW + 86_400_000 * 2,
          resets: "renews Wed 08:00",
        },
      },
    ],
  });
  assert.equal(
    render(weekOnly, {}, { signIn: person }),
    "Vertex · week 50% · renews Wed 08:00",
  );
});

test("an old snapshot says how old it is", () => {
  const fresh = render(
    snapshot(),
    {},
    { signIn: person, now: NOW + STATUSLINE_STALE_MS - 1000 },
  );
  assert.doesNotMatch(fresh, /updated/);
  const stale = render(
    snapshot(),
    {},
    { signIn: person, now: NOW + 17 * 60_000 },
  );
  assert.match(stale, / · updated 17 min\.? ago$/);
  assert.match(
    render(snapshot(), {}, { signIn: person, now: NOW + 3 * 3600_000 }),
    /updated 3 hr\.? ago$/,
  );
});

test("colors only when asked: percentages by how full, the name bold", (t) => {
  const colored = renderStatusline({
    snapshot: snapshot(),
    input: {},
    signIn: () => person,
    now: NOW,
    paint: (style, text) => `<${style}>${text}</${style}>`,
  });
  assert.equal(
    colored,
    "<bold>Vertex</bold> · 5 h <green>42%</green> · week <green>18%</green> · <dim>renews 14:00</dim>",
  );
  const home = temp(t);
  fs.writeFileSync(
    path.join(home, STATUSLINE_FILE),
    JSON.stringify(snapshot()),
  );
  const run = {
    stdin: "",
    env: { RELAY_HOME: home, CLAUDE_CONFIG_DIR: "" },
    home,
    now: NOW,
  };
  assert.doesNotMatch(
    statuslineText(snapshot(), { ...run, color: false }),
    /\x1b\[/,
  );
  assert.match(
    statuslineText(snapshot(), { ...run, color: true }),
    /\x1b\[1mVertex\x1b\[22m/,
  );
});

test("the CLI reads the snapshot and Claude Code's .claude.json, and answers well under 100 ms", (t) => {
  const home = temp(t);
  const data = path.join(home, "relay");
  fs.mkdirSync(data);
  fs.writeFileSync(
    path.join(data, STATUSLINE_FILE),
    JSON.stringify(snapshot()),
  );
  // A large .claude.json, as Claude Code's grows with its project history.
  const projects = Object.fromEntries(
    Array.from({ length: 2000 }, (_, i) => [
      `/work/p${i}`,
      { history: ["x".repeat(100)] },
    ]),
  );
  fs.writeFileSync(
    path.join(home, ".claude.json"),
    JSON.stringify({
      projects,
      oauthAccount: {
        accountUuid: person.accountUuid.toUpperCase(),
        organizationUuid: person.orgId,
      },
    }),
  );
  const env = { RELAY_HOME: data };
  const stdin = JSON.stringify({
    session_id: "s1",
    model: { id: "claude-x", display_name: "X" },
    workspace: { current_dir: home },
  });
  const once = () => {
    const snap = readStatuslineSnapshot(env, home);
    assert.ok(snap);
    return statuslineText(snap, { stdin, env, home, now: NOW, color: false });
  };
  assert.equal(once(), "Vertex · 5 h 42% · week 18% · renews 14:00");
  const runs = 20;
  const started = performance.now();
  for (let i = 0; i < runs; i++) once();
  const each = (performance.now() - started) / runs;
  assert.ok(each < 100, `${each.toFixed(1)} ms per line`);
});

test("the snapshot is found in the app's data folder on each platform", (t) => {
  const home = temp(t);
  const write = (dir: string) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, STATUSLINE_FILE),
      JSON.stringify(snapshot()),
    );
  };
  write(path.join(home, "Library", "Application Support", "Relay"));
  assert.ok(readStatuslineSnapshot({}, home, "darwin"));
  assert.equal(readStatuslineSnapshot({}, home, "linux"), undefined);
  write(path.join(home, ".config", "Relay"));
  assert.ok(readStatuslineSnapshot({}, home, "linux"));
  write(path.join(home, "xdg", "Relay"));
  assert.ok(
    readStatuslineSnapshot(
      { XDG_CONFIG_HOME: path.join(home, "xdg") },
      home,
      "linux",
    ),
  );
  assert.equal(
    readStatuslineSnapshot(
      { XDG_CONFIG_HOME: path.join(home, "none") },
      home,
      "linux",
    ),
    undefined,
  );
  write(path.join(home, "Roaming", "Relay"));
  assert.ok(
    readStatuslineSnapshot(
      { APPDATA: path.join(home, "Roaming") },
      home,
      "win32",
    ),
  );
  // Another layout, or a file that is not one, reads as no snapshot.
  fs.writeFileSync(
    path.join(home, ".config", "Relay", STATUSLINE_FILE),
    JSON.stringify({ ...snapshot(), version: 99 }),
  );
  assert.equal(readStatuslineSnapshot({}, home, "linux"), undefined);
  fs.writeFileSync(path.join(home, ".config", "Relay", STATUSLINE_FILE), "{");
  assert.equal(readStatuslineSnapshot({}, home, "linux"), undefined);
});

test("Relay.app's snapshot: Claude accounts with current limits, gateway sessions and translated labels", () => {
  const account = (id: string, name: string, extra: Partial<Account> = {}) =>
    ({
      id,
      name,
      kind: "personal",
      group: "personal",
      createdAt: new Date(NOW).toISOString(),
      ...extra,
    }) as unknown as Account;
  const codex = randomUUID();
  const usage = (id: string, five: number, reset: string): AccountUsage =>
    ({
      accountId: id,
      status: "ready",
      stale: false,
      checkedAt: new Date(NOW - 60_000).toISOString(),
      fiveHour: { usedPercent: five, resetsAt: reset },
      sevenDay: {
        usedPercent: 30.9,
        resetsAt: new Date(NOW + 3 * 86_400_000).toISOString(),
      },
    }) as AccountUsage;
  const input = {
    accounts: [
      account(vertex, "Vertex", {
        auth: {
          loggedIn: true,
          accountUuid: person.accountUuid.toUpperCase(),
          orgId: person.orgId,
        },
      } as Partial<Account>),
      account(alto, "Alto"),
      account(codex, "Codex", { provider: "codex" } as Partial<Account>),
    ],
    usage: {
      [vertex]: usage(vertex, 41.6, "2026-11-23T13:30:00Z"),
      // An old read is left out.
      [alto]: {
        ...usage(alto, 10, "2026-11-23T13:00:00Z"),
        checkedAt: new Date(NOW - 3 * 3600_000).toISOString(),
      },
    },
    desktopAccountId: alto,
    terminalMode: "follow" as const,
    gatewaySessions: [
      {
        sessionKey: "hdr:s-old",
        accountId: vertex,
        assignedAt: NOW - 9000,
        lastActiveAt: NOW - 9000,
        requestCount: 1,
      },
      {
        sessionKey: "hdr:s-new",
        accountId: alto,
        assignedAt: NOW - 1000,
        lastActiveAt: NOW - 1000,
        requestCount: 3,
      },
      {
        sessionKey: "user:abc",
        accountId: alto,
        assignedAt: NOW,
        lastActiveAt: NOW,
        requestCount: 1,
      },
      {
        sessionKey: "hdr:s-codex",
        accountId: codex,
        assignedAt: NOW,
        lastActiveAt: NOW,
        requestCount: 1,
      },
    ],
    profiles: "/data/Relay/profiles",
    zone: "UTC",
    now: NOW,
  };
  const en = buildStatuslineSnapshot({ ...input, language: "en" });
  assert.deepEqual(
    en.accounts.map((a) => a.name),
    ["Vertex", "Alto"],
  );
  assert.deepEqual(en.accounts[0].identities, [
    { accountUuid: person.accountUuid, orgId: person.orgId },
  ]);
  assert.deepEqual(en.accounts[0].fiveHour, {
    used: 41,
    resetsAt: Date.parse("2026-11-23T13:30:00Z"),
    resets: "renews 13:30",
  });
  assert.equal(en.accounts[0].week?.used, 30);
  assert.match(en.accounts[0].week?.resets ?? "", /^renews \S+ 12:00$/);
  assert.equal(en.accounts[1].fiveHour, undefined);
  assert.deepEqual(en.gateway, {
    sessions: { "s-new": alto, "s-old": vertex },
  });
  assert.equal(en.desktopAccountId, alto);
  assert.equal(en.formatLocale, "en-GB");
  assert.equal(
    render(en, { session_id: "s-old" }),
    "Vertex · via gateway · 5 h 41% · week 30% · renews 13:30",
  );
  assert.equal(
    buildStatuslineSnapshot({
      ...input,
      gatewaySessions: undefined,
      language: "en",
    }).gateway,
    undefined,
  );
  const tr = buildStatuslineSnapshot({ ...input, language: "tr" });
  assert.equal(tr.accounts[0].fiveHour?.resets, "13:30’da yenilenir");
  assert.equal(
    render(tr, {}, { signIn: person }),
    "Vertex · 5 sa %41 · hafta %30 · 13:30’da yenilenir",
  );
  assert.match(
    render(tr, {}, { signIn: person, now: NOW + 20 * 60_000 }),
    /20 dk\.? önce güncellendi$/,
  );
});

test("install keeps every other key, saves another status line and uninstall puts it back", (t) => {
  const dir = temp(t);
  const claude = path.join(dir, ".claude");
  const previous = path.join(dir, "relay", "claude-statusline-previous.json");
  const file = path.join(claude, "settings.json");
  fs.mkdirSync(claude);
  const theirs = {
    type: "command",
    command: "~/.claude/statusline.sh",
    padding: 2,
  };
  fs.writeFileSync(
    file,
    JSON.stringify({ env: { FOO: "1" }, model: "opus", statusLine: theirs }),
  );
  assert.deepEqual(statuslineSetup(claude), { installed: false, other: true });
  const command = statuslineCommand(["/opt/homebrew/bin/relay"], "darwin");
  assert.equal(command, "/opt/homebrew/bin/relay statusline");
  assert.equal(installStatusline(claude, previous, command), "replaced");
  const installed = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(installed, {
    env: { FOO: "1" },
    model: "opus",
    statusLine: { type: "command", command },
  });
  if (process.platform !== "win32")
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(statuslineSetup(claude), { installed: true, other: false });
  assert.equal(installStatusline(claude, previous, command), "already");
  // Relay's own at another path is moved there, and the saved one is kept.
  assert.equal(
    installStatusline(claude, previous, "/usr/local/bin/relay statusline"),
    "installed",
  );
  assert.ok(fs.existsSync(previous));
  assert.equal(uninstallStatusline(claude, previous), "restored");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
    env: { FOO: "1" },
    model: "opus",
    statusLine: theirs,
  });
  assert.equal(fs.existsSync(previous), false);
  assert.equal(uninstallStatusline(claude, previous), "not-installed");
});

test("without an earlier status line, uninstall removes the key; a stale saved one never comes back", (t) => {
  const dir = temp(t);
  const claude = path.join(dir, ".claude");
  const previous = path.join(dir, "relay", "previous.json");
  // No settings file at all yet.
  assert.equal(
    installStatusline(claude, previous, "relay statusline"),
    "installed",
  );
  assert.equal(uninstallStatusline(claude, previous), "removed");
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(claude, "settings.json"), "utf8")),
    {},
  );
  fs.mkdirSync(path.dirname(previous), { recursive: true });
  fs.writeFileSync(
    previous,
    JSON.stringify({ statusLine: { type: "command", command: "old" } }),
  );
  assert.equal(
    installStatusline(claude, previous, "relay statusline"),
    "installed",
  );
  assert.equal(uninstallStatusline(claude, previous), "removed");
  // `relay statusline --color` set by hand is Relay's too.
  fs.writeFileSync(
    path.join(claude, "settings.json"),
    JSON.stringify({
      statusLine: { type: "command", command: "relay statusline --color" },
    }),
  );
  assert.equal(statuslineSetup(claude).installed, true);
});

test("a settings.json that is not JSON is left alone", (t) => {
  const dir = temp(t);
  const claude = path.join(dir, ".claude");
  fs.mkdirSync(claude);
  fs.writeFileSync(path.join(claude, "settings.json"), "{ not json");
  assert.throws(
    () =>
      installStatusline(claude, path.join(dir, "p.json"), "relay statusline"),
    ClaudeSettingsUnreadable,
  );
  assert.equal(
    fs.readFileSync(path.join(claude, "settings.json"), "utf8"),
    "{ not json",
  );
});

test("the command names every part by absolute path, quoted when it has to be, with forward slashes on Windows", () => {
  assert.equal(
    statuslineCommand(
      ["/Users/Ada Lovelace/.nvm/versions/node/v22.12.0/bin/relay"],
      "darwin",
    ),
    '"/Users/Ada Lovelace/.nvm/versions/node/v22.12.0/bin/relay" statusline',
  );
  assert.equal(
    statuslineCommand(
      [
        "C:\\Program Files\\nodejs\\node.exe",
        "C:\\Users\\ada\\AppData\\Roaming\\npm\\node_modules\\@ahmetcankacar\\relay\\dist\\relay.js",
      ],
      "win32",
    ),
    '"C:/Program Files/nodejs/node.exe" C:/Users/ada/AppData/Roaming/npm/node_modules/@ahmetcankacar/relay/dist/relay.js statusline',
  );
  assert.equal(
    statuslineCommand(['/tmp/a"b$c/relay'], "linux"),
    '"/tmp/a\\"b\\$c/relay" statusline',
  );
  for (const command of [
    "relay statusline",
    "/opt/homebrew/bin/relay statusline --color",
    '"/Users/Ada Lovelace/bin/relay" statusline',
    "/usr/bin/node /x/node_modules/@ahmetcankacar/relay/dist/relay.js statusline",
  ])
    assert.equal(
      isRelayStatusline({ type: "command", command }),
      true,
      command,
    );
  for (const command of [
    "~/.claude/statusline.sh",
    "myrelay statusline",
    "relay status",
    "relay statusline; rm -rf ~",
  ])
    assert.equal(
      isRelayStatusline({ type: "command", command }),
      false,
      command,
    );
});

test("the npm package Settings offers is cli/package.json's", () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "cli", "package.json"), "utf8"),
  );
  assert.equal(RELAY_CLI_PACKAGE, pkg.name);
  assert.equal(RELAY_CLI_INSTALL, `npm i -g ${pkg.name}`);
});

/** An npm global install of the relay CLI under `prefix`: the package, and the bin link to its launcher. */
function npmInstall(prefix: string, bin = path.join(prefix, "bin")) {
  const launcher = path.join(
    prefix,
    "lib",
    "node_modules",
    "@ahmetcankacar",
    "relay",
    "dist",
    "relay.js",
  );
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.writeFileSync(launcher, "#!/usr/bin/env node\n", { mode: 0o755 });
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync(launcher, path.join(bin, "relay"));
  return path.join(bin, "relay");
}

test(
  "Relay.app finds the relay CLI on PATH or in the usual install folders, and only this package's",
  {
    skip:
      process.platform === "win32" &&
      "npm installs symlinks only on macOS and Linux",
  },
  async (t) => {
    const home = temp(t);
    const never = async () =>
      assert.fail("the login shell is asked only when nothing else has relay");
    // A Mac app's bare PATH, and none of this machine's own folders.
    const bare = { PATH: path.join(home, "empty") };
    const find = (
      env: NodeJS.ProcessEnv,
      loginShell: () => Promise<string | undefined>,
    ) =>
      findRelayCli({
        env,
        home,
        platform: "darwin",
        systemDirs: [],
        loginShell,
      });
    // Not installed: nowhere, and the login shell does not know it either.
    let asked = 0;
    assert.equal(await find(bare, async () => (asked++, undefined)), undefined);
    assert.equal(asked, 1);
    // Another program called relay is not ours.
    const other = path.join(home, "other", "relay");
    fs.mkdirSync(path.dirname(other));
    fs.writeFileSync(other, "#!/bin/sh\necho relay\n", { mode: 0o755 });
    assert.equal(isRelayCli(other), false);
    assert.equal(
      await find({ PATH: path.dirname(other) }, async () => other),
      undefined,
    );
    // On PATH.
    const onPath = npmInstall(path.join(home, "prefix"));
    assert.equal(
      await find(
        {
          PATH: [path.dirname(other), path.dirname(onPath)].join(
            path.delimiter,
          ),
        },
        never,
      ),
      onPath,
    );
    // Off the PATH, in an nvm version's bin folder (newest first).
    const nvm = npmInstall(
      path.join(home, ".nvm", "versions", "node", "v22.12.0"),
    );
    const newer = npmInstall(
      path.join(home, ".nvm", "versions", "node", "v24.1.0"),
    );
    const candidates = relayCliCandidates(bare, home, "darwin", []);
    assert.ok(
      candidates.indexOf(newer) >= 0 &&
        candidates.indexOf(newer) < candidates.indexOf(nvm),
    );
    assert.equal(await find(bare, never), newer);
    // Only the login shell knows it (a custom npm prefix set in .zshrc).
    const custom = npmInstall(path.join(home, "custom"));
    fs.rmSync(path.join(home, ".nvm"), { recursive: true });
    assert.equal(await find(bare, async () => custom), custom);
  },
);

test(
  "the login shell is asked with a deadline, and what its startup files print is ignored",
  { skip: process.platform === "win32" && "no login shell on Windows" },
  async (t) => {
    const home = temp(t);
    const relay = npmInstall(path.join(home, "custom"));
    // A shell whose startup prints a greeting, then runs the lookup as `-ilc` asks.
    const chatty = path.join(home, "chatty-sh");
    fs.writeFileSync(
      chatty,
      '#!/bin/sh\necho "Welcome back"\nshift\nexec /bin/sh -c "$1"\n',
      { mode: 0o755 },
    );
    const env = { SHELL: chatty, PATH: `${path.dirname(relay)}:/usr/bin:/bin` };
    assert.equal(await loginShellRelay(env), relay);
    // A shell that never answers is given up on at the deadline.
    const stuck = path.join(home, "stuck-sh");
    fs.writeFileSync(stuck, "#!/bin/sh\nsleep 10\n", { mode: 0o755 });
    const started = Date.now();
    assert.equal(
      await loginShellRelay({ SHELL: stuck, PATH: "/usr/bin:/bin" }, 300),
      undefined,
    );
    assert.ok(Date.now() - started < 2_000);
    assert.equal(await loginShellRelay({ PATH: "/usr/bin:/bin" }), undefined);
  },
);

test("on Windows the usual folder is npm's in %APPDATA%", () => {
  const candidates = relayCliCandidates(
    { Path: "C:\\Windows", APPDATA: "C:\\Users\\ada\\AppData\\Roaming" },
    "C:\\Users\\ada",
    "win32",
  );
  assert.deepEqual(candidates, [
    "C:\\Windows\\relay",
    "C:\\Users\\ada\\AppData\\Roaming\\npm\\relay",
  ]);
});

function memoryIO(env: Record<string, string>, stdin = "") {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = {
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    isTTY: false,
    prompt: async () => undefined,
    readInput: async () => stdin,
    env: { LANG: "en_US.UTF-8", ...env },
    cwd: os.tmpdir(),
    now: () => NOW,
    pid: process.pid,
    onSignal: () => {},
  };
  return { io, out, err };
}

test("relay statusline install, uninstall and the line itself, on any platform", async (t) => {
  const dir = temp(t);
  const data = path.join(dir, "Relay");
  const self = path.join(
    dir,
    "lib",
    "node_modules",
    "@ahmetcankacar",
    "relay",
    "dist",
    "relay.js",
  );
  const deps = {
    transcriptRoot: path.join(dir, ".claude"),
    platform: "linux" as const,
    selfPath: self,
  };
  let m = memoryIO({ RELAY_HOME: data });
  assert.equal(await runCli(["statusline"], m.io, deps), 0);
  assert.match(m.out.join("\n"), /Open Relay\.app once/);
  m = memoryIO({ RELAY_HOME: data });
  assert.equal(await runCli(["statusline", "install"], m.io, deps), 0);
  assert.match(m.out.join("\n"), /now shows Relay/);
  // The CLI writes itself by absolute paths: this Node, then its launcher.
  assert.equal(
    JSON.parse(
      fs.readFileSync(path.join(dir, ".claude", "settings.json"), "utf8"),
    ).statusLine.command,
    statuslineCommand([process.execPath, self]),
  );
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(
    path.join(data, STATUSLINE_FILE),
    JSON.stringify(snapshot()),
  );
  m = memoryIO({ RELAY_HOME: data }, JSON.stringify({ session_id: "s1" }));
  assert.equal(await runCli(["statusline"], m.io, deps), 0);
  assert.deepEqual(m.out, ["Vertex · 5 h 42% · week 18% · renews 14:00"]);
  m = memoryIO({ RELAY_HOME: data, LANG: "tr_TR.UTF-8" });
  assert.equal(await runCli(["statusline", "uninstall"], m.io, deps), 0);
  assert.match(m.out.join("\n"), /durum satırından çıkarıldı/);
  m = memoryIO({ RELAY_HOME: data });
  assert.equal(await runCli(["statusline", "remove"], m.io, deps), 2);
  assert.match(m.err.join("\n"), /relay statusline \[install\|uninstall\]/);
  m = memoryIO({ RELAY_HOME: data });
  assert.equal(await runCli(["statusline", "--json"], m.io, deps), 2);
});

test("off macOS, commands that open the vault say they are macOS only", async (t) => {
  const dir = temp(t);
  for (const argv of [
    ["switch", "Vertex"],
    ["add", "Vertex"],
    ["recover"],
    ["reset-vault"],
    ["history", "sync"],
  ]) {
    const m = memoryIO({
      RELAY_HOME: path.join(dir, "Relay"),
      RELAY_CLAUDE_DIR: path.join(dir, "Claude"),
    });
    assert.equal(
      await runCli(argv, m.io, {
        platform: "win32",
        relayAppVersion: async () => undefined,
      }),
      5,
      argv.join(" "),
    );
    assert.match(m.err.join("\n"), /works on macOS only/, argv.join(" "));
  }
});
