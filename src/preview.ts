import { DEFAULT_SETTINGS } from "../shared/types";
import { intentHash } from "./app/routes";
import { usageSample, type UsageSample } from "../shared/usage-statistics";
import { foldSamples } from "../shared/usage-rollups";
import { buildStatisticsView } from "../shared/usage-statistics-view";
import type {
  Account,
  AuthFlow,
  DesktopState,
  RelayAPI,
  Session,
  Snapshot,
} from "../shared/types";
// Browser preview is deliberately explicit and never communicates with the machine.
const ids = [
  "fd7f91c2-1bbf-45e0-a11a-37bfe318fd3a",
  "d2f616b5-a4b1-47ad-8b56-ec77bc2f51f6",
  "ebd5376e-923a-40f7-8118-08da5bf22319",
  "f5627ec9-aae3-41f8-9527-b3a88c675a76",
];
const accounts: Account[] = [
  {
    id: ids[0],
    name: "Kişisel · Max",
    kind: "personal",
    group: "personal",
    color: "terra",
  },
  {
    id: ids[1],
    name: "Kişisel · İkinci",
    kind: "personal",
    group: "personal",
    color: "olive",
  },
  {
    id: ids[2],
    name: "Studio",
    kind: "work",
    group: "work:studio",
    color: "blue",
  },
  {
    id: ids[3],
    name: "Danışmanlık",
    kind: "work",
    group: "work:consulting",
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
if (new URLSearchParams(location.search).get("demo") === "50") {
  for (let i = 4; i < 50; i++)
    accounts.push({
      id: `preview-account-${i}`,
      name: `Workspace ${String(i + 1).padStart(2, "0")} · ${i % 2 ? "Consulting" : "Product"}`,
      kind: "work",
      group: `work:team-${i % 5}`,
      color: ["terra", "olive", "blue", "plum"][i % 4],
      createdAt: new Date().toISOString(),
    });
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
const state: Snapshot = {
  settings: structuredClone(DEFAULT_SETTINGS),
  usage: Object.fromEntries(
    accounts.map((a, i) => [
      a.id,
      !a.auth?.loggedIn
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
            fiveHour: {
              usedPercent: [94, 22, 63, 100][i % 4],
              resetsAt: new Date(Date.now() + 110 * 60_000).toISOString(),
            },
            sevenDay: {
              usedPercent: [68, 35, 82, 57][i % 4],
              resetsAt: new Date(Date.now() + 2 * 86400_000).toISOString(),
            },
            ...(i === 2
              ? {
                  issue: "unavailable",
                  retryAt: new Date(Date.now() + 5 * 60_000).toISOString(),
                }
              : {}),
          },
    ]),
  ),
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
      "Claude Code bulunamadı. Resmi CLI’yi kur veya Ayarlar → Claude Code CLI → Dosyayı seç ile dosyasını göster.",
  };
}
if (scenario === "planning") {
  accounts[0].planning = { plan: "max5", capacityWeight: 5 };
  accounts[1].planning = { plan: "pro", capacityWeight: 1 };
  accounts[2].planning = { plan: "team", capacityWeight: 2 };
  state.settings.planning = {
    ...state.settings.planning,
    autoStart: true,
    weekday: { enabled: true, start: "09:00", end: "18:00" },
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
export const previewApi: RelayAPI = {
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
  updateAccountPlanning: async (id, input) => {
    const account = accounts.find((a) => a.id === id);
    if (!account) throw new Error("Account not found.");
    account.planning = input;
    return structuredClone(account);
  },
  setTrayLanguage: async () => {},
  showDiagnostics: desktopOnly,
  onChanged: () => () => {},
  openPage: async (page, intent) => {
    location.hash = intentHash(page, intent);
  },
  onNavigate: () => () => {},
  setPanelHeight: () => {},
  closePanel: () => {},
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
  refreshUsage: async (id) => structuredClone(state.usage[id]),
  desktopSnapshot: async () => structuredClone(desktop),
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
      now: Date.now(),
    }),
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
