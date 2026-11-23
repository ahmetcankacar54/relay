import { DEFAULT_SETTINGS } from "../shared/types";
import { intentHash } from "./app/routes";
import { usageSample, type UsageSample } from "../shared/usage-statistics";
import { foldSamples } from "../shared/usage-rollups";
import { buildStatisticsView } from "../shared/usage-statistics-view";
import { buildTokenUsageView } from "../shared/token-usage-view";
import { estimateCost } from "../shared/model-prices";
import { addDays, lostFoundCollection, mondayOf } from "../shared/lost-found";
import type { LedgerSnapshot, TokenCounts } from "../shared/token-usage-view";
import type { TerminalStatus } from "../shared/terminal-identity";
import { localDate, localSlot } from "../shared/planning";
import { DEFAULT_MENU_BAR_ITEMS, menuBarItems } from "../shared/tray";
import { resolveLocale } from "../shared/i18n/locales";
import { acknowledgeRisks } from "../shared/feature-risk";
import type {
  Account,
  AuthFlow,
  DesktopState,
  UpdateState,
  ExtensionStatus,
  MenuBarItem,
  ProxyClientId,
  ProxyRequestLog,
  ProxyStatus,
  RelayAPI,
  Session,
  Snapshot,
} from "../shared/types";
// Browser preview is deliberately explicit and never communicates with the machine.
// Development only: useRelay imports it dynamically under import.meta.env.DEV.
const ids = [
  "fd7f91c2-1bbf-45e0-a11a-37bfe318fd3a",
  "d2f616b5-a4b1-47ad-8b56-ec77bc2f51f6",
  "ebd5376e-923a-40f7-8118-08da5bf22319",
  "f5627ec9-aae3-41f8-9527-b3a88c675a76",
];
const accounts: Account[] = [
  {
    id: ids[0],
    name: "Personal · Max",
    kind: "personal",
    group: "personal",
    color: "terra",
  },
  {
    id: ids[1],
    name: "Personal · Backup",
    kind: "personal",
    group: "personal",
    color: "olive",
  },
  {
    id: ids[2],
    name: "Studio",
    kind: "work",
    group: "work:Studio",
    color: "blue",
  },
  {
    id: ids[3],
    name: "Consulting",
    kind: "work",
    group: "work:Consulting",
    color: "plum",
  },
].map((a) => ({
  ...a,
  kind: a.kind as "personal" | "work",
  createdAt: new Date().toISOString(),
  auth: {
    loggedIn: true,
    checkedAt: new Date().toISOString(),
    email: `account${a.id === ids[0] ? 1 : ids.indexOf(a.id) + 1}@example.test`,
    subscription: a.kind === "personal" ? "max" : "team",
    accountUuid: a.id,
    orgId: a.kind === "personal" ? ids[2] : ids[3],
    orgName: a.kind === "personal" ? "Personal workspace" : "Studio",
  },
}));
/** Brave (used last) and Chrome with the extension; signed in and saved for the first account only. */
const previewExtension: ExtensionStatus = {
  setting: { mode: "guide" },
  instances: [
    { app: "chrome", profile: "Default", name: "Person 1", opened: true, usedAt: Date.now() - 9 * 86_400_000 },
    { app: "brave", profile: "Default", name: "Personal", opened: true, usedAt: Date.now() - 60_000 },
  ],
  target: { app: "brave", profile: "Default", name: "Personal", opened: true },
  picked: "recent",
  restoresTabs: false,
  saved: [{ accountUuid: ids[0], savedAt: new Date().toISOString() }],
  cookiesSaved: [],
};
/** The terminal on the first account; the second has its sign-in saved too. */
const previewTerminal: TerminalStatus = {
  mode: "follow",
  current: {
    state: "signed-in",
    accountUuid: ids[0],
    orgId: ids[2],
    known: true,
    at: new Date().toISOString(),
  },
  saved: [{ accountUuid: ids[0], orgId: ids[2], savedAt: new Date().toISOString(), parked: false }],
};
accounts[0].desktop = {
  accountUuid: ids[0],
  orgId: ids[2],
  savedAt: new Date().toISOString(),
};
accounts[1].desktop = {
  accountUuid: ids[1],
  orgId: ids[2],
  savedAt: new Date().toISOString(),
};
accounts[2].desktop = {
  accountUuid: ids[2],
  orgId: ids[3],
  savedAt: new Date().toISOString(),
};
// A Codex account and two Antigravity accounts: they serve the gateway and their own tools, never
// the Claude app. The first Antigravity account has spent one model; the second has room everywhere.
const otherIds = {
  codex: "0c0de000-4a1b-4c2d-8e3f-000000000001",
  ag1: "a9a9a9a9-4a1b-4c2d-8e3f-000000000002",
  ag2: "a9a9a9a9-4a1b-4c2d-8e3f-000000000003",
};
const signedIn = (email: string, subscription: string) => ({
  loggedIn: true,
  checkedAt: new Date().toISOString(),
  email,
  subscription,
});
accounts.push(
  { id: otherIds.codex, name: "OpenAI · Codex", kind: "personal", group: "personal", color: "olive", provider: "codex", createdAt: new Date().toISOString(), auth: signedIn("codex@example.test", "plus") },
  { id: otherIds.ag1, name: "Google · Antigravity", kind: "personal", group: "personal", color: "blue", provider: "antigravity", createdAt: new Date().toISOString(), auth: signedIn("google1@example.test", "pro") },
  { id: otherIds.ag2, name: "Google · Antigravity 2", kind: "personal", group: "personal", color: "plum", provider: "antigravity", createdAt: new Date().toISOString(), auth: signedIn("google2@example.test", "ultra") },
);
const minutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString();
/**
 * Antigravity's limits are pools (Gemini; Claude & GPT shared), each a five-hour and a weekly
 * window, as its quota summary gives them; the headline is the roomiest pool, as the reader keeps it.
 */
