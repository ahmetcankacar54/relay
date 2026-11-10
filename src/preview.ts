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
/** Brave (used last) and Chrome with the extension; signed in and saved for the first account only. */
const previewExtension: ExtensionStatus = {
  setting: { mode: "guide" },
  instances: [
    { app: "chrome", profile: "Default", name: "Kişi 1", opened: true, usedAt: Date.now() - 9 * 86_400_000 },
    { app: "brave", profile: "Default", name: "Kişisel", opened: true, usedAt: Date.now() - 60_000 },
  ],
  target: { app: "brave", profile: "Default", name: "Kişisel", opened: true },
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
/** The menu bar title's items, kept in memory so Settings can be tried in the preview. */
let previewMenuBar: MenuBarItem[] = [...DEFAULT_MENU_BAR_ITEMS];
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
} = {
  running: false,
  port: 8317,
  host: "127.0.0.1",
  key: "relay-sec-preview-0000000000000000000000000000",
  routingStrategy: "soonest-reset",
  affinityTtlSeconds: 3_600,
  order: [],
  excluded: [],
  bound: {},
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
  return [
    { at: now - 4_000, accountId: second, provider: "claude", model: "claude-sonnet-4-5", status: 200, affinity: true },
    { at: now - 31_000, accountId: second, provider: "claude", model: "claude-sonnet-4-5", status: 200 },
    { at: now - 32_000, accountId: first, provider: "claude", model: "claude-sonnet-4-5", status: 429, failover: true },
    { at: now - 95_000, accountId: first, provider: "claude", model: "claude-haiku-4-5", status: 200, affinity: true },
    { at: now - 160_000, provider: "codex", model: "gpt-5-codex", status: 503, note: "no-account" },
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
    };
  }),
  recent: previewRecent(),
  tailscaleAddress: "100.101.12.34",
  clients: (["claude-code", "codex"] as const).map((id) => ({
    id,
    installed: true,
    bound: !!previewProxy.bound[id],
    stale: false,
    file: id === "claude-code" ? "~/.claude/settings.json" : "~/.codex/config.toml",
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
  setTrayLanguage: async () => {},
  showDiagnostics: desktopOnly,
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
  refreshUsage: async (id) => structuredClone(state.usage[id]),
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
