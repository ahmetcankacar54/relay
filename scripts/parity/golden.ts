/**
 * Cross-language golden files for relay-core (plan Phase 1 (b)): files the TS writes for the Rust
 * tests to open, and a check that the TS opens the files the Rust wrote.
 *
 *   node --import tsx scripts/parity/golden.ts                 # write crates/relay-core/tests/golden/
 *   node --import tsx scripts/parity/golden.ts --force         # rewrite even golden files that open
 *   node --import tsx scripts/parity/golden.ts --verify <dir>  # open what Rust wrote there
 *
 * Rust writes its side with `cargo test -p relay-core -- --ignored write_golden` into
 * `crates/relay-core/tests/golden/out/`. Sealed files carry a random nonce, so writing keeps an
 * existing golden file whose check still passes: a rerun changes nothing in git.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClassicLevel } from "classic-level";
import {
  collectBackup,
  openBackup,
  readBackupHeader,
  sealBackup,
} from "../../electron/core/backup";
import { readPrivateJson } from "../../electron/core/continuation-journal";
import {
  jsonBytes,
  readBytes,
  writeBytes,
} from "../../electron/core/desktop-files";
import { levelExtensionStorage } from "../../electron/core/extension-storage";
import { ProcessLock, type LockInfo } from "../../electron/core/process-lock";
import { acquireProfileLock } from "../../electron/core/profile-lock";
import { STATE_SCHEMA, Store } from "../../electron/core/store";
import { createSealer } from "../../electron/core/vault-crypto";
import {
  markVaultFormat,
  vaultState,
} from "../../electron/core/vault-migration";
import { DEFAULT_PROXY_CONFIG } from "../../shared/proxy-types";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
export const GOLDEN = path.join(ROOT, "crates/relay-core/tests/golden");

/** The vault key every golden file is sealed with: 32 bytes of 0x11 (the parity fixtures'). */
export const KEY = Buffer.alloc(32, 0x11);
/** The text in `sealed.bin`: non-ASCII on purpose. */
export const SEALED_TEXT = '{"sessionKey":"sk-ant-golden","note":"ğüşİ — ✓"}';
/** The v2 vault folder's files and the text each one seals. */
export const VAULT_TEXTS: Record<string, string> = {
  "accounts/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.bin": '{"login":"personal"}',
  "backups/11111111-2222-4333-8444-555555555555.bin":
    '{"backup":"before-switch"}',
  "drafts/pending.bin": '{"drafts":[]}',
};
export const LOCK_KIND = "golden";
export const LOCK_STARTED_AT = "2026-11-26T00:00:00.000Z";
export const PROFILE_ACCOUNT = "33333333-3333-4333-8333-333333333333";
export const ACCOUNT_NAMES = ["Personal", "Work", "Codex"];
export const PASSPHRASE = "correct horse battery";
export const BACKUP_SCRYPT = { logN: 10, r: 8, p: 1 };
const BACKUP_NOW = Date.parse("2026-11-26T00:00:00.000Z");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROFILE_NAME = /^\d+-[0-9a-f-]{36}\.json$/i;

function check(ok: unknown, what: string): asserts ok {
  if (!ok) throw new Error(what);
}

function tempDir(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `relay-golden-${prefix}-`));
}

function replaceDir(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

/** One golden item: how to write it into a folder, and how to check a folder's copy. */
interface Item {
  name: string;
  /** Present in `dir`: when absent, `--verify` skips it (Rust has not ported it yet). */
  present(dir: string): boolean;
  check(dir: string): Promise<void> | void;
  write(dir: string): Promise<void> | void;
}

/** profile-lock.ts liveEntries' test of a holder file's JSON. */
function isProfileHolder(
  value: unknown,
): value is { pid: number; kind: "shared" | "exclusive"; startedAt: string } {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(v.pid) &&
    (v.kind === "shared" || v.kind === "exclusive") &&
    typeof v.startedAt === "string"
  );
}

// --- vault (vault-crypto, vault-migration) -------------------------------------------------

const sealedItem: Item = {
  name: "sealed.bin",
  present: (dir) => fs.existsSync(path.join(dir, "sealed.bin")),
  check(dir) {
    const text = createSealer(KEY).unseal(
      fs.readFileSync(path.join(dir, "sealed.bin")),
    );
    check(text === SEALED_TEXT, `sealed.bin opened as ${JSON.stringify(text)}`);
  },
  write(dir) {
    fs.writeFileSync(
      path.join(dir, "vault-key.b64"),
      KEY.toString("base64") + "\n",
    );
    fs.writeFileSync(path.join(dir, "sealed.txt"), SEALED_TEXT);
    fs.writeFileSync(
      path.join(dir, "sealed.bin"),
      createSealer(KEY).seal(SEALED_TEXT),
    );
  },
};

