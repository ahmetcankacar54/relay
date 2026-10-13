import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  DEFAULT_PLANNING,
  DEFAULT_SETTINGS,
  DEFAULT_WORKDAY,
  type Account,
  type CreateAccount,
  type PlanningSettings,
} from "../../shared/types";

export const accountPlanningSchema = z
  .object({
    plan: z.enum(["unknown", "pro", "max5", "max20", "team"]),
    capacityWeight: z.number().finite().min(1).max(100),
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
export const workdaySchema = z
  .object({
    timeZone: timeZoneSchema,
    start: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    end: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    weekdays: z
      .array(z.number().int().min(0).max(6))
      .min(1)
      .max(7)
      .refine((ids) => new Set(ids).size === ids.length),
    accountIds: z
      .array(z.uuid())
      .max(50)
      .refine((ids) => new Set(ids).size === ids.length),
    reservePercent: z.number().int().min(0).max(50),
    staggerMinutes: z.number().int().min(0).max(300),
    warmupLeadMinutes: z.number().int().min(0).max(300),
    routineEnabled: z.boolean(),
  })
  .strict()
  .refine(
    (w) =>
      !w.routineEnabled ||
      (w.accountIds.length > 0 &&
        (w.accountIds.length <= 1 || w.staggerMinutes >= 1)),
    "Choose routine accounts and use at least one minute of spacing for multiple accounts.",
  );
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
    timeZone: timeZoneSchema.safeParse(w.timeZone).success
      ? (w.timeZone as string)
      : DEFAULT_PLANNING.timeZone,
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
      checkedAt: z.string(),
      error: z.string().optional(),
    })
    .optional(),
});
export const settingsSchema = z
  .object({
    workday: workdaySchema.default(DEFAULT_WORKDAY),
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
  })
  .strict();
// Migration defaults belong to a complete saved registry, never to an IPC patch.
// Zod applies nested defaults even under partial(), which would otherwise reset
// selected accounts whenever an unrelated preference is changed.
export const settingsPatchSchema = settingsSchema
  .extend({
    workday: settingsSchema.shape.workday.removeDefault(),
    desktopHistoryAccounts:
      settingsSchema.shape.desktopHistoryAccounts.removeDefault(),
    autoSwitchMode: settingsSchema.shape.autoSwitchMode.removeDefault(),
    autoSwitchAccounts: settingsSchema.shape.autoSwitchAccounts.removeDefault(),
  })
  .partial();
const stateSchema = z.object({
  version: z.literal(1),
  settings: z
    .preprocess((value) => {
      if (value && typeof value === "object" && !("planning" in value))
        return {
          ...value,
          planning: planningFromWorkday((value as { workday?: unknown }).workday),
        };
      return value;
    }, settingsSchema)
    .default(DEFAULT_SETTINGS),
  accounts: z.array(accountSchema).max(50),
  pinned: z.array(z.string()),
  importEnabled: z.boolean(),
  executable: z.string().optional(),
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
  })
  .strict();

export function privateDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(dir).isSymbolicLink())
    throw new Error("Veri klasörü sembolik bağlantı olamaz.");
  if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
}
export class Store {
  readonly file: string;
  state: State;
  constructor(readonly root: string) {
    privateDir(root);
    this.file = path.join(root, "state.json");
    if (fs.existsSync(this.file)) {
      if (fs.lstatSync(this.file).isSymbolicLink())
        throw new Error("Geçersiz ayar dosyası.");
      // Fail closed: a corrupt registry must never silently discard saved profiles.
      this.state = stateSchema.parse(
        JSON.parse(fs.readFileSync(this.file, "utf8")),
      );
      this.backup();
      // History used to stay inside a sharing group unless accounts were picked.
      // Sharing across all connected accounts is now the default; an explicit
      // "selected" or "off" choice is kept.
      if (this.state.settings.historyPolicyVersion !== 2)
        this.update((state) => {
          if (state.settings.desktopHistoryTransfer === "same-group")
            state.settings.desktopHistoryTransfer = "all";
          state.settings.historyPolicyVersion = 2;
        });
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
  update(fn: (state: State) => void) {
    const next = structuredClone(this.state);
    fn(next);
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
      if (fs.existsSync(this.file))
        fs.copyFileSync(this.file, `${this.file}.bak`);
      fs.renameSync(tmp, this.file);
      this.state = next;
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
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
    };
    privateDir(path.join(this.root, "profiles", id));
    this.update((state) => {
      state.accounts.push(account);
    });
    return account;
  }
}
