import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ProcessLock } from "./process-lock";
import { TERMINAL_MODES } from "../../shared/terminal-identity";
import { DEFAULT_PROXY_CONFIG } from "../../shared/proxy-types";
import {
  DEFAULT_PLANNING,
  DEFAULT_SETTINGS,
  type Account,
  type CreateAccount,
  type PlanningSettings,
} from "../../shared/types";
import {
  BROWSER_APPS,
  EXTENSION_MODES,
  PROFILE_FOLDER,
} from "../../shared/browser-extension";

export const accountPlanningSchema = z
  .object({
    plan: z.enum(["unknown", "pro", "max5", "max20", "team"]),
    capacityWeight: z.number().finite().min(1).max(100),
  })
  .strict();
export const extensionSettingSchema = z
  .object({
    mode: z.enum(EXTENSION_MODES),
    browser: z
      .object({
        app: z.enum(BROWSER_APPS),
        profile: z.string().regex(PROFILE_FOLDER),
      })
      .strict()
      .optional(),
  })
  .strict();
export const timeZoneSchema = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, "Choose a valid time zone.");
const clockSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const hoursSchema = z
  .object({ enabled: z.boolean(), start: clockSchema, end: clockSchema })
  .strict();
export const planningSchema = z
  .object({
    autoStart: z.boolean(),
    timeZone: timeZoneSchema,
    weekday: hoursSchema,
    weekend: hoursSchema,
    accounts: z
      .array(
        z.object({ id: z.uuid(), firstStart: clockSchema.optional() }).strict(),
      )
      .max(50)
      .refine(
        (list) => new Set(list.map((a) => a.id)).size === list.length,
        "Select each account once.",
      ),
    // No .default(): a partial patch must keep the stored choice.
    tempo: z.enum(["auto", "light", "medium", "heavy"]).optional(),
    // Missing means on; no .default() for the same reason.
    adaptive: z.boolean().optional(),
  })
  .strict();