const vaultItem: Item = {
  name: "desktop-vault/",
  present: (dir) => fs.existsSync(path.join(dir, "desktop-vault")),
  async check(dir) {
    const vault = path.join(dir, "desktop-vault");
    const state = await vaultState(vault);
    check(state.kind === "ready", `desktop-vault is ${state.kind}, not ready`);
    const marker = await readBytes(vault, "format.json");
    check(
      marker?.equals(jsonBytes({ version: 2 })),
      "desktop-vault/format.json is not markVaultFormat's bytes",
    );
    const sealer = createSealer(KEY);
    for (const [relative, text] of Object.entries(VAULT_TEXTS)) {
      const data = await readBytes(vault, relative);
      check(data, `desktop-vault/${relative} is missing`);
      check(
        sealer.unseal(data) === text,
        `desktop-vault/${relative} opened wrong`,
      );
    }
  },
  async write(dir) {
    fs.writeFileSync(
      path.join(dir, "vault-texts.json"),
      JSON.stringify(VAULT_TEXTS, null, 2) + "\n",
    );
    const vault = path.join(dir, "desktop-vault");
    replaceDir(vault);
    const sealer = createSealer(KEY);
    for (const [relative, text] of Object.entries(VAULT_TEXTS))
      await writeBytes(vault, relative, sealer.seal(text));
    await markVaultFormat(vault);
  },
};

// --- locks (process-lock, profile-lock) ----------------------------------------------------