const antigravityUsage = (id: string, windows: [string, string, "five_hour" | "seven_day", number, number][]) => {
  const modelWindows = windows.map(([key, label, period, usedPercent, resetIn]) => ({
    key: `antigravity_${key}`,
    label,
    period,
    usedPercent,
    resetsAt: minutes(resetIn),
  }));
  const pools = new Map<string, (typeof modelWindows)[number]>();
  for (const w of modelWindows) if (!pools.has(w.label) || w.usedPercent > pools.get(w.label)!.usedPercent) pools.set(w.label, w);
  const roomiest = [...pools.values()].sort((a, b) => a.usedPercent - b.usedPercent)[0];
  const head = { usedPercent: roomiest.usedPercent, resetsAt: roomiest.resetsAt };
  return {
    accountId: id,
    status: "ready" as const,
    stale: false,
    checkedAt: minutes(-1),
    ...(roomiest.period === "seven_day" ? { sevenDay: head } : { fiveHour: head }),
    modelWindows,
  };
};
const previewProviderUsage: Record<string, Snapshot["usage"][string]> = {
  [otherIds.codex]: {
    accountId: otherIds.codex,
    status: "ready",
    stale: false,
    checkedAt: minutes(-2),
    fiveHour: { usedPercent: 0, resetsAt: minutes(300) },
    sevenDay: { usedPercent: 100, resetsAt: minutes(4 * 24 * 60 + 5) },
  },
  [otherIds.ag1]: antigravityUsage(otherIds.ag1, [
    ["gemini_5h", "Gemini", "five_hour", 100, 25],
    ["gemini_weekly", "Gemini", "seven_day", 71, 4 * 24 * 60 + 17 * 60],
    ["3p_5h", "Claude & GPT", "five_hour", 62, 190],
    ["3p_weekly", "Claude & GPT", "seven_day", 30, 5 * 24 * 60],
  ]),
  [otherIds.ag2]: antigravityUsage(otherIds.ag2, [
    ["gemini_5h", "Gemini", "five_hour", 6, 299],
    ["gemini_weekly", "Gemini", "seven_day", 12, 6 * 24 * 60],
    ["3p_5h", "Claude & GPT", "five_hour", 0, 300],
    ["3p_weekly", "Claude & GPT", "seven_day", 0, 7 * 24 * 60],
  ]),
};
// `?demo=50`: 46 more accounts across the providers (60 % Claude, 25 % Codex, 15 % Antigravity), in
// ten work groups with a few personal and own-workspace ones, each with a reading, so the Accounts
// list's hierarchy, sort orders and limits all have something to show.
if (new URLSearchParams(location.search).get("demo") === "50") {
  const ownWorkspace = new Set([9, 22, 37]);
  for (let i = 4; i < 50; i++) {
    const id = `preview-account-${i}`;
    const slot = (i - 4) % 20;
    const provider = slot < 12 ? "claude" : slot < 17 ? "codex" : "antigravity";
    const personal = i % 7 === 0;
    accounts.push({
      id,
      name: `Workspace ${String(i + 1).padStart(2, "0")} · ${i % 2 ? "Consulting" : "Product"}`,
      kind: personal ? "personal" : "work",
      group: personal ? "personal" : ownWorkspace.has(i) ? `work:${id}` : `work:team-${i % 10}`,
      color: ["terra", "olive", "blue", "plum"][i % 4],
      provider,
      createdAt: new Date().toISOString(),
      auth: {
        loggedIn: true,
        checkedAt: new Date().toISOString(),
        email: `workspace${i + 1}@example.test`,
        orgName: personal ? "Personal workspace" : `Team ${i % 10}`,
      },
    });
    previewProviderUsage[id] = {
      accountId: id,
      status: "ready",
      stale: false,
      checkedAt: minutes(-1),
      fiveHour: { usedPercent: (i * 37) % 100, resetsAt: minutes(((i % 5) + 1) * 60) },
    };
  }
}
const sessions: Session[] = [
  ["Ödeme akışını sadeleştir", "storefront", 0, 32, true],
  ["Tasarım sistemine son dokunuşlar", "design-system", 2, 18, true],
  ["API yanıtlarını önbelleğe al", "relay-api", 1, 46, false],
  ["Onboarding deneyimini iyileştir", "client-portal", 3, 24, false],
  ["Arama sonuçlarına filtre ekle", "storefront", 0, 12, false],
  ["Haftalık rapor otomasyonu", "automations", 1, 9, false],
].map(([title, projectName, account, messages, pinned], i) => ({
  key: `preview:${i}`,
  id: `preview-${i}`,
  title: String(title),
  projectName: String(projectName),
  projectDir: `/örnek/projeler/${projectName}`,
  accountId: ids[Number(account)],
  messages: Number(messages),
  pinned: Boolean(pinned),
  bytes: 18_000,
  updatedAt: new Date(Date.now() - (i + 1) * 1200_000).toISOString(),
}));
// 30 days of sample polls: most days open one window per connected account at
// a varying hour, polled every 10 minutes for two hours; some windows fill up.
function previewSamples(): UsageSample[] {
  const minute = 60_000;
  const hour = 60 * minute;
  const today = Math.floor(Date.now() / hour) * hour;
  const samples: UsageSample[] = [];
  accounts.forEach((account, index) => {
    for (let day = 0; day < 30; day++) {
      if ((day + index) % 4 === 3) continue;
      const opened =
        today - day * 24 * hour - ((day * 5 + index * 3) % 9) * hour;
      if (opened + 2 * hour > Date.now()) continue;
      const step = 4 + ((day + index * 7) % 9);
      for (let i = 0; i <= 12; i++) {
        const sample = usageSample(account, {
          accountId: account.id,
          status: "ready",
          stale: false,
          checkedAt: new Date(opened + i * 10 * minute).toISOString(),
          fiveHour: {
            usedPercent: Math.min(100, i * step),
            resetsAt: new Date(opened + 5 * hour).toISOString(),
          },
        });
        if (sample) samples.push(sample);
      }
    }
  });
  return samples;
}
// 30 days of token usage for the first three accounts: a few days estimated
// from limit samples, some usage in a terminal outside Relay, and some from an
// account Relay could not tell.
function previewTokenLedger(): LedgerSnapshot {
  const day = 86_400_000;
  const today = Date.parse(
    `${localDate(Date.now(), state.settings.planning.timeZone)}T00:00:00Z`,
  );
  const counts = (weight: number, share: number): TokenCounts => ({
    input: Math.round(weight * share * 12_000),
    output: Math.round(weight * share * 95_000),
    cacheWrite: Math.round(weight * share * 640_000),
    cacheRead: Math.round(weight * share * 9_800_000),
    responses: Math.round(weight * share * 140),
  });
  const priced = (model: string, c: TokenCounts): TokenCounts => ({
    ...c,
    cost: estimateCost(model, c) ?? 0,
    unpriced: 0,
  });
  const days: LedgerSnapshot["days"] = {};
  for (let ago = 0; ago < 30; ago++) {
    const date = new Date(today - ago * day).toISOString().slice(0, 10);
    const byWho: LedgerSnapshot["days"][string] = {};
    ids.slice(0, 3).forEach((id, index) => {
      if ((ago + index) % 5 === 4) return;
      const weight = 1 + ((ago * 7 + index * 3) % 5);
      const estimated = index > 0 && ago >= 12 && ago <= 16;
      byWho[`${estimated ? "est" : "acct"}:${id}`] = {
        "claude-opus-4-7": priced("claude-opus-4-7", counts(weight, 0.65)),
        "claude-sonnet-4-6": priced("claude-sonnet-4-6", counts(weight, 0.35)),
        ...(ago % 4 === 0
          ? { "claude-haiku-4-5": priced("claude-haiku-4-5", counts(weight, 0.1)) }
          : {}),
      };
    });
    if (ago % 3 === 0)
      byWho.terminal = {
        "claude-opus-4-7": priced("claude-opus-4-7", counts(1 + (ago % 4), 0.5)),
      };
    if (ago % 6 === 2)
      byWho.unknown = {
        "claude-sonnet-4-6": priced("claude-sonnet-4-6", counts(1 + (ago % 3), 0.3)),
      };
    days[date] = byWho;
  }
  // Today up to now and all of yesterday, in quarter hours: quiet nights, busy afternoons.
  const zone = state.settings.planning.timeZone;
  const slots: NonNullable<LedgerSnapshot["slots"]> = {};
  const now = localSlot(Date.now(), zone);
  for (const ago of [0, 1]) {
    const date = new Date(today - ago * day).toISOString().slice(0, 10);
    const bySlot: Record<string, NonNullable<LedgerSnapshot["slots"]>[string][string][string]> = {};
    for (let slot = 0; slot < 96; slot++) {
      if (ago === 0 && slot > now) break;
      const hour = slot / 4;
      const busy = hour < 8 ? 0 : Math.max(0, Math.sin(((hour - 8) / 14) * Math.PI));
      const cost = busy * (ago === 0 ? 9 : 6) * (0.6 + 0.4 * Math.abs(Math.sin(slot * 1.7)));
      if (cost > 0.01)
        bySlot[slot] = { input: 0, output: 0, cacheWrite: 0, cacheRead: Math.round(cost * 2e6), cost };
    }
    slots[date] = { [`acct:${ids[0]}`]: bySlot };
  }
  return {
    days,
    slots,
    slotsSince: today - 10 * day,
    progress: { scannedBytes: 1, totalBytes: 1, complete: true },
  };
}
const state: Snapshot = {
  settings: structuredClone(DEFAULT_SETTINGS),
  usage: Object.fromEntries(
    accounts.map((a, i) => [
      a.id,
      previewProviderUsage[a.id] ??
      (!a.auth?.loggedIn
        ? {
            accountId: a.id,
            status: "idle",
            stale: false,
            issue: "connect-cli",
          }
        : {
            accountId: a.id,
            status: i === 2 ? "error" : "ready",
            stale: i === 2,
            checkedAt: new Date(
              Date.now() - (i === 2 ? 50 : 1) * 60_000,
            ).toISOString(),
            // Read through each account's own sign-in: the limit rows' tooltips say "Official API".
            source: "cli",
            fiveHour: {
              usedPercent: [94, 22, 63, 100][i % 4],
              resetsAt: new Date(Date.now() + 110 * 60_000).toISOString(),
            },
            sevenDay: {
              usedPercent: [68, 35, 82, 57][i % 4],
              // Weeks that end on different days, as real accounts' do.
              resetsAt: new Date(Date.now() + [2, 1.2, 4, 6][i % 4] * 86400_000).toISOString(),
            },
            // Fable's own weekly limit (half of the week): near on the first, spent on the second.
            ...(i < 2
              ? {
                  modelWindows: [
                    {
                      key: "seven_day_fable",
                      label: "Fable",
                      model: "fable",
                      usedPercent: [88, 100][i],
                      resetsAt: new Date(Date.now() + [2, 1.2][i] * 86400_000).toISOString(),
                      weeklyShare: 50,
                    },
                  ],
                }
              : {}),
            ...(i === 2
              ? {
                  issue: "unavailable",
                  retryAt: new Date(Date.now() + 5 * 60_000).toISOString(),
                }
              : {}),
          }),
    ]),
  ),
  // The Antigravity app is signed in with the first Antigravity account, the one with a spent model.
  // Both app sign-ins are kept, so the preview can show a switch.
  antigravity: { installed: true, canOpen: false, accountId: otherIds.ag1, canSwitch: true, saved: [otherIds.ag1, otherIds.ag2] },
  accounts,
  authFlows: [],
  sessions,
  runs: [],
  importEnabled: false,
  warnings: [],
  diagnostics: {
    platform: "preview",
    desktopSupported: false,
    // A recent CLI, so the default preview has nothing left to set up.
    executable: "/örnek/bin/claude",
    version: "2.1.300 (Claude Code)",
    dataDir: "Masaüstü uygulamasında yerel olarak saklanır",
  },
};
/** The menu bar title's items, kept in memory so Settings can be tried in the preview. */
let previewMenuBar: MenuBarItem[] = [...DEFAULT_MENU_BAR_ITEMS];
/** Whether the preview's Claude Code status line shows Relay. */
let previewStatusline = false;
const desktopOnly = async (): Promise<never> => {
  throw new Error(
    "Bu bir arayüz önizlemesi. Gerçek hesap ve terminal işlemleri için Relay masaüstü uygulamasını aç.",
  );
};
const desktop: DesktopState = {
  available: true,
  running: true,
  currentAccountUuid: ids[0],
  activeProfileId: ids[0],
  organizations: [ids[2]],
  busy: false,
  recoveryRequired: false,
  errorRevision: 0,
};
// Local development scenarios exercise UI states without touching real accounts.
const scenario = import.meta.env.DEV
  ? new URLSearchParams(location.search).get("scenario")
  : null;