export const planningPatchSchema = planningSchema.partial();
/** One-time conversion of the pre-0.11 workday settings. */
export function planningFromWorkday(raw: unknown): PlanningSettings {
  const w = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const clock = (value: unknown, fallback: string) =>
    clockSchema.safeParse(value).success ? (value as string) : fallback;
  const days = Array.isArray(w.weekdays) ? w.weekdays : [];
  if (!Object.keys(w).length) return structuredClone(DEFAULT_PLANNING);
  const start = clock(w.start, DEFAULT_PLANNING.weekday.start);
  const end = clock(w.end, DEFAULT_PLANNING.weekday.end);
  const timeZone = timeZoneSchema.safeParse(w.timeZone).success
    ? (w.timeZone as string)
    : DEFAULT_PLANNING.timeZone;
  // The old screen saved its 00:00–00:00 every-day default even when unused;
  // that is not a request for 24-hour work days.
  if (
    start === "00:00" &&
    end === "00:00" &&
    new Set(days).size === 7 &&
    !(Array.isArray(w.accountIds) && w.accountIds.length) &&
    w.routineEnabled !== true
  )
    return { ...structuredClone(DEFAULT_PLANNING), timeZone };
  const ids = Array.isArray(w.accountIds)
    ? [
        ...new Set(
          w.accountIds.filter(
            (id): id is string => z.uuid().safeParse(id).success,
          ),
        ),
      ]
    : [];
  return {
    autoStart: w.routineEnabled === true,
    timeZone,
    weekday: {
      enabled: days.some((d) => typeof d === "number" && d >= 1 && d <= 5),
      start,
      end,
    },
    weekend: {
      enabled: days.some((d) => d === 0 || d === 6),
      start,
      end,
    },
    accounts: ids.map((id) => ({ id })),
  };
}
const accountSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(64),
  kind: z.enum(["personal", "work"]),
  group: z.string().min(1).max(69),
  color: z.string(),
  createdAt: z.iso.datetime(),
  // "gemini" is only read: no build ever made such an account, and nothing creates one.
  provider: z.enum(["claude", "codex", "antigravity", "gemini"]).optional(),
  cooldownUntil: z.iso.datetime().optional(),
  planning: accountPlanningSchema.optional(),
  desktop: z
    .object({
      accountUuid: z.uuid(),
      orgId: z.uuid(),
      savedAt: z.iso.datetime(),
      email: z.string().max(254).optional(),
    })
    .optional(),
  auth: z
    .object({
      loggedIn: z.boolean(),
      email: z.string().optional(),
      accountUuid: z.uuid().optional(),
      orgId: z.uuid().optional(),
      orgName: z.string().max(150).optional(),
      subscription: z.string().optional(),
      plan: z.enum(["pro", "max5", "max20", "team"]).optional(),
      checkedAt: z.string(),
      error: z.string().optional(),
    })
    .optional(),
});
/** The Proxy Gateway's saved settings: where it listens, how it routes, and its client key. */
export const proxyConfigSchema = z
  .object({
    enabled: z.boolean(),
    port: z.number().int().min(1).max(65_535),
    host: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .refine((host) => !/[\s/@?#]/.test(host), "Not a host address"),
    affinityTtlSeconds: z.number().int().min(10).max(3_600).default(DEFAULT_PROXY_CONFIG.affinityTtlSeconds),
    routingStrategy: z.enum(["soonest-reset", "balanced", "strict-priority"]).default(DEFAULT_PROXY_CONFIG.routingStrategy),
    apiKey: z.string().min(1).max(200).optional(),
  })
  .strict();
export const settingsSchema = z
  .object({
    appearance: z.enum(["system", "light", "dark"]).default("system"),
    // Missing means off, with the defaults; no .default() so a patch keeps the stored choice.
    proxy: proxyConfigSchema.optional(),
    planning: planningSchema,
    usageRefreshMinutes: z.union([
      z.literal(0),
      z.literal(5),
      z.literal(15),
      z.literal(30),
    ]),
    usageWarningPercent: z.union([z.literal(80), z.literal(90), z.literal(95)]),
    usageWarnings: z.boolean(),
    suggestAccounts: z.boolean(),
    desktopHistoryTransfer: z.enum(["all", "same-group", "selected", "off"]),
    desktopHistoryAccounts: z.array(z.uuid()).max(50).default([]),
    autoSwitchMode: z.enum(["off", "after-exit"]).default("off"),
    autoSwitchAccounts: z.array(z.uuid()).max(50).default([]),
    historyPolicyVersion: z.literal(2).optional(),
    menuBarAnimation: z.boolean().optional(),
    switchWindow: z.boolean().optional(),
    pranks: z.enum(["sometimes", "rarely", "off"]).optional(),
    draftRetype: z.boolean().optional(),
    // Missing means the default, mode "restart"; no .default() so a patch keeps the stored choice.
    claudeExtension: extensionSettingSchema.optional(),
    // Missing means "follow"; no .default() so a patch keeps the stored choice.
    terminalCli: z.enum(TERMINAL_MODES).optional(),
  })
  .strict();
// Migration defaults belong to a complete saved registry, never to an IPC patch.
// Zod applies nested defaults even under partial(), which would otherwise reset
// selected accounts whenever an unrelated preference is changed.
export const settingsPatchSchema = settingsSchema
  .extend({
    appearance: settingsSchema.shape.appearance.removeDefault(),
    desktopHistoryAccounts:
      settingsSchema.shape.desktopHistoryAccounts.removeDefault(),
    autoSwitchMode: settingsSchema.shape.autoSwitchMode.removeDefault(),
    autoSwitchAccounts: settingsSchema.shape.autoSwitchAccounts.removeDefault(),
  })
  // The gateway's settings change through its own calls, which restart it when needed.
  .omit({ proxy: true })
  .partial();
// A new install starts with DEFAULT_SETTINGS' "same-group". A saved registry that never
// wrote the mode shared across all accounts, and keeps doing so.
const SAVED_WITHOUT_HISTORY_MODE = "all" as const;
/**
 * The registry layout this build writes. Bumped whenever a field is added anywhere in it, so a
 * build that knows less never writes a file a newer build wrote and silently drops its fields.
 * A file without the field was written before 0.12 and counts as 1. 3 added an account's
 * browser profile; 4 replaced it with the Claude extension setting, and a file's profiles are
 * dropped when it is read. 5 added the extension mode "guide" and made "restart" and "closed"
 * also swap the browser profile's claude.ai login, so a 4 file's "restart" and "closed" (which
 * only swapped the extension's hints) are read as "guide" until the user picks them again.
 * 6 added the terminal's Claude Code setting. 7 added the Proxy Gateway's settings and an
 * account's provider; 0.18.0 and 0.18.1 wrote them under 6, which 0.17 builds cannot read.
 */
export const STATE_SCHEMA = 7;
const stateSchema = z.object({
  version: z.literal(1),
  schema: z.number().int().min(1).optional(),
  settings: z
    .preprocess((value) => {
      if (!value || typeof value !== "object") return value;
      // Registries before 0.11 kept a workday block; it becomes planning once. 0.18.0 and
      // 0.18.1 kept a browser live-switch setting that was removed; it is dropped.
      const { workday, cdpHotSwitch: _cdp, ...rest } = value as Record<string, unknown>;
      // 0.18.0 and 0.18.1 also saved a cross-provider switch that never did anything.
      if (rest.proxy && typeof rest.proxy === "object" && "allowCrossProviderFallback" in rest.proxy) {
        const { allowCrossProviderFallback: _cross, ...proxy } = rest.proxy as Record<string, unknown>;
        rest.proxy = proxy;
      }
      const saved =
        rest.desktopHistoryTransfer === undefined
          ? { ...rest, desktopHistoryTransfer: SAVED_WITHOUT_HISTORY_MODE }
          : rest;
      return "planning" in saved
        ? saved
        : { ...saved, planning: planningFromWorkday(workday) };
    }, settingsSchema)
    .default({
      ...DEFAULT_SETTINGS,
      desktopHistoryTransfer: SAVED_WITHOUT_HISTORY_MODE,
    }),
  accounts: z.array(accountSchema).max(50),
  pinned: z.array(z.string()),
  importEnabled: z.boolean(),
  executable: z.string().optional(),
  /** Where Claude Desktop is, when the user chose it; Relay looks in the usual places otherwise. */
  claudeApp: z.string().optional(),
  lineage: z.record(z.string(), z.string()),
  autoSwitchCompleted: z
    .record(z.string().max(200), z.number().finite().nonnegative())
    .refine((entries) => Object.keys(entries).length <= 100)
    .default({}),
});
export type State = z.infer<typeof stateSchema>;
export const createAccountSchema = z
  .object({
    name: z.string().trim().min(1).max(64),
    kind: z.enum(["personal", "work"]),
    group: z.string().trim().min(1).max(64).optional(),
    provider: z.enum(["claude", "codex", "antigravity"]).optional(),
  })
  .strict();


/** Why a registry write was refused: the file is newer than this build, or older than 0.12. */
export class StoreWriteRefused extends Error {
  constructor(readonly reason: "newer-schema" | "unversioned") {
    super(
      reason === "newer-schema"
        ? "Relay’s account list was written by a newer version. Update this copy of Relay before changing it."
        : "Relay’s account list was written by Relay 0.11 or older. Update Relay.app to 0.12 or later and open it once.",
    );
  }
}

export interface StoreOptions {
  /** Keep a copy of the registry at open (state-backups/, newest 20). Default true. */
  backupOnOpen?: boolean;
  /** Run open-time migrations, and stamp a missing schema. Default true. */
  migrateOnOpen?: boolean;
  /** Write over a file without a schema (pre-0.12). Default true. */
  adoptUnversioned?: boolean;
  /** How long a write waits for another process's write. Default 2000 ms. */
  lockWaitMs?: number;
  by?: "app" | "cli";
}

/**
 * Parses a registry a newer build wrote: its unknown keys are dropped, in strict objects too.
 * Only a reader that never writes uses it.
 */
function parseNewer(raw: unknown): State {
  const value = structuredClone(raw) as Record<string, any>;
  for (let round = 0; round < 50; round++) {
    const result = stateSchema.safeParse(value);
    if (result.success) return result.data;
    const unknown = result.error.issues.filter((i) => i.code === "unrecognized_keys");
    if (!unknown.length) throw result.error;
    for (const issue of unknown) {
      let at: any = value;
      for (const key of issue.path) at = at?.[key as any];
      for (const key of (issue as { keys: string[] }).keys) delete at?.[key];
    }
  }
  throw new Error("Invalid settings file.");
}

export function privateDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(dir).isSymbolicLink())
    throw new Error("Veri klasörü sembolik bağlantı olamaz.");
  if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
}
export class Store {
  readonly file: string;
  state!: State;
  /** The schema of the file as last read; 1 for a file without one. */
  fileSchema = STATE_SCHEMA;
  private readonly options: Required<StoreOptions>;
  private readonly lock: ProcessLock;
  /** The file as last read or written, to notice another process's write. */
  private seen?: { ino: number; size: number; mtimeMs: number };
  constructor(
    readonly root: string,
    options: StoreOptions = {},
  ) {
    this.options = {
      backupOnOpen: true,
      migrateOnOpen: true,
      adoptUnversioned: true,
      lockWaitMs: 2000,
      by: "app",
      ...options,
    };
    privateDir(root);
    this.file = path.join(root, "state.json");
    this.lock = new ProcessLock(path.join(root, "state.lock"), this.options.by);
    if (fs.existsSync(this.file)) {
      this.load();
      if (this.options.backupOnOpen) this.backup();
      if (this.options.migrateOnOpen) {
        // Before version 2, history stayed inside a sharing group unless accounts were
        // picked, and that group choice moved to sharing across all connected accounts.
        // An explicit "selected" or "off" choice is kept. A new install starts in
        // "same-group" (no state file, below), so this never touches one.
        if (this.state.settings.historyPolicyVersion !== 2)
          this.update((state) => {
            if (state.settings.desktopHistoryTransfer === "same-group")
              state.settings.desktopHistoryTransfer = "all";
            state.settings.historyPolicyVersion = 2;
          });
        // A registry from 0.11 or older gets its schema now, so a CLI next to this app
        // knows the app has been updated.
        if (this.options.adoptUnversioned && this.fileSchema < STATE_SCHEMA)
          this.update(() => {});
      }
    } else {
      this.state = {
        version: 1,
        settings: { ...DEFAULT_SETTINGS },
        accounts: [],
        pinned: [],
        importEnabled: false,
        lineage: {},
        autoSwitchCompleted: {},
      };
    }
    privateDir(path.join(root, "profiles"));
  }
  /** Reads the file. Fail closed: a corrupt registry must never silently discard saved profiles. */
  private load() {
    const before = fs.lstatSync(this.file);
    if (before.isSymbolicLink()) throw new Error("Geçersiz ayar dosyası.");
    const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
    const schema =
      raw && Number.isSafeInteger(raw.schema) && raw.schema >= 1 ? raw.schema : 1;
    this.state = schema > STATE_SCHEMA ? parseNewer(raw) : stateSchema.parse(raw);
    // Writing to a browser is opt-in: an older file's mode never turns into it silently.
    const extension = this.state.settings.claudeExtension;
    if (schema < 5 && extension && (extension.mode === "restart" || extension.mode === "closed"))
      this.state.settings.claudeExtension = { ...extension, mode: "guide" };
    this.fileSchema = schema;
    this.seen = { ino: before.ino, size: before.size, mtimeMs: before.mtimeMs };
  }
  /** Re-reads the file when another process changed it; true when it did. */
  reload(): boolean {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(this.file);
    } catch {
      return false;
    }
    const seen = this.seen;
    if (
      seen &&
      seen.ino === stat.ino &&
      seen.size === stat.size &&
      seen.mtimeMs === stat.mtimeMs
    )
      return false;
    this.load();
    return true;
  }
  /**
   * Keep the registry as it was at each start (last 20). Another Relay build can
   * rewrite it with its own schema, and the single `.bak` rotates on every write.
   */
  private backup() {
    try {
      const dir = path.join(this.root, "state-backups");
      privateDir(dir);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      fs.copyFileSync(this.file, path.join(dir, `state-${stamp}.json`));
      const saved = fs
        .readdirSync(dir)
        .filter((name) => /^state-[0-9TZ-]+\.json$/.test(name))
        .sort();
      for (const old of saved.slice(0, -20)) fs.unlinkSync(path.join(dir, old));
    } catch {
      // A backup must never prevent Relay from starting.
    }
  }
  /**
   * Changes the registry: under a lock shared with Relay's other processes, it re-reads the
   * file when another process wrote it, applies `fn`, and writes the result with this build's
   * schema. A file newer than this build, or one from 0.11 or older when adopting is off, is
   * never written.
   */
  update(fn: (state: State) => void) {
    this.lock.acquireSync("state", this.options.lockWaitMs);
    try {
      const exists = fs.existsSync(this.file);
      if (exists) this.reload();
      if (exists && this.fileSchema > STATE_SCHEMA)
        throw new StoreWriteRefused("newer-schema");
      if (exists && this.fileSchema < STATE_SCHEMA && !this.options.adoptUnversioned)
        throw new StoreWriteRefused("unversioned");
      const next = structuredClone(this.state);
      fn(next);
      next.schema = STATE_SCHEMA;
      stateSchema.parse(next);
      const tmp = `${this.file}.${randomUUID()}.tmp`;
      try {
        const fd = fs.openSync(tmp, "wx", 0o600);
        try {
          fs.writeFileSync(fd, JSON.stringify(next, null, 2));
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        if (exists) fs.copyFileSync(this.file, `${this.file}.bak`);
        fs.renameSync(tmp, this.file);
        this.state = next;
        this.fileSchema = STATE_SCHEMA;
        const stat = fs.lstatSync(this.file);
        this.seen = { ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
      } finally {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      }
    } finally {
      this.lock.release();
    }
  }
  account(id: string): Account {
    const account = this.state.accounts.find((a) => a.id === id);
    if (!account) throw new Error("Hesap bulunamadı.");
    return structuredClone(account);
  }
  profile(id: string): string {
    this.account(id);
    return path.join(this.root, "profiles", id);
  }
  create(input: CreateAccount): Account {
    const data = createAccountSchema.parse(input);
    if (this.state.accounts.length >= 50)
      throw new Error("En fazla 50 hesap eklenebilir.");
    const id = randomUUID();
    const account: Account = {
      id,
      name: data.name,
      kind: data.kind,
      group: data.kind === "personal" ? "personal" : `work:${data.group || id}`,
      color: ["terra", "olive", "blue", "plum"][this.state.accounts.length % 4],
      createdAt: new Date().toISOString(),
      provider: data.provider ?? "claude",
    };

    privateDir(path.join(this.root, "profiles", id));
    this.update((state) => {
      state.accounts.push(account);
    });
    return account;
  }
  /**
   * Renames an account and sets its type and sharing group, checked as `create` checks them.
   * The provider is fixed when the account is added: its saved credentials belong to it.
   */
  edit(id: string, input: CreateAccount): Account {
    const data = createAccountSchema.parse(input);
    this.account(id);
    this.update((state) => {
      const account = state.accounts.find((a) => a.id === id)!;
      account.name = data.name;
      account.kind = data.kind;
      account.group = data.kind === "personal" ? "personal" : `work:${data.group || id}`;
    });
    return this.account(id);
  }
}
