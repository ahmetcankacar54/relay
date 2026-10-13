import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  DEFAULT_SETTINGS,
  DEFAULT_WORKDAY,
  type Account,
  type CreateAccount,
} from "../../shared/types";

export const accountPlanningSchema = z
  .object({
    plan: z.enum(["unknown", "pro", "max5", "max20", "team"]),
    capacityWeight: z.number().finite().min(1).max(100),
  })
  .strict();
export const workdaySchema = z
  .object({
    timeZone: z
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
      }, "Choose a valid time zone."),
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
    usageRefreshMinutes: z.union([
      z.literal(0),
      z.literal(5),
      z.literal(15),
      z.literal(30),
    ]),
    usageWarningPercent: z.union([z.literal(80), z.literal(90), z.literal(95)]),
    usageWarnings: z.boolean(),
    suggestAccounts: z.boolean(),
    desktopHistoryTransfer: z.enum(["same-group", "selected", "off"]),
    desktopHistoryAccounts: z.array(z.uuid()).max(50).default([]),
    autoSwitchMode: z.enum(["off", "after-exit"]).default("off"),
    autoSwitchAccounts: z.array(z.uuid()).max(50).default([]),
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
  settings: settingsSchema.default(DEFAULT_SETTINGS),
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
