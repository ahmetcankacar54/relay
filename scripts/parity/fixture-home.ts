/**
 * A throwaway Relay world for the CLI and gateway parity recordings (rust/README.md): a data
 * folder with three accounts and a sealed vault, a Claude Desktop folder, a fake `security`
 * tool holding the vault key, and a fake `claude` CLI. Every id, key and name is fixed; times are
 * relative to the moment it is built, so what the CLI prints about them stays the same run to run.
 *
 * Run as a script it builds one under the system temp folder and prints the `export` lines:
 *   eval "$(node --import tsx scripts/parity/fixture-home.ts)"
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { DesktopManager, type DesktopHost } from "../../electron/core/desktop";
import { jsonBytes, writeBytes } from "../../electron/core/desktop-files";
import { writePrivateJson } from "../../electron/core/continuation-journal";
import { acquireProfileLock } from "../../electron/core/profile-lock";
import { STATE_SCHEMA, Store } from "../../electron/core/store";
import { credentialService } from "../../electron/core/usage-credentials";
import { createSealer } from "../../electron/core/vault-crypto";
import { markVaultFormat } from "../../electron/core/vault-migration";
import { FEATURE_RISKS } from "../../shared/feature-risk";
import { FORMAT_LOCALE } from "../../shared/i18n/locales";
import { tFor } from "../../shared/i18n/translate";
import { localDate } from "../../shared/planning";
import {
  STATUSLINE_FILE,
  type StatuslineSnapshot,
} from "../../shared/statusline";
import { DEFAULT_PLANNING, DEFAULT_SETTINGS } from "../../shared/types";
import { fakeSecurity } from "../../tests/fake-security";

/** The vault key every fixture is sealed with: 32 bytes of 0x11. */
export const FIXTURE_VAULT_KEY = Buffer.alloc(32, 0x11);
/** The gateway client key saved in the fixture's settings. */
export const FIXTURE_PROXY_KEY = "relay-fixture-client-key-0123456789abcdef";
/** The Chromium "Claude Safe Storage" password the fixture's cookie DB is encrypted with. */
export const FIXTURE_SAFE_STORAGE = "fixture-safe-storage-password";
/** The version the fake `claude` reports: new enough to read limits. */
export const FIXTURE_CLAUDE_VERSION = "2.1.300 (Claude Code)";
const ZONE = "Europe/Istanbul";
const CREATED = "2026-10-01T09:00:00.000Z";
const CHECKED = "2026-11-20T08:00:00.000Z";

export const FIXTURE_ACCOUNTS = {
  personal: {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Personal",
    accountUuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    orgId: "a0a0a0a0-a0a0-4a0a-8a0a-a0a0a0a0a0a0",
    email: "personal@example.com",
  },
  work: {
    id: "22222222-2222-4222-8222-222222222222",
    name: "Work",
    accountUuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    orgId: "b0b0b0b0-b0b0-4b0b-8b0b-b0b0b0b0b0b0",
    email: "work@acme.example",
  },
  codex: {
    id: "33333333-3333-4333-8333-333333333333",
    name: "Codex",
    email: "codex@example.com",
  },
} as const;
/** A Claude app sign-in no saved account has (the `unsaved` scenario). */
const UNSAVED = {
  accountUuid: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  orgId: "c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0",
};

/**
 * Variations on the default world, chosen per case through RELAY_PARITY_SCENARIO (a
 * comma-separated list):
 * - `empty`: a fresh install, no state.json and no vault;
 * - `unsaved`: the Claude app is signed in to an account Relay has not saved;
 * - `state-lock`: another process holds state.lock (a write waits 2 s, then exit 3);
 * - `operation-lock`: Relay.app holds the vault's operation lock, switching accounts;
 * - `profile-lock`: another process renews Work's usage sign-in (exclusive profile lock);
 * - `pending`: a Claude app sign-in for a new account "Pending" is under way;
 * - `recovery`: an interrupted switch left its journal;
 * - `newer-state`: state.json was written by a newer Relay (schema 99);
 * - `newer-vault`: the vault was written by a newer Relay;
 * - `stale-statusline`: Relay.app wrote the status line snapshot 2 hours ago;
 * - `no-ledger`: Relay.app has kept no token ledger yet;
 * - `gateway`: the gateway's risks are accepted and every account has a credential.
 */