const stateLockItem: Item = {
  name: "locks/state.lock",
  present: (dir) => fs.existsSync(path.join(dir, "locks/state.lock")),
  check(dir) {
    const file = path.join(dir, "locks/state.lock");
    // The holder's pid is gone by now, so `holder()` would call it stale: the reader itself.
    const reader = new ProcessLock(file, "cli") as unknown as {
      read(): LockInfo | undefined;
    };
    const info = reader.read();
    check(
      info && info.by !== "unknown",
      "locks/state.lock is not a ProcessLock file",
    );
    check(
      info.by === "app" || info.by === "cli",
      `locks/state.lock by ${info.by}`,
    );
    check(info.kind === LOCK_KIND, `locks/state.lock kind ${info.kind}`);
    check(UUID.test(info.token), "locks/state.lock token is not a uuid");
    check(
      Number.isSafeInteger(info.pid) && info.pid > 0,
      "locks/state.lock pid",
    );
    check(
      info.startedAt === LOCK_STARTED_AT,
      `locks/state.lock startedAt ${info.startedAt}`,
    );
    const raw = fs.readFileSync(file, "utf8");
    check(
      raw ===
        JSON.stringify({
          pid: info.pid,
          token: info.token,
          by: info.by,
          kind: info.kind,
          startedAt: info.startedAt,
        }),
      "locks/state.lock is not the TS key order or layout",
    );
  },
  write(dir) {
    const work = tempDir("lock");
    try {
      const lock = new ProcessLock(path.join(work, "state.lock"), "app", {
        now: () => Date.parse(LOCK_STARTED_AT),
      });
      lock.tryAcquire(LOCK_KIND);
      fs.mkdirSync(path.join(dir, "locks"), { recursive: true });
      fs.copyFileSync(
        path.join(work, "state.lock"),
        path.join(dir, "locks/state.lock"),
      );
      lock.release();
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  },
};

const profileLockItem: Item = {
  name: "locks/profile/",
  present: (dir) => fs.existsSync(path.join(dir, "locks/profile")),
  check(dir) {
    const accountDir = path.join(dir, "locks/profile", PROFILE_ACCOUNT);
    const names = fs.readdirSync(accountDir);
    check(names.length === 1, `locks/profile holds ${names.length} files`);
    const [name] = names;
    check(PROFILE_NAME.test(name), `locks/profile file name ${name}`);
    // profile-lock.ts liveEntries' reading and validation; its pid is gone, so not its sweep.
    const value = readPrivateJson(path.join(accountDir, name), 4096);
    check(isProfileHolder(value), "locks/profile file is not a profile lock");
    check(
      name.startsWith(`${value.pid}-`),
      "locks/profile name does not start with its pid",
    );
    check(
      !Number.isNaN(Date.parse(value.startedAt)),
      "locks/profile startedAt",
    );
    check(
      fs.readFileSync(path.join(accountDir, name), "utf8") ===
        JSON.stringify({
          pid: value.pid,
          kind: value.kind,
          startedAt: value.startedAt,
        }),
      "locks/profile file is not the TS key order or layout",
    );
  },
  write(dir) {
    const work = tempDir("profile");
    try {
      const release = acquireProfileLock(work, PROFILE_ACCOUNT, "shared");
      const source = path.join(work, PROFILE_ACCOUNT);
      const target = path.join(dir, "locks/profile", PROFILE_ACCOUNT);
      replaceDir(target);
      for (const name of fs.readdirSync(source))
        fs.copyFileSync(path.join(source, name), path.join(target, name));
      release();
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  },
};

// --- state.json (store) ---------------------------------------------------------------------

/** A registry with the golden accounts, as the TS Store writes it. */
function goldenStore(root: string) {
  const store = new Store(root, { backupOnOpen: false });
  store.create({ name: "Personal", kind: "personal" });
  store.create({ name: "Work", kind: "work", group: "Acme" });
  store.create({ name: "Codex", kind: "personal", provider: "codex" });
  return store;
}

const stateItem: Item = {
  name: "state/state.json",
  present: (dir) => fs.existsSync(path.join(dir, "state/state.json")),
  check(dir) {
    const raw = fs.readFileSync(path.join(dir, "state/state.json"), "utf8");
    check(
      raw === JSON.stringify(JSON.parse(raw), null, 2),
      "state.json is not 2-space JSON without a trailing newline",
    );
    const root = tempDir("state");
    try {
      fs.copyFileSync(
        path.join(dir, "state/state.json"),
        path.join(root, "state.json"),
      );
      const store = new Store(root, {
        backupOnOpen: false,
        migrateOnOpen: false,
        by: "cli",
      });
      check(
        store.fileSchema === STATE_SCHEMA,
        `state.json schema ${store.fileSchema}`,
      );
      const names = store.state.accounts.map((account) => account.name);
      check(
        JSON.stringify(names) === JSON.stringify(ACCOUNT_NAMES),
        `state.json accounts ${names.join(", ")}`,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
  write(dir) {
    const root = tempDir("store");
    try {
      goldenStore(root);
      fs.mkdirSync(path.join(dir, "state"), { recursive: true });
      fs.copyFileSync(
        path.join(root, "state.json"),
        path.join(dir, "state/state.json"),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
};

// --- .relaybackup (backup) ------------------------------------------------------------------

const backupItem: Item = {
  name: "backup.relaybackup",
  present: (dir) => fs.existsSync(path.join(dir, "backup.relaybackup")),
  async check(dir) {
    const file = fs.readFileSync(path.join(dir, "backup.relaybackup"));
    const { params } = readBackupHeader(file);
    check(
      JSON.stringify(params) === JSON.stringify(BACKUP_SCRYPT),
      `backup scrypt ${JSON.stringify(params)}`,
    );
    const { payload } = await openBackup(file, PASSPHRASE);
    const names = payload.accounts.map((account) => account.name);
    check(
      JSON.stringify(names) === JSON.stringify(ACCOUNT_NAMES),
      `backup accounts ${names.join(", ")}`,
    );
  },
  async write(dir) {
    const root = tempDir("backup");
    try {
      const store = goldenStore(root);
      const payload = await collectBackup(
        {
          settings: store.state.settings,
          accounts: store.state.accounts,
          gateway: DEFAULT_PROXY_CONFIG,
        },
        false,
        {
          host: {
            data: root,
            sealer: createSealer(KEY),
            claudeCode: { read: async () => undefined, write: async () => {} },
          },
          relayVersion: "0.29.0",
          platform: "darwin",
          now: () => BACKUP_NOW,
        },
      );
      fs.writeFileSync(
        path.join(dir, "backup.relaybackup"),
        await sealBackup(payload, PASSPHRASE, BACKUP_SCRYPT),
      );
      fs.writeFileSync(
        path.join(dir, "backup-expected.json"),
        JSON.stringify(
          {
            passphrase: PASSPHRASE,
            scrypt: BACKUP_SCRYPT,
            accounts: ACCOUNT_NAMES,
          },
          null,
          2,
        ) + "\n",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
};

// --- LevelDB (extension-storage, draft-transfer) --------------------------------------------

/** The extension's sign-in keys and others, as classic-level writes them; JSON text values. */
export const EXTENSION_BEFORE: Record<string, string> = {
  accountUuid: JSON.stringify("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
  accessToken: JSON.stringify("ACCESS-golden-1"),
  refreshToken: JSON.stringify("REFRESH-golden-1"),
  tokenExpiry: "1900000000001",
  lastAuthFailureReason: JSON.stringify("session_expired"),
  savedPrompts: JSON.stringify(["ğüşİ — ✓"]),
  other: "1",
};
/** The sign-in a write puts in place: without `tokenExpiry`, which the write deletes. */
export const EXTENSION_SIGN_IN: Record<string, string> = {
  accountUuid: JSON.stringify("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
  accessToken: JSON.stringify("ACCESS-golden-2"),
  refreshToken: JSON.stringify("REFRESH-golden-2"),
};

/** Every entry of the LevelDB in `dir`, read from a copy so the folder itself is never touched. */
async function dumpLevel(dir: string): Promise<Record<string, string>> {
  const copy = tempDir("level");
  try {
    fs.cpSync(dir, path.join(copy, "db"), { recursive: true });
    const db = new ClassicLevel<string, string>(path.join(copy, "db"), {
      keyEncoding: "utf8",
      valueEncoding: "utf8",
      createIfMissing: false,
    });
    await db.open();
    try {
      const out: Record<string, string> = {};
      for await (const [key, value] of db.iterator()) out[key] = value;
      return out;
    } finally {
      await db.close();
    }
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
}

const sorted = (entries: Record<string, string>) =>
  JSON.stringify(Object.fromEntries(Object.entries(entries).sort()));

/**
 * `leveldb/extension`: an extension storage classic-level wrote (`before`), and the entries the TS
 * `levelExtensionStorage.write` of `signIn` leaves (`after`). Rust reads the folder and writes
 * `out/leveldb/extension` (this folder after its own write of `signIn`) and
 * `out/leveldb/extension-fresh` (a new database holding `after`), which classic-level opens here.
 */
const extensionLevelItem: Item = {
  name: "leveldb/extension",
  present: (dir) => fs.existsSync(path.join(dir, "leveldb/extension")),
  async check(dir) {
    const expected = JSON.parse(
      fs.readFileSync(path.join(GOLDEN, "leveldb/extension.json"), "utf8"),
    ) as { before: Record<string, string>; after: Record<string, string> };
    const golden = path.resolve(dir) === path.resolve(GOLDEN);
    const got = await dumpLevel(path.join(dir, "leveldb/extension"));
    check(
      sorted(got) === sorted(golden ? expected.before : expected.after),
      `leveldb/extension holds ${Object.keys(got).sort().join(", ")}`,
    );
    const fresh = path.join(dir, "leveldb/extension-fresh");
    if (!golden || fs.existsSync(fresh)) {
      const made = await dumpLevel(fresh);
      check(
        sorted(made) === sorted(expected.after),
        `leveldb/extension-fresh holds ${Object.keys(made).sort().join(", ")}`,
      );
    }
  },
  async write(dir) {
    const target = path.join(dir, "leveldb/extension");
    replaceDir(target);
    const db = new ClassicLevel<string, string>(target, {
      keyEncoding: "utf8",
      valueEncoding: "utf8",
      createIfMissing: true,
    });
    await db.open();
    await db.batch(
      Object.entries(EXTENSION_BEFORE).map(([key, value]) => ({
        type: "put" as const,
        key,
        value,
      })),
      { sync: true },
    );
    // A browser's storage holds table files, not only a log: the reader must handle both.
    await db.compactRange("", "\uffff");
    await db.close();
    const scratch = tempDir("extension");
    try {
      const copy = path.join(scratch, "db");
      fs.cpSync(target, copy, { recursive: true });
      await levelExtensionStorage.write(copy, EXTENSION_SIGN_IN);
      const after = await dumpLevel(copy);
      fs.writeFileSync(
        path.join(dir, "leveldb/extension.json"),
        JSON.stringify(
          { before: EXTENSION_BEFORE, signIn: EXTENSION_SIGN_IN, after },
          null,
          2,
        ) + "\n",
      );
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  },
};

/**
 * claude.ai's Local Storage as Claude's Chromium keeps it: drafts (one needing UTF-16, one
 * Latin-1), sidebar keys and others. Written by Chromium itself through the smoke fixture.
 */
export const LOCAL_STORAGE_SEED: Record<string, string> = {
  "composer-draft:epitaxy-local_aaaaaaaa-0000-4000-8000-0000000000a1":
    JSON.stringify({
      text: "Merhaba — ğüşİ ✓ draft",
      files: [],
      snippets: [],
      owner: "11111111-1111-4111-8111-111111111111",
    }),
  "composer-draft:epitaxy-draft": JSON.stringify({
    text: "plain latin draft é",
    files: ["a.png"],
    snippets: [],
    owner: "11111111-1111-4111-8111-111111111111",
  }),
  "dframe-store": JSON.stringify({
    state: { customGroupsByScope: {}, codeSidebarByScope: {} },
    version: 1,
  }),
  "LSS-persisted.starred-local-code-sessions": JSON.stringify({
    value: [],
    tabId: "",
    timestamp: 1,
  }),
  theme: "dark",
  "ğ-key": "a key outside Latin-1",
};

/** Runs `scripts/fixtures/local-storage.cjs` under Electron: `seed` or `dump`. */
function localStorageScript(mode: "seed" | "dump", root: string, file: string) {
  const electron = createRequire(import.meta.url)("electron") as string;
  const userData = tempDir("local-storage-user");
  try {
    const run = spawnSync(
      electron,
      [
        path.join(ROOT, "scripts/fixtures/local-storage.cjs"),
        mode,
        root,
        file,
        userData,
      ],
      { stdio: "inherit", timeout: 60_000 },
    );
    check(run.status === 0, `local-storage.cjs ${mode} exited ${run.status}`);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

/** `leveldb/local-storage/Local Storage/leveldb`: Rust's draft reader opens a copy of it. */
const localStorageItem: Item = {
  name: "leveldb/local-storage",
  present: (dir) => fs.existsSync(path.join(dir, "leveldb/local-storage")),
  check(dir) {
    const root = tempDir("local-storage");
    try {
      fs.cpSync(path.join(dir, "leveldb/local-storage"), root, {
        recursive: true,
      });
      const out = path.join(root, "dump.json");
      localStorageScript("dump", root, out);
      const got = JSON.parse(fs.readFileSync(out, "utf8")) as Record<
        string,
        string
      >;
      check(
        sorted(got) === sorted(LOCAL_STORAGE_SEED),
        `leveldb/local-storage holds ${Object.keys(got).sort().join(", ")}`,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
  write(dir) {
    const target = path.join(dir, "leveldb/local-storage");
    fs.rmSync(target, { recursive: true, force: true });
    const seed = path.join(dir, "leveldb/local-storage.json");
    fs.mkdirSync(path.dirname(seed), { recursive: true });
    fs.writeFileSync(seed, JSON.stringify(LOCAL_STORAGE_SEED, null, 2) + "\n");
    // Chromium fills the whole profile root; only its Local Storage is kept.
    const root = tempDir("local-storage-seed");
    try {
      localStorageScript("seed", path.join(root, "profile"), seed);
      fs.cpSync(
        path.join(root, "profile", "Local Storage"),
        path.join(target, "Local Storage"),
        { recursive: true },
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
};

const ITEMS: Item[] = [
  sealedItem,
  vaultItem,
  stateLockItem,
  profileLockItem,
  stateItem,
  backupItem,
  extensionLevelItem,
  localStorageItem,
];

async function writeGolden(force: boolean) {
  fs.mkdirSync(GOLDEN, { recursive: true });
  for (const item of ITEMS) {
    if (!force && item.present(GOLDEN)) {
      try {
        await item.check(GOLDEN);
        console.log(`kept    ${item.name}`);
        continue;
      } catch {
        // Stale or damaged: written again below.
      }
    }
    await item.write(GOLDEN);
    await item.check(GOLDEN);
    console.log(`wrote   ${item.name}`);
  }
}

async function verify(dir: string): Promise<boolean> {
  let failed = 0;
  let checked = 0;
  for (const item of ITEMS) {
    if (!item.present(dir)) {
      console.log(`absent  ${item.name}`);
      continue;
    }
    try {
      await item.check(dir);
      checked++;
      console.log(`ok      ${item.name}`);
    } catch (error) {
      failed++;
      console.error(`FAILED  ${item.name}: ${(error as Error).message}`);
    }
  }
  if (!checked && !failed) console.error(`golden: nothing to verify in ${dir}`);
  return failed === 0 && checked > 0;
}

async function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf("--verify");
  if (at < 0) return writeGolden(args.includes("--force"));
  const dir = args[at + 1];
  if (!dir) {
    console.error("golden: --verify needs a folder.");
    process.exit(2);
  }
  process.exit((await verify(path.resolve(dir))) ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