// The macOS-only parts of Settings, such as the menu bar's items.
if (scenario === "macos") state.diagnostics.platform = "darwin";
// The second Antigravity account's app sign-in is not kept yet: the row offers to save it.
if (scenario === "antigravity-unsaved") state.antigravity = { ...state.antigravity!, saved: [otherIds.ag1] };
// Drafts rescued at a switch: two still waiting to be typed back, one left for Copy.
if (scenario === "drafts")
  state.drafts = [
    { id: "11111111-1111-4111-8111-111111111111", to: accounts[0].id, title: "Video pipeline review", newSession: false, attachments: true, state: "pending", capturedAt: new Date().toISOString() },
    { id: "22222222-2222-4222-8222-222222222222", to: accounts[0].id, title: "Weekly roadmap", newSession: false, attachments: false, state: "pending", capturedAt: new Date().toISOString() },
    { id: "33333333-3333-4333-8333-333333333333", to: accounts[0].id, title: "Release notes", newSession: false, attachments: false, state: "needs-copy", reason: "busy", capturedAt: new Date().toISOString() },
  ];
// The panel's offer to bring the Claude extension along; Switch clears it.
if (scenario === "extension-offer")
  state.extension = {
    accountId: accounts[0].id,
    to: accounts[0].name,
    on: accounts[1].name,
    browser: "Brave",
  };
if (scenario === "unlinked" || scenario === "unlinked-no-code") {
  for (const account of accounts) delete account.desktop;
  desktop.activeProfileId = undefined;
  desktop.currentAccountUuid = ids[3];
  desktop.error =
    "Claude Desktop did not close. Finish running work and quit Claude, then try again. No files changed.";
  desktop.errorRevision = 1;
  if (scenario === "unlinked-no-code") desktop.organizations = [];
}
if (scenario?.startsWith("login-")) {
  const status = scenario.slice(6) as AuthFlow["status"];
  if (
    [
      "starting",
      "waiting",
      "verifying",
      "connected",
      "failed",
      "cancelled",
    ].includes(status)
  ) {
    delete accounts[3].desktop;
    accounts[3].auth = {
      loggedIn: status === "connected",
      checkedAt: new Date().toISOString(),
    };
    state.authFlows = [
      {
        id: "preview-login",
        accountId: ids[3],
        status,
        browserReady: status !== "starting",
        codeRequested: status === "waiting",
        windowAvailable: true,
        startedAt: new Date().toISOString(),
        error:
          status === "failed"
            ? "Sign-in timed out. Reconnect to continue."
            : undefined,
      },
    ];
  }
}
if (scenario === "desktop-login") {
  desktop.pendingProfileId = ids[3];
  desktop.currentAccountUuid = undefined;
  desktop.activeProfileId = undefined;
  desktop.organizations = [];
}
if (scenario === "mixed-connections") {
  delete accounts[1].desktop;
  state.usage[ids[1]] = {
    accountId: ids[1],
    status: "error",
    stale: false,
    issue: "expired",
  };
}
if (scenario === "duplicate") {
  accounts[3].auth = { ...accounts[0].auth! };
}
if (scenario === "identity-mismatch") {
  accounts[1].auth!.accountUuid = ids[3];
  accounts[1].auth!.orgId = ids[3];
}
if (scenario === "recovery") desktop.recoveryRequired = true;
// A saved Claude sign-in that claude.ai refused at a switch.
if (scenario === "sign-in-ended" && accounts[1].desktop)
  accounts[1].desktop.rejectedAt = new Date().toISOString();