export const SCENARIOS = [
  "empty",
  "unsaved",
  "state-lock",
  "operation-lock",
  "profile-lock",
  "pending",
  "recovery",
  "newer-state",
  "newer-vault",
  "stale-statusline",
  "no-ledger",
  "gateway",
] as const;
export type Scenario = (typeof SCENARIOS)[number];

export function parseScenarios(raw: string | undefined): Set<Scenario> {
  const names = (raw ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  for (const name of names)
    if (!(SCENARIOS as readonly string[]).includes(name))
      throw new Error(
        `Unknown parity scenario "${name}"; known: ${SCENARIOS.join(", ")}.`,
      );
  return new Set(names as Scenario[]);
}

export interface FixtureOptions {
  scenarios?: Iterable<Scenario>;
  /** The live process named as the holder of a busy lock; this one by default. */
  holderPid?: number;
  now?: number;
}

/** The environment that points Relay at a fixture. */
export interface FixtureEnv {
  RELAY_HOME: string;
  RELAY_CLAUDE_DIR: string;
  RELAY_CLAUDE_APP: string;
  RELAY_SECURITY_TOOL: string;
  HOME: string;
  LANG: string;
  RELAY_LANG: string;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/**
 * A margin past whole minutes for every future time: the CLI prints "in 2 h 30 min" rounded down,
 * so the line stays the same for the first 15 seconds after the fixture is built.
 */
const SLACK = 15_000;

function fakeClaude(file: string) {
  fs.writeFileSync(
    file,
    `#!/bin/sh
# The Claude Code CLI as Relay's parity fixture needs it; never the real one.
case "$1 $2" in
  "--version "*) echo "${FIXTURE_CLAUDE_VERSION}"; exit 0 ;;
  "auth status")
    if [ -f "$CLAUDE_CONFIG_DIR/fixture-auth-status.json" ]; then cat "$CLAUDE_CONFIG_DIR/fixture-auth-status.json"; exit 0; fi
    echo '{"loggedIn":false}'; exit 1 ;;
  "auth login"|"auth logout") exit 0 ;;
esac
echo "claude (parity fixture): $*"
echo "profile: $(basename "$CLAUDE_CONFIG_DIR")"
exit 0
`,
    { mode: 0o755 },
  );
}

/** Chromium's macOS `v10` cookie value, as Claude Desktop's Cookies database holds it (version 24). */
function encryptCookie(value: string, host: string): Buffer {
  const key = crypto.pbkdf2Sync(
    FIXTURE_SAFE_STORAGE,
    "saltysalt",
    1003,
    16,
    "sha1",
  );
  const cipher = crypto.createCipheriv(
    "aes-128-cbc",
    key,
    Buffer.alloc(16, 0x20),
  );
  const plain = Buffer.concat([
    crypto.createHash("sha256").update(host).digest(),
    Buffer.from(value),
  ]);
  return Buffer.concat([
    Buffer.from("v10"),
    cipher.update(plain),
    cipher.final(),
  ]);
}

const COOKIE_SCHEMA = `CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
CREATE TABLE cookies(creation_utc INTEGER NOT NULL,host_key TEXT NOT NULL,top_frame_site_key TEXT NOT NULL,name TEXT NOT NULL,value TEXT NOT NULL,encrypted_value BLOB NOT NULL,path TEXT NOT NULL,expires_utc INTEGER NOT NULL,is_secure INTEGER NOT NULL,is_httponly INTEGER NOT NULL,last_access_utc INTEGER NOT NULL,has_expires INTEGER NOT NULL,is_persistent INTEGER NOT NULL,priority INTEGER NOT NULL,samesite INTEGER NOT NULL,source_scheme INTEGER NOT NULL,source_port INTEGER NOT NULL,last_update_utc INTEGER NOT NULL,source_type INTEGER NOT NULL,has_cross_site_ancestor INTEGER NOT NULL);`;

/** Claude Desktop's Cookies database with one claude.ai session per sign-in. */
function cookieDatabase(file: string, sessionKey: string, orgId: string) {
  fs.rmSync(file, { force: true });
  const db = new DatabaseSync(file);
  try {
    db.exec(COOKIE_SCHEMA);
    db.prepare("INSERT INTO meta VALUES ('version', '24')").run();
    // Chromium's epoch: microseconds since 1601-01-01; fixed, never compared with the clock.
    const created = 13_400_000_000_000_000n;
    const expires = 13_500_000_000_000_000n;
    const insert = db.prepare(
      "INSERT INTO cookies VALUES (?, '.claude.ai', '', ?, '', ?, '/', ?, 1, 1, ?, 1, 1, 1, 0, 2, 443, ?, 0, 0)",
    );
    for (const [name, value] of [
      ["sessionKey", sessionKey],
      ["lastActiveOrg", orgId],
    ])
      insert.run(
        created,
        name,
        encryptCookie(value, ".claude.ai"),
        expires,
        created,
        created,
      );
  } finally {
    db.close();
  }
}

/** Signs the fixture's Claude folder in to `who`, as Claude Desktop leaves it. */
async function signInDesktop(
  claude: string,
  who: { accountUuid: string; orgId: string },
  secret: string,
) {
  await writeBytes(
    claude,
    "config.json",
    jsonBytes({
      "oauth:tokenCacheV2": `FIXTURE-SECRET-${secret}`,
      lastKnownAccountUuid: who.accountUuid,
    }),
  );
  cookieDatabase(
    path.join(claude, "Cookies"),
    `sk-ant-sid01-FIXTURE-SECRET-${secret}`,
    who.orgId,
  );
  const sessions = path.join(
    claude,
    "claude-code-sessions",
    who.accountUuid,
    who.orgId,
  );
  fs.mkdirSync(sessions, { recursive: true, mode: 0o700 });
}

/** An in-process Claude host for saving the fixture's accounts: Claude never runs. */
function fixtureHost(): DesktopHost {
  const sealer = createSealer(FIXTURE_VAULT_KEY);
  return {
    available: async () => true,
    running: async () => false,
    quit: async () => {},
    launch: async () => {},
    seal: (text) => sealer.seal(text),
    unseal: (data) => sealer.unseal(data),
  };
}

const counts = (
  input: number,
  output: number,
  cacheWrite: number,
  cacheRead: number,
  cost: number,
) => ({
  input,
  output,
  cacheWrite,
  cacheRead,
  responses: Math.max(1, Math.round(output / 400)),
  cost,
  unpriced: 0,
});

/**
 * Builds the fixture in `root` (created when missing) and returns the environment that points
 * Relay at it.
 */
export async function buildFixtureHome(
  root: string,
  options: FixtureOptions = {},
): Promise<FixtureEnv> {
  const scenarios = new Set(options.scenarios ?? []);
  const now = options.now ?? Date.now();
  const holderPid = options.holderPid ?? process.pid;
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  root = fs.realpathSync(root);
  const home = path.join(root, "home");
  const data = path.join(root, "relay");
  const claude = path.join(root, "claude");
  const bin = path.join(root, "bin");
  for (const dir of [home, claude, bin])
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true, mode: 0o700 });

  // The fake `security`, moved into the fixture so it goes with it; it serves the vault key.
  const security = fakeSecurity({
    stored: FIXTURE_VAULT_KEY.toString("base64"),
  });
  const securityDir = path.join(root, "security");
  fs.cpSync(security.dir, securityDir, { recursive: true });
  security.remove();
  const securityTool = path.join(securityDir, "security");
  const keychainItem = (service: string, value: string) =>
    fs.writeFileSync(
      path.join(securityDir, `item-${service.replace(/[^A-Za-z0-9]/g, "_")}`),
      value,
    );
  keychainItem("Claude Safe Storage", FIXTURE_SAFE_STORAGE);

  const claudeExe = path.join(bin, "claude");
  fakeClaude(claudeExe);

  const env: FixtureEnv = {
    RELAY_HOME: data,
    RELAY_CLAUDE_DIR: claude,
    // Absent on purpose: every Claude app operation takes its "not installed" path.
    RELAY_CLAUDE_APP: path.join(root, "Claude.app"),
    RELAY_SECURITY_TOOL: securityTool,
    HOME: home,
    LANG: "en_US.UTF-8",
    RELAY_LANG: "en",
  };

  if (scenarios.has("empty")) {
    await signInDesktop(claude, UNSAVED, "unsaved");
    return env;
  }

  const { personal, work, codex } = FIXTURE_ACCOUNTS;
  const settings = {
    ...structuredClone(DEFAULT_SETTINGS),
    proxy: {
      enabled: false,
      port: 8317,
      host: "127.0.0.1",
      affinityTtlSeconds: 3600,
      routingStrategy: "soonest-reset" as const,
      apiKey: FIXTURE_PROXY_KEY,
    },
    planning: { ...structuredClone(DEFAULT_PLANNING), timeZone: ZONE },
    desktopHistoryTransfer: "all" as const,
    // Neither a browser's Claude extension nor the terminal's Claude Code sign-in (the real
    // Keychain) follows a switch here.
    claudeExtension: { mode: "off" as const },
    terminalCli: "off" as const,
    riskAcknowledged: scenarios.has("gateway")
      ? {
          "gateway-claude": FEATURE_RISKS["gateway-claude"].textVersion,
          "gateway-codex": FEATURE_RISKS["gateway-codex"].textVersion,
        }
      : {},
  };
  // A Claude account's usage sign-in, as `claude auth status` reported it.
  const claudeAuth = (who: {
    email: string;
    accountUuid: string;
    orgId: string;
  }) => ({
    loggedIn: true,
    email: who.email,
    accountUuid: who.accountUuid,
    orgId: who.orgId,
    subscription: "max",
    plan: "max5" as const,
    checkedAt: CHECKED,
  });
  const state = {
    version: 1,
    schema: STATE_SCHEMA,
    settings,
    accounts: [
      {
        id: personal.id,
        name: personal.name,
        kind: "personal",
        group: "personal",
        color: "terra",
        createdAt: CREATED,
        provider: "claude",
        auth: claudeAuth(personal),
      },
      {
        id: work.id,
        name: work.name,
        kind: "work",
        group: "work:Acme",
        color: "olive",
        createdAt: CREATED,
        provider: "claude",
        auth: { ...claudeAuth(work), orgName: "Acme" },
      },
      {
        id: codex.id,
        name: codex.name,
        kind: "personal",
        group: "personal",
        color: "blue",
        createdAt: CREATED,
        provider: "codex",
        auth: { loggedIn: true, email: codex.email, checkedAt: CHECKED },
      },
    ],
    pinned: [],
    importEnabled: false,
    executable: claudeExe,
    lineage: {},
    autoSwitchCompleted: {},
  };
  fs.mkdirSync(data, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(data, "state.json"),
    JSON.stringify(state, null, 2),
    { mode: 0o600 },
  );

  // Saved through the core as Relay.app saves them, so the vault is what it would hold.
  const store = new Store(data, { backupOnOpen: false, migrateOnOpen: false });
  const vault = path.join(data, "desktop-vault");
  fs.mkdirSync(vault, { recursive: true, mode: 0o700 });
  await markVaultFormat(vault);
  const manager = new DesktopManager(
    claude,
    store,
    fixtureHost(),
    path.join(home, ".claude"),
  );
  await manager.initialize();
  for (const [who, secret] of [
    [work, "work"],
    [personal, "personal"],
  ] as const) {
    await signInDesktop(claude, who, secret);
    await manager.capture(who.id, who.orgId);
  }
  if (scenarios.has("unsaved")) await signInDesktop(claude, UNSAVED, "unsaved");

  for (const account of state.accounts)
    fs.mkdirSync(path.join(data, "profiles", account.id), {
      recursive: true,
      mode: 0o700,
    });
  // What `claude auth status --json` answers in each Claude profile (the fake `claude` reads it).
  for (const who of [personal, work])
    fs.writeFileSync(
      path.join(data, "profiles", who.id, "fixture-auth-status.json"),
      JSON.stringify({
        loggedIn: true,
        authMethod: "claude.ai",
        email: who.email,
        orgId: who.orgId,
        accountUuid: who.accountUuid,
        subscriptionType: "max",
      }),
    );
  if (scenarios.has("gateway")) {
    for (const who of [personal, work])
      keychainItem(
        credentialService(path.join(data, "profiles", who.id)),
        JSON.stringify({
          claudeAiOauth: {
            accessToken: `sk-ant-oat01-fixture-${who.name.toLowerCase()}`,
            refreshToken: `sk-ant-ort01-fixture-${who.name.toLowerCase()}`,
            expiresAt: now + 8 * HOUR,
            scopes: ["user:inference", "user:profile"],
            subscriptionType: "max",
          },
        }),
      );
    fs.writeFileSync(
      path.join(data, "profiles", codex.id, "provider-credential.json"),
      JSON.stringify({ kind: "api-key", accessToken: "sk-fixture-codex" }),
      { mode: 0o600 },
    );
  }

  // The token ledger Relay.app keeps (version 3), its days in the planning zone.
  if (!scenarios.has("no-ledger")) {
    const day = (ago: number) => localDate(now - ago * DAY, ZONE);
    writePrivateJson(path.join(data, "token-ledger.json"), {
      version: 3,
      zone: ZONE,
      complete: true,
      pricedAt: 1,
      files: {
        k1: { dev: 1, ino: 1, size: 48_000, offset: 48_000, mtimeMs: 1 },
        k2: { dev: 1, ino: 2, size: 12_000, offset: 12_000, mtimeMs: 1 },
      },
      days: {
        [day(0)]: {
          [`acct:${personal.id}`]: {
            "claude-opus-5-5": counts(1200, 3400, 5000, 120_000, 4.25),
          },
          terminal: { "claude-sonnet-4-5": counts(300, 800, 0, 9000, 0.37) },
        },
        [day(1)]: {
          [`acct:${work.id}`]: {
            "claude-sonnet-4-5": counts(2500, 6100, 12_000, 340_000, 1.89),
          },
          [`est:${personal.id}`]: {
            "claude-opus-5-5": counts(400, 900, 1000, 20_000, 0.81),
          },
        },
        [day(3)]: {
          [`acct:${personal.id}`]: {
            "claude-opus-5-5": counts(800, 2100, 3000, 64_000, 2.6),
          },
          unknown: { "claude-haiku-4-5": counts(90, 120, 0, 0, 0.01) },
        },
      },
      slots: {},
      seen: {},
    });
  }
  writePrivateJson(path.join(data, "active-account-timeline.json"), {
    version: 1,
    segments: [{ accountUuid: personal.accountUuid, from: CREATED }],
  });

  // The status line snapshot Relay.app writes; its renewal texts are fixed, as the app wrote them.
  const t = tFor("en");
  const statusline: StatuslineSnapshot = {
    version: 1,
    generatedAt: now - (scenarios.has("stale-statusline") ? 2 * HOUR : MINUTE),
    formatLocale: FORMAT_LOCALE.en,
    profiles: path.join(data, "profiles"),
    desktopAccountId: personal.id,
    terminalFollows: true,
    accounts: [
      {
        id: personal.id,
        name: personal.name,
        identities: [
          { accountUuid: personal.accountUuid, orgId: personal.orgId },
        ],
        fiveHour: {
          used: 34,
          resetsAt: now + 2 * HOUR + 30 * MINUTE + SLACK,
          resets: "resets 17:30",
        },
        week: {
          used: 61,
          resetsAt: now + 3 * DAY + SLACK,
          resets: "resets Sat 09:00",
        },
      },
      {
        id: work.id,
        name: work.name,
        identities: [{ accountUuid: work.accountUuid, orgId: work.orgId }],
        fiveHour: {
          used: 87,
          resetsAt: now + 40 * MINUTE + SLACK,
          resets: "resets 15:40",
        },
        week: {
          used: 12,
          resetsAt: now + 5 * DAY + SLACK,
          resets: "resets Mon 11:00",
        },
      },
    ],
    gateway: { sessions: { "parity-gateway-session": work.id } },
    text: {
      fiveHour: t("statusline.fiveHour", { percent: "{percent}" }),
      week: t("widgetSnapshot.week", { pct: "{percent}" }),
      viaGateway: t("statusline.viaGateway"),
      updatedAgo: t("statusline.updatedAgo", { age: "{age}" }),
    },
  };
  writePrivateJson(path.join(data, STATUSLINE_FILE), statusline);

  // Busy and interrupted states. A held lock names a live process and a start in the future, so
  // it is never stale and its age always reads 0 s.
  const lockInfo = (by: "app" | "cli", kind: string) =>
    JSON.stringify({
      pid: holderPid,
      token: "fixture-lock-token",
      by,
      kind,
      startedAt: new Date(now + HOUR).toISOString(),
    });
  if (scenarios.has("state-lock"))
    fs.writeFileSync(path.join(data, "state.lock"), lockInfo("app", "state"), {
      mode: 0o600,
    });
  if (scenarios.has("operation-lock"))
    fs.writeFileSync(
      path.join(vault, "operation.lock"),
      lockInfo("app", "switch"),
      { mode: 0o600 },
    );
  if (scenarios.has("profile-lock"))
    acquireProfileLock(
      path.join(data, "profiles", ".locks"),
      work.id,
      "exclusive",
    );
  if (scenarios.has("pending")) {
    const pendingId = "44444444-4444-4444-8444-444444444444";
    store.update((s) => {
      s.accounts.push({
        id: pendingId,
        name: "Pending",
        kind: "personal",
        group: "personal",
        color: "plum",
        createdAt: CREATED,
        provider: "claude",
      });
    });
    fs.mkdirSync(path.join(data, "profiles", pendingId), {
      recursive: true,
      mode: 0o700,
    });
    await writeBytes(
      vault,
      "pending.json",
      jsonBytes({
        profileId: pendingId,
        startedAt: new Date(now - 5 * MINUTE).toISOString(),
      }),
    );
  }
  if (scenarios.has("recovery"))
    await writeBytes(
      vault,
      "journal.json",
      jsonBytes({ backup: "fixture-interrupted-switch" }),
    );
  if (scenarios.has("newer-state")) {
    const file = path.join(data, "state.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    raw.schema = 99;
    raw.settings.futureSetting = true;
    fs.writeFileSync(file, JSON.stringify(raw, null, 2), { mode: 0o600 });
  }
  if (scenarios.has("newer-vault"))
    await writeBytes(vault, "format.json", jsonBytes({ version: 99 }));
  return env;
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-parity-"));
  const env = await buildFixtureHome(root, {
    scenarios: parseScenarios(process.env.RELAY_PARITY_SCENARIO),
  });
  // Shell-quoted: the paths hold no `$`, backquote or backslash.
  for (const [name, value] of Object.entries(env))
    process.stdout.write(`export ${name}=${JSON.stringify(value)}\n`);
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
)
  void main();