// Danışmanlık gets its Claude app sign-in: an account whose limit is full, with its tinted switch.
if (scenario === "limit-full")
  accounts[3].desktop = {
    accountUuid: ids[3],
    orgId: ids[3],
    savedAt: new Date().toISOString(),
  };
// The open account's reading has grown old: faded rings and the "Limit verisi eski" line.
if (scenario === "stale-usage") {
  const u = state.usage[ids[0]];
  u.stale = true;
  u.checkedAt = new Date(Date.now() - 5 * 60_000).toISOString();
  delete u.sevenDay;
}
// A new friend's Mac: no account, no CLI, Code never opened; `first-run-no-claude` lacks the app too.
if (scenario === "first-run" || scenario === "first-run-no-claude") {
  accounts.splice(0);
  state.usage = {};
  desktop.available = scenario === "first-run";
  desktop.running = scenario === "first-run";
  desktop.currentAccountUuid = scenario === "first-run" ? ids[3] : undefined;
  desktop.activeProfileId = undefined;
  desktop.organizations = [];
  state.diagnostics = {
    platform: "preview",
    desktopSupported: false,
    dataDir: state.diagnostics.dataDir,
    error:
      "Claude Code bulunamadı. Claude uygulamasında Code’u bir kez aç (Claude Code’u kendisi indirir) veya Ayarlar → Gelişmiş → Claude Code CLI → Dosyayı seç ile dosyasını göster.",
  };
}
if (scenario === "planning" || scenario === "film-planning") {
  accounts[0].planning = { plan: "max5", capacityWeight: 5 };
  accounts[1].planning = { plan: "pro", capacityWeight: 1 };
  accounts[2].planning = { plan: "team", capacityWeight: 2 };
  state.settings.planning = {
    ...state.settings.planning,
    autoStart: true,
    weekday: { enabled: true, start: "09:00", end: "18:00" },
    weekend: { enabled: true, start: "10:00", end: "18:00" },
    accounts: ids.slice(0, 3).map((id) => ({ id })),
  };
  const hour = 3_600_000;
  // Today runs 1.6× the plan's pace, so the keeper moved the second account's
  // next start 90 minutes out; its window is closed until then.
  const adoptedStart = new Date(Date.now() + 90 * 60_000).toISOString();
  state.usage[ids[1]] = {
    ...state.usage[ids[1]],
    fiveHour: { usedPercent: 0 },
  };
  // A learned busy day: quieter at lunch, flat at the weekend.
  const busy: Record<number, number> = {
    9: 220,
    10: 242,
    11: 242,
    12: 110,
    13: 198,
    14: 242,
    15: 242,
    16: 220,
    17: 154,
  };
  state.planning = {
    enabled: true,
    running: false,
    plannedToday: 0,
    tempo: {
      source: "learned",
      weekday: Array.from({ length: 24 }, (_, h) => busy[h] ?? 205),
      weekend: Array.from({ length: 24 }, () => 205),
      rate: { weekday: 205, weekend: 205 },
      days: { weekday: 15, weekend: 2 },
    },
    accounts: [
      {
        accountId: ids[0],
        state: "active",
        resetsAt: new Date(Date.now() + 2 * hour).toISOString(),
      },
      {
        accountId: ids[1],
        state: "waiting",
        reason: "adapted",
        nextStartAt: adoptedStart,
      },
      { accountId: ids[2], state: "waiting", reason: "cooldown" },
    ],
    attempts: [
      {
        id: "preview-2",
        accountId: ids[2],
        identityKey: "preview",
        at: new Date(Date.now() - 6 * 60_000).toISOString(),
        status: "failed",
        reason: "routine-credentials-unavailable",
      },
      {
        id: "preview-1",
        accountId: ids[0],
        identityKey: "preview",
        at: new Date(Date.now() - 3 * hour).toISOString(),
        status: "verified",
      },
    ],
    adaptation: {
      factor: 1.6,
      observedRate: 330,
      schedule: [{ accountId: ids[1], startAt: adoptedStart }],
      since: new Date().toISOString(),
    },
  };
}
// The launch film (media/demo): Personal · Max is full and the panel suggests Personal · Backup;
// `film-before` is the minute before it fills, `film-switched` the same afternoon after Switch,
// `film-planning` adds the planning setup.
const film = ["film", "film-before", "film-switched", "film-planning"].includes(scenario ?? "");
if (film) {
  state.diagnostics.platform = "darwin";
  state.usage[ids[0]].fiveHour!.usedPercent = scenario === "film-before" ? 97 : 100;
  state.usage[ids[1]] = {
    ...state.usage[ids[1]],
    fiveHour: { usedPercent: 22, resetsAt: minutes(110) },
    modelWindows: [{ ...state.usage[ids[1]].modelWindows![0], usedPercent: 41 }],
  };
  state.usage[ids[2]] = {
    ...state.usage[ids[2]],
    status: "ready",
    stale: false,
    checkedAt: minutes(-1),
    issue: undefined,
    retryAt: undefined,
  };
  if (scenario === "film-switched" || scenario === "film-planning") {
    desktop.activeProfileId = ids[1];
    desktop.currentAccountUuid = ids[1];
  }
  // The afternoon at the planned pace, with every window open since the switch.
  if (scenario === "film-planning" && state.planning) {
    delete state.planning.adaptation;
    const tempo = state.planning.tempo!;
    tempo.weekday = tempo.weekday.map((rate) => Math.round(rate * 0.7));
    state.planning.accounts = ids.slice(0, 3).map((accountId, i) => ({
      accountId,
      state: "active" as const,
      resetsAt: minutes([110, 110, 146][i]),
    }));
  }
}
if (scenario === "auto-waiting" || scenario === "auto-prepared") {
  state.settings.desktopHistoryTransfer = "selected";
  state.settings.desktopHistoryAccounts = ids.slice(0, 3);
  state.settings.autoSwitchMode = "after-exit";
  state.settings.autoSwitchAccounts = ids.slice(0, 3);
  state.usage[ids[0]].fiveHour!.usedPercent = 100;
  state.autoSwitch = {
    status: scenario === "auto-prepared" ? "switched" : "waiting",
    reason: scenario === "auto-prepared" ? "prepared" : "claude-running",
    sourceId: ids[0],
    targetId: ids[1],
    checkedAt: new Date().toISOString(),
  };
  if (scenario === "auto-prepared") {
    desktop.running = false;
    desktop.activeProfileId = ids[1];
    desktop.currentAccountUuid = ids[1];
  }
}
// Continue at quota with the open account full: other work keeps it waiting,
// or nothing stopped at the limit. Claude stays open in both.
if (scenario === "fleet-waiting" || scenario === "fleet-idle-full") {
  state.usage[ids[0]].fiveHour!.usedPercent = 100;
  desktop.running = true;
  state.fleet =
    scenario === "fleet-waiting"
      ? {
          enabled: true,
          status: "waiting",
          reason: "not-quiescent:busyWorkers",
          sourceId: ids[0],
          targetId: ids[1],
          stopped: 2,
        }
      : {
          enabled: true,
          status: "watching",
          reason: "awaiting-quota-stop",
          sourceId: ids[0],
          targetId: ids[1],
          stopped: 0,
        };
}
// The second account open in a separate Claude window beside the main one: its row offers to
// bring it forward or close it, it cannot be switched to, and automatic switching waits.
if (scenario === "windows") {
  state.diagnostics.platform = "darwin";
  state.windows = {
    supported: true,
    enabled: true,
    open: [{ accountId: accounts[1].id, openedAt: Date.now() - 25 * 60_000 }],
    others: 0,
  };
  desktop.windows = 1;
}
/** Relay's own update in the preview: up to date, unless the update scenario says otherwise. */
function previewUpdate(): UpdateState {
  return { status: "up-to-date", current: "0.15.0", autoCheck: true, checkedAt: new Date().toISOString() };
}
// A newer Relay downloaded and ready: the banner, the panel row and Settings → Advanced offer it.
if (scenario === "update")
  state.update = {
    ...previewUpdate(),
    status: "ready",
    version: "0.16.0",
    notesUrl: "https://github.com/ahmetcankacar54/relay/releases/tag/v0.16.0",
  };
// The same update on its way, or installing after Update: the sidebar row shows its progress.
if (scenario === "update-download")
  state.update = { ...previewUpdate(), status: "downloading", version: "0.16.0", progress: 0.42 };
if (scenario === "update-install")
  state.update = { ...previewUpdate(), status: "installing", version: "0.16.0" };
/** The lost and found's sources in the preview. */
function previewLostFoundSource() {
  // Two accounts' Claude app sign-ins, with a short visit to the second one last Wednesday.
  const [first, second] = accounts.filter((a) => a.desktop?.accountUuid);
  const wednesday = addDays(
    mondayOf(localDate(Date.now(), state.settings.planning.timeZone)),
    -5,
  );
  const at = (hour: number, minute = 0) =>
    new Date(
      Date.parse(`${wednesday}T00:00:00Z`) + (hour * 60 + minute) * 60_000,
    ).toISOString();
  const segments =
    first?.desktop && second?.desktop
      ? [
          { accountUuid: first.desktop.accountUuid, from: at(9), to: at(11, 10) },
          { accountUuid: second.desktop.accountUuid, from: at(11, 10), to: at(11, 18) },
          { accountUuid: first.desktop.accountUuid, from: at(11, 18), to: at(18) },
        ]
      : [];
  const ledger = previewTokenLedger();
  return {
    rollups: foldSamples(previewSamples(), Date.now()),
    segments,
    ledgerDays: ledger.days,
    ...(ledger.slots ? { ledgerSlots: ledger.slots } : {}),
    ...(ledger.slotsSince === undefined ? {} : { slotsSince: ledger.slotsSince }),
    accounts,
    zone: state.settings.planning.timeZone,
    now: Date.now(),
  };
}

/** The Proxy page in the preview: a gateway that turns on and off in memory, with made-up traffic. */
const previewProxy: {
  running: boolean;
  port: number;
  host: string;
  key: string;
  routingStrategy: "soonest-reset" | "balanced" | "strict-priority";
  affinityTtlSeconds: number;
  order: string[];
  excluded: string[];
  bound: Partial<Record<ProxyClientId, boolean>>;
  subagentOverflow: boolean;
} = {
  running: scenario === "proxy-waiting",
  port: 8317,
  host: "127.0.0.1",
  key: "relay-sec-preview-0000000000000000000000000000",
  routingStrategy: "soonest-reset",
  affinityTtlSeconds: 3_600,
  order: [],
  excluded: [],
  // `?scenario=proxy-waiting` also shows Claude Code bound, as the Overview's gateway line needs.
  bound: scenario === "proxy-waiting" ? { "claude-code": true } : {},
  subagentOverflow: false,
};
const minutesTo = (iso: string | null | undefined) =>
  iso ? Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 60_000)) : undefined;
const previewOrdered = () => {
  const rank = new Map(previewProxy.order.map((id, i) => [id, i]));
  return accounts
    .map((a, i) => ({ a, key: rank.get(a.id) ?? rank.size + i }))
    .sort((x, y) => x.key - y.key)
    .map((x) => x.a);
};
const previewRecent = (): ProxyRequestLog[] => {
  if (!previewProxy.running || !accounts.length) return [];
  const now = Date.now();
  const first = accounts[0]?.id;
  const second = accounts[1]?.id ?? first;
  const cc = { client: "claude-code" };
  return [
    { at: now - 4_000, accountId: second, provider: "claude", model: "claude-sonnet-4-5", status: 200, affinity: true, ...cc, requestClass: "main", ms: 6_210, tokens: { input: 4, cacheRead: 182_400, cacheWrite: 1_210, output: 860 } },
    { at: now - 31_000, accountId: second, provider: "claude", model: "claude-sonnet-4-5", status: 200, ...cc, requestClass: "subagent", ms: 3_480, tokens: { input: 12, cacheWrite: 24_900, output: 412 }, cost: 0.0998, pick: { reason: "soonest-reset" as const, after: first } },
    { at: now - 31_500, accountId: second, provider: "claude", model: "claude-sonnet-4-5", status: 200, ...cc, requestClass: "main", ms: 7_900, tokens: { input: 4, cacheWrite: 96_400, output: 300 }, cost: 0.583, miss: { reason: "account" as const, tokens: 94_000 }, pick: { reason: "soonest-reset" as const, nearlyFull: [first] } },
    { at: now - 32_000, accountId: first, provider: "claude", model: "claude-sonnet-4-5", status: 429, failover: true, ...cc, requestClass: "subagent", ms: 610, note: "limit", pick: { reason: "bound" as const } },
    { at: now - 70_000, accountId: first, provider: "claude", model: "claude-opus-4-5", status: 429, client: "curl", ms: 220, note: "refused", error: "Error" },
    { at: now - 80_000, accountId: second, provider: "claude", model: "claude-sonnet-4-5", status: 200, ...cc, requestClass: "main", ms: 5_100, tokens: { input: 3, cacheWrite: 41_000, output: 120 }, cost: 0.156, note: "cold-move", miss: { reason: "expired" as const, tokens: 40_800 } },
    { at: now - 95_000, accountId: first, provider: "claude", model: "claude-haiku-4-5", status: 200, affinity: true, client: "agent-sdk", requestClass: "auxiliary", ms: 940, tokens: { input: 1_800, output: 24 } },
    { at: now - 160_000, provider: "codex", model: "gpt-5-codex", status: 503, note: "no-account", client: "codex" },
  ];
};
const previewProxyStatus = (): ProxyStatus => ({
  running: previewProxy.running,
  port: previewProxy.port,
  host: previewProxy.host,
  clientApiKey: previewProxy.key,
  routingStrategy: previewProxy.routingStrategy,
  affinityTtlSeconds: previewProxy.affinityTtlSeconds,
  stats: previewProxy.running
    ? { totalRequests: 128, activeRequests: 2, promptCacheHits: 97, cacheHitRate: 84.5 }
    : { totalRequests: 0, activeRequests: 0, promptCacheHits: 0, cacheHitRate: 0 },
  accounts: previewOrdered().map((a, i) => {
    const five = state.usage[a.id]?.fiveHour;
    const week = state.usage[a.id]?.sevenDay;
    const used = [five?.usedPercent, week?.usedPercent].filter((p): p is number => typeof p === "number");
    const resets = [minutesTo(five?.resetsAt), minutesTo(week?.resetsAt)].filter((m): m is number => m !== undefined);
    return {
      id: a.id,
      name: a.name,
      provider: a.provider ?? "claude",
      ...(a.auth?.email ? { email: a.auth.email } : {}),
      active: previewProxy.running && i === 1,
      signedIn: a.auth?.loggedIn === true,
      ...(used.length ? { quotaPercent: Math.round(Math.max(...used)) } : {}),
      ...(resets.length ? { resetInMinutes: Math.min(...resets) } : {}),
      ...(five ? { fiveHourPercent: Math.round(five.usedPercent) } : {}),
      ...(five?.resetsAt ? { fiveHourResetMinutes: minutesTo(five.resetsAt) } : {}),
      ...(week ? { weeklyPercent: Math.round(week.usedPercent) } : {}),
      ...(week?.resetsAt ? { weeklyResetMinutes: minutesTo(week.resetsAt) } : {}),
      inPool: !previewProxy.excluded.includes(a.id),
      requests: previewProxy.running ? [42, 61, 25][i] ?? 0 : 0,
      ...(previewProxy.running
        ? { tokens: { input: 18_400 * (i + 1), output: 9_100 * (i + 1), cacheRead: 412_000 / (i + 1), cacheWrite: 38_000 } }
        : {}),
      // `?scenario=proxy-waiting`: one account renewing its sign-in, one billed as extra usage.
      ...(previewProxy.running && scenario === "proxy-waiting" && i === 0
        ? { waiting: { reason: "auth" as const, minutes: 1 } }
        : {}),
      ...(previewProxy.running && scenario === "proxy-waiting" && i === 2
        ? { extraUsage: { kind: "billed" as const, minutesAgo: 3 } }
        : {}),
      // `?scenario=proxy-signin`: one saved sign-in the gateway cannot read, one expired.
      ...(previewProxy.running && scenario === "proxy-signin" && i === 0 ? { gatewaySignIn: "missing" as const } : {}),
      ...(previewProxy.running && scenario === "proxy-signin" && i === 2 ? { gatewaySignIn: "expired" as const } : {}),
      ...(previewProxy.running && i === 1 ? { live: true, fullAt: Date.now() + 95 * 60_000 } : {}),
      ...(previewProxy.running ? { percentCost: { dollars: [2.84, 1.51, 1.81][i] ?? 2, windows: [6, 5, 2][i] ?? 3 } } : {}),
    };
  }),
  recent: previewRecent(),
  ...(previewProxy.subagentOverflow ? { subagentOverflow: true } : {}),
  ...(previewProxy.running && accounts.length
    ? {
        nextPick: {
          claude: {
            accountId: accounts[1]?.id ?? accounts[0].id,
            reason: previewProxy.routingStrategy === "strict-priority" ? ("priority" as const) : previewProxy.routingStrategy === "balanced" ? ("balanced" as const) : ("soonest-reset" as const),
            ...(accounts.length > 1 ? { nearlyFull: [accounts[0].id] } : {}),
          },
        },
      }
    : {}),
  ...(previewProxy.running && accounts.length
    ? {
        sessions: [
          { id: "6cf63d7f", accountId: accounts[1]?.id ?? accounts[0].id, model: "claude-sonnet-4-5", lastAt: Date.now() - 4_000, prefixTokens: 183_600, ttlMs: 3_600_000, requests: 48, subagents: 3, misses: 0, moveCost: { dollars: 1.469, percent: 0.65 } },
          { id: "a010e568", accountId: accounts[0].id, model: "claude-sonnet-4-5", lastAt: Date.now() - 18 * 60_000, prefixTokens: 96_200, ttlMs: 3_600_000, requests: 12, subagents: 0, misses: 1, lastMiss: { at: Date.now() - 40 * 60_000, reason: "account" as const, tokens: 94_000 }, moveCost: { dollars: 0.77, percent: 0.34 } },
          { id: "1d3cf2c3", accountId: accounts[0].id, model: "claude-haiku-4-5", lastAt: Date.now() - 75 * 60_000, prefixTokens: 41_000, ttlMs: 300_000, requests: 3, subagents: 0, misses: 0, moveCost: { dollars: 0.051, percent: 0.02 } },
        ],
        classShare: [
          { requestClass: "main", requests: 61, tokens: 4_200_000, cost: 6.12 },
          { requestClass: "subagent", requests: 44, tokens: 1_900_000, cost: 3.4 },
          { requestClass: "auxiliary", requests: 22, tokens: 80_000, cost: 0.09 },
          { requestClass: "compaction", requests: 1, tokens: 160_000, cost: 0.31 },
        ],
        ...(scenario === "proxy-waiting"
          ? { alarms: [{ id: "f5601bf9", sessionId: "6cf63d7f", accountId: accounts[1]?.id ?? accounts[0].id, since: Date.now() - 22 * 60_000, lastAt: Date.now() - 30_000, requests: 312, subagents: 34 }] }
          : {}),
      }
    : {}),
  tailscaleAddress: "100.101.12.34",
  clients: (["claude-code", "codex", "omp"] as const).map((id) => ({
    id,
    installed: true,
    bound: !!previewProxy.bound[id],
    stale: false,
    file:
      id === "claude-code" ? "~/.claude/settings.json" : id === "omp" ? "~/.omp/agent/models.yml" : "~/.codex/config.toml",
  })),
});

export const previewApi: RelayAPI = {
  proxyStatus: async () => previewProxyStatus(),
  proxyToggle: async (enabled) => {
    previewProxy.running = enabled;
    return previewProxyStatus();
  },
  proxyConfigure: async (input) => {
    if (input.port !== undefined) previewProxy.port = input.port;
    if (input.host !== undefined) previewProxy.host = input.host;
    if (input.routingStrategy !== undefined) previewProxy.routingStrategy = input.routingStrategy;
    if (input.affinityTtlSeconds !== undefined) previewProxy.affinityTtlSeconds = input.affinityTtlSeconds;
    if (input.accountOrder !== undefined) previewProxy.order = input.accountOrder;
    if (input.excludedAccountIds !== undefined) previewProxy.excluded = input.excludedAccountIds;
    if (input.subagentOverflow !== undefined) previewProxy.subagentOverflow = input.subagentOverflow;
    return previewProxyStatus();
  },
  proxyBindClient: async (id) => {
    previewProxy.bound[id] = true;
    return previewProxyStatus();
  },
  copyText: async (text) => navigator.clipboard.writeText(text),
  proxyUnbindClient: async (id) => {
    previewProxy.bound[id] = false;
    return previewProxyStatus();
  },
  proxyRegenerateKey: async () => {
    previewProxy.key = `relay-sec-preview-${Math.random().toString(36).slice(2).padEnd(28, "0")}`;
    return previewProxyStatus();
  },
  detectProviders: async () => [
    {
      provider: "claude",
      detected: true,
      email: "account1@example.test",
      accountUuid: ids[0],
      orgId: ids[2],
      orgName: "Personal workspace",
      plan: "Claude Max",
      source: "Claude Desktop",
    },
    {
      provider: "codex",
      detected: true,
      email: "codex@example.test",
      plan: "pro",
      source: "~/.codex/auth.json",
    },
    {
      provider: "antigravity",
      detected: false,
    },
  ],
  // As main answers: Claude waits for the Claude app (the steps continue); Codex is signed in
  // with what its token says and has no limits Relay can read.
  oneClickConnect: async (input) => {
    if (input.provider !== "claude" && input.provider !== "codex") throw new Error("Use Antigravity OAuth");
    const account: Account = {
      id: crypto.randomUUID(),
      name: input.name,
      kind: input.kind,
      group: input.kind === "personal" ? "personal" : `work:${input.group || crypto.randomUUID()}`,
      color: "olive",
      createdAt: new Date().toISOString(),
      provider: input.provider,
      ...(input.provider === "codex"
        ? {
            auth: {
              loggedIn: true,
              checkedAt: new Date().toISOString(),
              ...(input.apiKey ? {} : { email: "codex@example.test" }),
              subscription: input.apiKey ? "API key" : "pro",
            },
          }
        : {}),
    };
    accounts.push(account);
    return {
      account: structuredClone(account),
      layers:
        input.provider === "codex"
          ? { desktop: "skipped", usage: "skipped", terminal: "skipped", extensionAndProxy: "done" }
          : { desktop: "pending", usage: "pending", terminal: "pending", extensionAndProxy: "pending" },
      ...(input.provider === "claude" ? { needsSignIn: true } : {}),
    };
  },
  startAntigravityOAuth: async (input) => {
    const account: Account = {
      id: crypto.randomUUID(), name: input.name, kind: input.kind,
      group: input.kind === "personal" ? "personal" : `work:${input.group || crypto.randomUUID()}`,
      color: "plum", createdAt: new Date().toISOString(), provider: "antigravity",
    };
    accounts.push(account);
    return { accountId: account.id, state: "preview-oauth-state" };
  },
  cancelAntigravityOAuth: async () => {},
  submitAntigravityCallback: async () => {},
  pollAntigravityOAuth: async ({ accountId }) => {
    const account = accounts.find((a) => a.id === accountId)!;
    account.auth = { loggedIn: true, checkedAt: new Date().toISOString(),
      email: "antigravity@example.test", subscription: "Antigravity OAuth" };
    return { status: "ok", result: { account: structuredClone(account),
      layers: { desktop: "skipped", usage: "skipped", terminal: "skipped", extensionAndProxy: "done" } } };
  },
  inspectContinuation: async () => ({
    status: "off",
    reason: "disabled",
    canArm: false,
    enabled: false,
    executable: false,
    observationReason: "preview-only",
  }),
  armContinuation: desktopOnly,
  disarmContinuation: () => previewApi.inspectContinuation(),
  setFleetContinuation: async (enabled) => {
    state.fleet = enabled
      ? {
          enabled: true,
          status: "watching",
          reason: "awaiting-quota-stop",
          sourceId: desktop.activeProfileId,
          stopped: 0,
        }
      : { enabled: false, status: "off" };
    return structuredClone(state.fleet);
  },
  reconcileContinuation: desktopOnly,
  abandonContinuation: desktopOnly,
  requestDesktopAccessibility: desktopOnly,
  copyDraft: desktopOnly,
  dismissDraft: desktopOnly,
  copySidebarRecipe: desktopOnly,
  dismissSidebarGap: desktopOnly,
  updateAccountPlanning: async (id, input) => {
    const account = accounts.find((a) => a.id === id);
    if (!account) throw new Error("Account not found.");
    account.planning = input;
    return structuredClone(account);
  },
  extensionStatus: async () => structuredClone(previewExtension),
  linkExtension: async () => structuredClone(previewExtension),
  checkExtension: async () => {
    previewExtension.current = {
      state: "signed-in",
      accountUuid: ids[0],
      known: true,
      at: new Date().toISOString(),
    };
    return structuredClone(previewExtension);
  },
  syncExtension: async () => {
    delete state.extension;
    return {
      result: "switched" as const,
      at: new Date().toISOString(),
      restarted: true,
      reopened: true,
      saved: true,
    };
  },
  openClaudeWeb: async () => {},
  openExtensionSettings: async () => {},
  terminalStatus: async () => structuredClone(previewTerminal),
  checkTerminal: async () => structuredClone(previewTerminal),
  linkTerminal: async (id: string) => ({
    id: crypto.randomUUID(),
    accountId: id,
    status: "waiting" as const,
    browserReady: true,
    codeRequested: false,
    startedAt: new Date().toISOString(),
  }),
  cancelTerminalLink: async () => undefined,
  syncTerminal: async () => ({
    result: "switched" as const,
    saved: true,
    at: new Date().toISOString(),
  }),
  setLanguage: async () => {},
  getLanguage: async () => ({ pref: "system" as const, locale: resolveLocale("system", navigator.languages) }),
  showDiagnostics: desktopOnly,
  exportDiagnostics: desktopOnly,
  // The backup dialog runs through in the preview; nothing is written or read.
  exportBackup: async ({ includeSignIns }) => ({
    accounts: state.accounts.length,
    signIns: includeSignIns ? state.accounts.length : 0,
  }),
  chooseBackup: async () => ({ name: "relay-2026-11-23.relaybackup" }),
  openBackup: async () => ({
    createdAt: new Date().toISOString(),
    relayVersion: "0.29.0",
    platform: "darwin",
    signIns: true,
    currentAccounts: state.accounts.length,
    accounts: state.accounts.map((account) => ({
      name: account.name,
      provider: account.provider ?? "claude",
      signIn: true,
      present: true,
    })),
  }),
  importBackup: async (mode) => ({
    mode,
    added: mode === "replace" ? state.accounts.length : 0,
    skipped: mode === "merge" ? state.accounts.length : 0,
    signIns: mode === "replace" ? state.accounts.length : 0,
    signInsFailed: 0,
    ...(mode === "replace" ? { before: "before-import-2026-11-23.relaybackup" } : {}),
  }),
  cancelBackup: async () => {},
  resetData: desktopOnly,
  claudeLaunch: async () => ({ quicOff: false }),
  setClaudeLaunch: desktopOnly,
  checkUpdate: async () => {
    const update: UpdateState = {
      ...(state.update ?? previewUpdate()),
      status: "up-to-date",
      checkedAt: new Date().toISOString(),
    };
    state.update = update;
    return structuredClone(update);
  },
  installUpdate: desktopOnly,
  setUpdateAuto: async (enabled) => {
    state.update = { ...(state.update ?? previewUpdate()), autoCheck: enabled };
  },
  openUpdateNotes: async () => {},
  // The preview registers no global shortcuts.
  pauseShortcuts: async () => {},
  setSeparateWindows: async (enabled) => {
    state.windows = { supported: true, open: [], others: 0, ...state.windows, enabled };
  },
  openWindow: async (accountId) => {
    const windows = state.windows;
    if (!windows?.enabled) return desktopOnly();
    if (windows.open.some((w) => w.accountId === accountId)) return "shown";
    windows.open.push({ accountId, openedAt: Date.now() });
    desktop.windows = windows.open.length;
    return "opened";
  },
  closeWindow: async (accountId) => {
    const windows = state.windows;
    if (!windows) return;
    windows.open = windows.open.filter((w) => w.accountId !== accountId);
    desktop.windows = windows.open.length || undefined;
  },
  menuBarTitle: async () => ({ items: [...previewMenuBar] }),
  setMenuBarTitle: async (choice) => {
    previewMenuBar = menuBarItems(choice.items);
    return { items: [...previewMenuBar] };
  },
  // No menu bar in the browser: Settings shows its samples.
  menuBarNow: async () => undefined,
  onChanged: () => () => {},
  openPage: async (page, intent) => {
    location.hash = intentHash(page, intent);
  },
  onNavigate: () => () => {},
  takeSwitchRequest: async () => undefined,
  onSwitchRequest: () => () => {},
  setPanelHeight: () => {},
  closePanel: () => {},
  // The browser preview shows the panel page as an open tab.
  onPanelVisibility: (callback) => {
    callback(true);
    return () => {};
  },
  quit: async () => {},
  updatePlanning: async (patch) => {
    state.settings.planning = { ...state.settings.planning, ...patch };
    return structuredClone(state.settings.planning);
  },
  updateSettings: async (patch) => {
    Object.assign(state.settings, patch);
    state.autoSwitch =
      state.settings.autoSwitchMode === "off"
        ? { status: "off", reason: "disabled" }
        : state.autoSwitch?.status === "waiting" ||
            state.autoSwitch?.status === "switched"
          ? state.autoSwitch
          : {
              status: "watching",
              reason: "quota-available",
              sourceId: desktop.activeProfileId,
            };
    return structuredClone(state.settings);
  },
  acknowledgeRisk: async (ids) => {
    state.settings.riskAcknowledged = acknowledgeRisks(state.settings.riskAcknowledged, ids);
    return structuredClone(state.settings);
  },
  refreshUsage: async (id) => structuredClone(state.usage[id]),
  claudeAppAccess: async () => ({ supported: true, allowed: false }),
  claudeStatusline: async (enable) => {
    if (enable !== undefined) previewStatusline = enable;
    return { installed: previewStatusline, other: false, cli: "/opt/homebrew/bin/relay" };
  },
  renewSignInNow: async () => ({ result: "unavailable" as const, detail: "preview" }),
  desktopSnapshot: async () => ({
    ...structuredClone(desktop),
    proxyStatus: previewProxyStatus(),
  }),
  dismissDesktopError: async (revision) => {
    if (revision === desktop.errorRevision) desktop.error = undefined;
  },
  captureDesktop: desktopOnly,
  beginDesktopLogin: desktopOnly,
  cancelDesktopLogin: desktopOnly,
  switchDesktop: desktopOnly,
  syncDesktopHistory: desktopOnly,
  desktopHistorySummary: async (id) => ({
    profileId: id,
    indexed: 12,
    archived: 2,
    projects: 3,
    transcriptsFound: 10,
    missingTranscripts: 1,
    unknownTranscripts: 1,
    duplicates: 0,
    sourceProfiles: 0,
    checkedAt: new Date().toISOString(),
  }),
  openDesktop: desktopOnly,
  openCodeTab: desktopOnly,
  openAntigravity: desktopOnly,
  // The preview moves its Antigravity app at once; the real one closes and opens the app.
  switchAntigravity: async (accountId) => {
    const at = Date.now();
    state.antigravity = { ...state.antigravity!, accountId, result: { kind: "switched", accountId, agyRunning: 1, at } };
    return state.antigravity.result!;
  },
  saveAntigravitySignIn: async (accountId) => {
    state.antigravity = { ...state.antigravity!, busy: "signing-in", signInFor: accountId };
  },
  cancelAntigravitySignIn: async () => {
    const { busy: _busy, signInFor, ...rest } = state.antigravity!;
    state.antigravity = { ...rest, result: { kind: "cancelled", accountId: signInFor ?? "", at: Date.now() } };
  },
  armAutoCapture: desktopOnly,
  disarmAutoCapture: async () => {},
  chooseAutoCaptureOrg: desktopOnly,
  recoverDesktop: desktopOnly,
  panelSnapshot: async () => structuredClone(state),
  usageStatistics: async ({ range, accountId }) =>
    buildStatisticsView({
      rollups: foldSamples(previewSamples(), Date.now()),
      available: true,
      accounts,
      range,
      ...(accountId ? { accountId } : {}),
      zone: state.settings.planning.timeZone,
      hours: { weekday: state.settings.planning.weekday, weekend: state.settings.planning.weekend },
      now: Date.now(),
    }),
  tokenUsage: async ({ range, accountId }) =>
    buildTokenUsageView({
      ledger: previewTokenLedger(),
      accounts,
      range,
      ...(accountId ? { accountId } : {}),
      zone: state.settings.planning.timeZone,
      now: Date.now(),
      exactSince: Date.now() - 12 * 86_400_000,
    }),
  lostFoundCollection: async () =>
    lostFoundCollection(previewLostFoundSource()),
  snapshot: async () => structuredClone(state),
  createAccount: async (input) => {
    if (scenario !== "unlinked-no-code" && scenario !== "mixed-connections")
      return desktopOnly();
    const account: Account = {
      id: crypto.randomUUID(),
      name: input.name,
      kind: input.kind,
      group:
        input.kind === "personal"
          ? "personal"
          : `work:${input.group || crypto.randomUUID()}`,
      color: "olive",
      createdAt: new Date().toISOString(),
    };
    accounts.push(account);
    state.usage[account.id] = {
      accountId: account.id,
      status: "idle",
      stale: false,
      issue: "connect-cli",
    };
    return structuredClone(account);
  },
  // Edits the sample account in memory, as the app's store does.
  updateAccount: async (id, input) => {
    const account = accounts.find((a) => a.id === id);
    if (!account) throw new Error("Hesap bulunamadı.");
    account.name = input.name.trim();
    account.kind = input.kind;
    account.group = input.kind === "personal" ? "personal" : `work:${input.group?.trim() || id}`;
    if (input.provider !== undefined) account.provider = input.provider;
    return structuredClone(account);
  },
  // Forgets the sample account in memory, refusing the open one as the app does.
  removeAccount: async (id) => {
    if (id === desktop.activeProfileId)
      throw new Error(
        "Switch the Claude app to another account before removing this one.",
      );
    const index = accounts.findIndex((a) => a.id === id);
    if (index < 0) throw new Error("Hesap bulunamadı.");
    const [removed] = accounts.splice(index, 1);
    delete state.usage[id];
    return removed.auth?.loggedIn ? { signedOut: true } : {};
  },
  checkAuth: desktopOnly,
  login: async (id) => {
    const flow =
      scenario?.startsWith("login-") &&
      state.authFlows.find((f) => f.accountId === id);
    return flow ? structuredClone(flow) : desktopOnly();
  },
  reopenLogin: desktopOnly,
  cancelLogin: desktopOnly,
  submitLoginCode: desktopOnly,
  closeRun: desktopOnly,
  onAuth: () => () => {},
  launch: desktopOnly,
  switchAccount: desktopOnly,
  pickFolder: desktopOnly,
  pickExecutable: desktopOnly,
  pickClaudeApp: desktopOnly,
  importHistory: desktopOnly,
  setPinned: async (key, pinned) => {
    const s = sessions.find((s) => s.key === key);
    if (s) s.pinned = pinned;
  },
  setCooldown: async (id, hours) => {
    const a = accounts.find((a) => a.id === id);
    if (a)
      a.cooldownUntil = hours
        ? new Date(Date.now() + hours * 3600_000).toISOString()
        : undefined;
  },
  transcript: async () => [
    {
      role: "user",
      text: "Bu alanda seçtiğin oturumun son 60 metin mesajı gösterilir.",
    },
    {
      role: "assistant",
      text: "Bu örnek bir konuşma önizlemesidir. Masaüstü uygulaması, gerçek oturum geçmişini yalnızca bilgisayarındaki Claude Code dosyalarından okur.",
    },
  ],
  terminalBuffer: desktopOnly,
  terminalWrite: () => {},
  terminalResize: () => {},
  stop: desktopOnly,
  onTerminal: () => () => {},
};
