import test from "node:test";
import assert from "node:assert/strict";
import {
  automationStatus,
  staleManualSwitch,
  switchNowLabel,
  type AutomationStatusInput,
} from "../shared/automation-status";
import {
  DEFAULT_SETTINGS,
  type Account,
  type AccountUsage,
  type AutoSwitchReason,
  type AutoSwitchState,
  type DesktopState,
  type FleetContinuationState,
  type RelaySettings,
} from "../shared/types";

const NOW = Date.parse("2026-10-17T12:00:00.000Z");
const at = (ms: number) => new Date(ms).toISOString();

function account(id: string, name: string): Account {
  return {
    id,
    name,
    kind: "personal",
    group: "personal",
    color: "blue",
    createdAt: at(NOW),
  };
}
const a = account("account-a", "Kişisel · Max");
const b = account("account-b", "Kişisel · İkinci");

function usage(
  id: string,
  five: number,
  extra: Partial<AccountUsage> = {},
): AccountUsage {
  return {
    accountId: id,
    status: "ready",
    stale: false,
    checkedAt: at(NOW - 60_000),
    fiveHour: { usedPercent: five, resetsAt: at(NOW + 3_600_000) },
    sevenDay: { usedPercent: 10, resetsAt: at(NOW + 86_400_000) },
    ...extra,
  };
}
function desktop(activeProfileId?: string): DesktopState {
  return {
    available: true,
    running: true,
    organizations: [],
    activeProfileId,
    busy: false,
    recoveryRequired: false,
    errorRevision: 0,
  };
}
const settings = (
  autoSwitchMode: RelaySettings["autoSwitchMode"],
): RelaySettings => ({ ...DEFAULT_SETTINGS, autoSwitchMode });
const autoSwitch = (
  reason: AutoSwitchReason,
  over: Partial<AutoSwitchState> = {},
): AutoSwitchState => ({
  status: "waiting",
  reason,
  sourceId: a.id,
  targetId: b.id,
  ...over,
});
const fleet = (
  reason: string | undefined,
  over: Partial<FleetContinuationState> = {},
): FleetContinuationState => ({
  enabled: true,
  status: "waiting",
  reason,
  sourceId: a.id,
  targetId: b.id,
  stopped: 2,
  ...over,
});
function input(
  over: Partial<AutomationStatusInput> = {},
  fiveA = 100,
): AutomationStatusInput {
  return {
    settings: settings("off"),
    accounts: [a, b],
    usage: { [a.id]: usage(a.id, fiveA), [b.id]: usage(b.id, 20) },
    desktop: desktop(a.id),
    now: NOW,
    ...over,
  };
}
/** The same input as a user with nothing active: no prefix to strip. */
const bare = (over: Partial<AutomationStatusInput> = {}) =>
  input({ desktop: undefined, usage: {}, ...over });

test("off says the user switches", () => {
  const status = automationStatus(input({ settings: settings("off") }, 40));
  assert.equal(status.mode, "off");
  assert.equal(status.tone, "off");
  assert.match(status.text[0], /^Kişisel · Max %\d+ kullanıldı · Kapalı\./);
  assert.match(status.text[1], /^Kişisel · Max \d+% used · Off\./);
  assert.equal(status.banner, false);
  assert.equal(status.switchTo, undefined);
});

test("the percent prefix says what is used, rounded down, and needs an active account with usage", () => {
  const rounded = automationStatus(
    input({
      usage: { [a.id]: usage(a.id, 42.6, { sevenDay: undefined }) },
    }),
  );
  assert.equal(
    rounded.text[0],
    "Kişisel · Max %42 kullanıldı · Kapalı. Limit dolunca başka hesaba sen geçersin.",
  );
  assert.equal(
    rounded.text[1],
    "Kişisel · Max 42% used · Off. When the limit is reached, you switch accounts yourself.",
  );
  const noUsage = automationStatus(input({ usage: {} }));
  assert.equal(
    noUsage.text[0],
    "Kapalı. Limit dolunca başka hesaba sen geçersin.",
  );
  const unknownActive = automationStatus(
    input({ desktop: desktop("elsewhere") }),
  );
  assert.equal(
    unknownActive.text[0],
    "Kapalı. Limit dolunca başka hesaba sen geçersin.",
  );
});

test("after-exit waiting for Claude offers the target with the reason", () => {
  const status = automationStatus(
    input({
      settings: settings("after-exit"),
      autoSwitch: autoSwitch("claude-running"),
    }),
  );
  assert.equal(status.mode, "after-exit");
  assert.equal(
    status.text[0],
    "Kişisel · Max %100 kullanıldı · Claude uygulaması açık, kapanmasını bekliyorum. Claude uygulamasını kapatınca Kişisel · İkinci hazırlanır.",
  );
  assert.equal(
    status.text[1],
    "Kişisel · Max 100% used · The Claude app is open; waiting for it to quit. Quit the Claude app and Kişisel · İkinci is prepared.",
  );
  assert.equal(status.switchTo, b.id);
  assert.equal(status.banner, true);
  assert.equal(status.tone, "waiting");
});

test("fleet waiting for other work offers switching now and says who continues", () => {
  const status = automationStatus(
    input({
      fleet: fleet("not-quiescent:busyWorkers"),
      autoSwitch: autoSwitch("disabled"),
    }),
  );
  assert.equal(status.mode, "quota");
  assert.equal(
    status.text[0],
    "Kişisel · Max %100 kullanıldı · 2 konuşma limit dolduğu için durdu. Claude uygulamasında başka iş çalışıyor; bitince Kişisel · İkinci’ye geçip devam ettiririm. Şimdi geçersen devam mesajını sen yazarsın.",
  );
  assert.equal(
    status.text[1],
    "Kişisel · Max 100% used · 2 conversations stopped at the limit. Other work is running in the Claude app; when it finishes I switch to Kişisel · İkinci and continue. If you switch now, you type the continue message yourself.",
  );
  assert.equal(status.switchTo, b.id);
  assert.equal(status.banner, true);
  assert.equal(status.tone, "waiting");
});

test("quiescence-unverified reads like other work running", () => {
  const status = automationStatus(
    input({ fleet: fleet("quiescence-unverified") }),
  );
  assert.match(status.text[0], /Claude uygulamasında başka iş çalışıyor/);
  assert.match(status.text[0], /Şimdi geçersen devam mesajını sen yazarsın\.$/);
  assert.match(
    status.text[1],
    /If you switch now, you type the continue message yourself\.$/,
  );
  assert.equal(status.switchTo, b.id);
});

test("fleet with a full account and nothing stopped offers the target", () => {
  const full = automationStatus(
    input({
      fleet: fleet("awaiting-quota-stop", { status: "watching", stopped: 0 }),
    }),
  );
  assert.equal(full.switchTo, b.id);
  assert.equal(full.banner, true);
  assert.equal(full.tone, "waiting");
  // Nothing stopped, so there is no continue message to warn about.
  assert.equal(
    full.text[0],
    "Kişisel · Max %100 kullanıldı · Limit doldu ama duran konuşma yok; devam ettirecek bir şey yok. İstersen şimdi Kişisel · İkinci’ye geç.",
  );
  assert.equal(
    full.text[1],
    "Kişisel · Max 100% used · The limit is reached but no conversation stopped at it, so there is nothing to continue. You can switch to Kişisel · İkinci now.",
  );

  const notFull = automationStatus(
    input(
      {
        fleet: fleet("awaiting-quota-stop", { status: "watching", stopped: 0 }),
      },
      70,
    ),
  );
  assert.equal(notFull.switchTo, undefined);
  assert.equal(notFull.tone, "ok");
  assert.equal(notFull.banner, false);
  assert.equal(
    notFull.text[0],
    "Kişisel · Max %70 kullanıldı · İzliyorum. Limit dolunca duran konuşmaları sıradaki hesapta devam ettiririm.",
  );
});

test("a full account with nothing stopped and no target says nothing is ready", () => {
  const status = automationStatus(
    input({
      fleet: fleet("awaiting-quota-stop", {
        status: "watching",
        stopped: 0,
        targetId: undefined,
      }),
    }),
  );
  assert.equal(status.switchTo, undefined);
  assert.equal(status.banner, false);
  assert.equal(status.tone, "waiting");
  assert.equal(
    status.text[0],
    "Kişisel · Max %100 kullanıldı · Limit doldu; duran konuşma ve hazır hesap yok.",
  );
});

test("a full reading too old to confirm the quota waits for fresh data", () => {
  const aged = (minutes: number) => ({
    [a.id]: usage(a.id, 100, { checkedAt: at(NOW - minutes * 60_000) }),
    [b.id]: usage(b.id, 20),
  });
  const awaiting = (targetId?: string) =>
    fleet("awaiting-quota-stop", { status: "watching", stopped: 0, targetId });
  // The fleet confirms a full source only from a reading under 15 minutes old.
  for (const targetId of [b.id, undefined]) {
    const old = automationStatus(
      input({ fleet: awaiting(targetId), usage: aged(20) }),
    );
    assert.deepEqual(
      old.text,
      [
        "Kişisel · Max %100 kullanıldı · Güncel limit verisi bekliyorum.",
        "Kişisel · Max 100% used · Waiting for fresh usage data.",
      ],
      String(targetId),
    );
    assert.equal(old.switchTo, undefined, String(targetId));
    assert.equal(old.banner, false, String(targetId));
    assert.equal(old.tone, "waiting", String(targetId));
  }
  const offered = automationStatus(
    input({ fleet: awaiting(b.id), usage: aged(5) }),
  );
  assert.equal(offered.switchTo, b.id);
  assert.match(offered.text[0], /İstersen şimdi Kişisel · İkinci’ye geç\.$/);
  const nothingReady = automationStatus(
    input({ fleet: awaiting(undefined), usage: aged(5) }),
  );
  assert.equal(
    nothingReady.text[0],
    "Kişisel · Max %100 kullanıldı · Limit doldu; duran konuşma ve hazır hesap yok.",
  );
  // Other work running: the sentence stays, the switch waits for fresh data.
  const otherWork = automationStatus(
    input({ fleet: fleet("not-quiescent:busyWorkers"), usage: aged(20) }),
  );
  assert.equal(otherWork.switchTo, undefined);
  assert.match(otherWork.text[0], /Claude uygulamasında başka iş çalışıyor/);
});

test("a fresh full account is judged from the other limits too", () => {
  const weeklyFull = automationStatus(
    input({
      fleet: fleet("not-quiescent:busyWorkers"),
      usage: { [a.id]: usage(a.id, 30, { sevenDay: { usedPercent: 100 } }) },
    }),
  );
  assert.equal(weeklyFull.switchTo, b.id);
  const modelFull = automationStatus(
    input({
      fleet: fleet("not-quiescent:busyWorkers"),
      usage: { [a.id]: usage(a.id, 30, { otherLimitReached: true }) },
    }),
  );
  assert.equal(modelFull.switchTo, b.id);
  const stale = automationStatus(
    input({
      fleet: fleet("not-quiescent:busyWorkers"),
      usage: { [a.id]: usage(a.id, 100, { stale: true }) },
    }),
  );
  assert.equal(stale.switchTo, undefined);
  const loading = automationStatus(
    input({
      fleet: fleet("not-quiescent:busyWorkers"),
      usage: { [a.id]: usage(a.id, 100, { status: "loading" }) },
    }),
  );
  assert.equal(loading.switchTo, undefined);
});

test("no switch-now when the active account is not full or not the fleet source", () => {
  const notFull = automationStatus(
    input({ fleet: fleet("not-quiescent:busyWorkers") }, 90),
  );
  assert.equal(notFull.switchTo, undefined);
  assert.equal(notFull.banner, false);
  const otherSource = automationStatus(
    input({ fleet: fleet("not-quiescent:busyWorkers", { sourceId: b.id }) }),
  );
  assert.equal(otherSource.switchTo, undefined);
  const noTarget = automationStatus(
    input({
      fleet: fleet("not-quiescent:busyWorkers", { targetId: undefined }),
    }),
  );
  assert.equal(noTarget.switchTo, undefined);
});

test("transient waits stay out of the banner and lasting blocks show in it", () => {
  const status = (reason: AutoSwitchReason) =>
    automationStatus(
      input(
        {
          settings: settings("after-exit"),
          autoSwitch: autoSwitch(reason),
        },
        40,
      ),
    );
  for (const reason of [
    "desktop-busy",
    "usage-not-fresh",
    "browser-sign-in",
    "desktop-sign-in",
    "exit-settling",
    "quota-available",
  ] as const)
    assert.equal(status(reason).banner, false, reason);
  for (const reason of [
    "unknown-active",
    "not-selected",
    "no-ready-target",
    "switch-failed",
  ] as const) {
    assert.equal(status(reason).banner, true, reason);
    assert.equal(status(reason).tone, "attention", reason);
  }
  assert.equal(status("prepared").banner, true);
  assert.equal(status("prepared").tone, "ok");
  assert.equal(status("desktop-recovery").banner, false);
  assert.equal(status("desktop-recovery").tone, "attention");
});

test("prepare-on-quit tones follow the reason", () => {
  const tone = (reason: AutoSwitchReason) =>
    automationStatus(
      bare({
        settings: settings("after-exit"),
        autoSwitch: autoSwitch(reason),
      }),
    ).tone;
  assert.equal(tone("quota-available"), "ok");
  assert.equal(tone("already-switched"), "ok");
  assert.equal(tone("prepared"), "ok");
  assert.equal(tone("quota-exhausted"), "waiting");
  assert.equal(tone("claude-running"), "waiting");
  assert.equal(tone("disabled"), "waiting");
  assert.equal(tone("retry-backoff"), "attention");
  assert.equal(tone("ledger-unavailable"), "attention");
  assert.equal(tone("continuation-active"), "attention");
});

test("the prepared and quota-exhausted sentences name the target", () => {
  const prepared = automationStatus(
    bare({
      settings: settings("after-exit"),
      autoSwitch: autoSwitch("prepared"),
    }),
  );
  assert.deepEqual(prepared.text, [
    "Kişisel · İkinci hazır. Claude uygulamasını açıp konuşmanı sürdür.",
    "Kişisel · İkinci is ready. Open the Claude app and continue your conversation.",
  ]);
  assert.equal(prepared.switchTo, undefined);
  const exhausted = automationStatus(
    bare({
      settings: settings("after-exit"),
      autoSwitch: autoSwitch("quota-exhausted"),
    }),
  );
  assert.deepEqual(exhausted.text, [
    "Kişisel · İkinci hazırlanıyor…",
    "Preparing Kişisel · İkinci…",
  ]);
});

test("prepared does not repeat the account the prefix already names", () => {
  const here = automationStatus(
    input({
      settings: settings("after-exit"),
      autoSwitch: autoSwitch("prepared"),
      desktop: desktop(b.id),
    }),
  );
  assert.deepEqual(here.text, [
    "Kişisel · İkinci %20 kullanıldı · Hazır. Claude uygulamasını açıp konuşmanı sürdür.",
    "Kişisel · İkinci 20% used · Ready. Open the Claude app and continue your conversation.",
  ]);
  assert.equal(here.tone, "ok");
  assert.equal(here.banner, true);
  const elsewhere = automationStatus(
    input({
      settings: settings("after-exit"),
      autoSwitch: autoSwitch("prepared"),
    }),
  );
  assert.deepEqual(elsewhere.text, [
    "Kişisel · Max %100 kullanıldı · Kişisel · İkinci hazır. Claude uygulamasını açıp konuşmanı sürdür.",
    "Kişisel · Max 100% used · Kişisel · İkinci is ready. Open the Claude app and continue your conversation.",
  ]);
});

test("the sign-in and legacy-watch reasons name what to finish and where", () => {
  const status = (reason: AutoSwitchReason) =>
    automationStatus(
      bare({
        settings: settings("after-exit"),
        autoSwitch: autoSwitch(reason),
      }),
    );
  assert.match(
    status("browser-sign-in").text[0],
    /limit okuma girişi veya yenilemesi/,
  );
  assert.match(status("browser-sign-in").text[1], /usage sign-in or renewal/);
  assert.doesNotMatch(
    status("browser-sign-in").text[0],
    /Tarayıcı girişi tamamlanmalı/,
  );
  assert.match(status("desktop-sign-in").text[0], /Claude uygulaması girişi/);
  assert.match(status("desktop-sign-in").text[1], /Claude app sign-in/);
  // The legacy watch is named by its card's title on the Switching page.
  assert.match(
    status("continuation-active").text[0],
    /Geçiş sayfasındaki “Limit dolunca geç ve devam et” kartı açık/,
  );
  assert.match(status("continuation-active").text[0], /Kartı oradan kapat\./);
  assert.match(
    status("continuation-active").text[1],
    /“Switch and continue when the limit is reached” card on the Switching page is on/,
  );
});

test("missing snapshot parts degrade without a prefix or action", () => {
  const afterExit = automationStatus({
    settings: settings("after-exit"),
    accounts: [a, b],
    usage: {},
    now: NOW,
  });
  assert.equal(afterExit.mode, "after-exit");
  assert.deepEqual(afterExit.text, ["Kontrol ediliyor…", "Checking…"]);
  assert.equal(afterExit.tone, "waiting");
  assert.equal(afterExit.switchTo, undefined);
  assert.equal(afterExit.banner, false);
  const off = automationStatus({
    settings: settings("off"),
    accounts: [a, b],
    usage: {},
    now: NOW,
  });
  assert.equal(off.mode, "off");
  assert.equal(off.switchTo, undefined);
});

test("quota mode shows checking while the fleet has not started", () => {
  const status = automationStatus(
    bare({ fleet: { enabled: true, status: "off" } }),
  );
  assert.equal(status.mode, "quota");
  assert.deepEqual(status.text, ["Kontrol ediliyor…", "Checking…"]);
  assert.equal(status.tone, "waiting");
});

test("a fleet published before its first check reads like checking", () => {
  for (const reason of [undefined, ""]) {
    const status = automationStatus(
      input({ fleet: fleet(reason, { status: "watching" }) }),
    );
    assert.equal(status.mode, "quota", String(reason));
    assert.equal(status.tone, "waiting", String(reason));
    assert.equal(status.banner, false, String(reason));
    assert.equal(status.switchTo, undefined, String(reason));
    assert.deepEqual(
      status.text,
      [
        "Kişisel · Max %100 kullanıldı · Kontrol ediliyor…",
        "Kişisel · Max 100% used · Checking…",
      ],
      String(reason),
    );
  }
});

test("a switch and a continuation in progress say where", () => {
  const switching = automationStatus(
    bare({ fleet: fleet(undefined, { status: "switching" }) }),
  );
  assert.deepEqual(switching.text, [
    "Kişisel · Max hesabından Kişisel · İkinci hesabına geçiliyor…",
    "Switching Kişisel · Max → Kişisel · İkinci…",
  ]);
  assert.equal(switching.tone, "waiting");
  assert.equal(switching.banner, false);
  assert.equal(switching.switchTo, undefined);
  const continuing = automationStatus(
    bare({ fleet: fleet(undefined, { status: "continuing", stopped: 3 }) }),
  );
  assert.deepEqual(continuing.text, [
    "Kişisel · İkinci hesabında 3 konuşma sürdürülüyor…",
    "Continuing 3 conversations on Kişisel · İkinci…",
  ]);
  // One conversation reads in the singular.
  assert.equal(
    automationStatus(bare({ fleet: fleet(undefined, { status: "continuing", stopped: 1 }) })).text[1],
    "Continuing 1 conversation on Kişisel · İkinci…",
  );
  assert.equal(continuing.tone, "waiting");
  assert.equal(continuing.banner, false);
});

test("the last handoff is named after it finished", () => {
  const status = automationStatus(
    bare({
      fleet: fleet("continued", {
        status: "watching",
        stopped: undefined,
        targetId: undefined,
        last: {
          at: at(NOW),
          sourceId: a.id,
          targetId: b.id,
          conversations: 3,
          started: 2,
          uncertain: 0,
          skipped: 1,
        },
      }),
    }),
  );
  assert.equal(status.tone, "ok");
  assert.equal(status.banner, false);
  assert.deepEqual(status.text, [
    "İzliyorum. Son geçiş: Kişisel · Max → Kişisel · İkinci, 2/3 konuşma sürdürüldü.",
    "Watching. Last handoff: Kişisel · Max → Kişisel · İkinci, 2/3 conversations continued.",
  ]);
});

test("an uncertain delivery counts the conversations and stays in the banner", () => {
  const status = automationStatus(
    bare({
      fleet: fleet("delivery-uncertain", {
        status: "attention",
        last: {
          at: at(NOW),
          sourceId: a.id,
          targetId: b.id,
          conversations: 3,
          started: 1,
          uncertain: 2,
          skipped: 0,
        },
      }),
    }),
  );
  assert.equal(status.tone, "attention");
  assert.equal(status.banner, true);
  assert.equal(
    status.text[0],
    "2 konuşmada devam mesajının ulaştığı doğrulanamadı; Claude uygulamasında kontrol et. Tekrar gönderilmez.",
  );
  assert.equal(
    status.text[1],
    "Could not confirm the continue message reached 2 conversations; check them in the Claude app. Nothing is resent.",
  );
});

test("a failed switch keeps its cause and an unknown reason keeps its own", () => {
  const failed = automationStatus(
    bare({
      fleet: fleet("switch-failed:desktop-locked", { status: "attention" }),
    }),
  );
  assert.equal(failed.tone, "attention");
  assert.equal(failed.banner, true);
  assert.equal(
    failed.text[0],
    "Geçiş yapılamadı (desktop-locked). Bu limit için yeniden denemeyeceğim; istersen elle geç.",
  );
  const unreadable = automationStatus(
    bare({ fleet: fleet("ax-unreadable", { status: "attention" }) }),
  );
  assert.equal(unreadable.tone, "attention");
  assert.equal(unreadable.banner, true);
  assert.equal(
    unreadable.text[0],
    "Claude uygulamasının arayüzü okunamadı (ax-unreadable). Geçiş bekliyor.",
  );
  const waiting = automationStatus(
    bare({ fleet: fleet("ax-unreadable", { status: "waiting" }) }),
  );
  assert.equal(waiting.tone, "waiting");
  assert.equal(waiting.banner, false);
});

test("an interrupted legacy handoff wins over every mode", () => {
  for (const [label, over] of [
    ["quota", { fleet: fleet("not-quiescent:busyWorkers") }],
    ["after-exit", { settings: settings("after-exit") }],
    ["off", {}],
  ] as const) {
    const status = automationStatus(
      input({
        ...over,
        continuation: { enabled: true, status: "reconciliation-required" },
      }),
    );
    assert.equal(status.tone, "attention", label);
    assert.equal(status.banner, true, label);
    assert.equal(status.switchTo, undefined, label);
    assert.match(
      status.text[0],
      /Yarım kalan bir konuşma devri var; Geçiş sayfasındaki kartından sürdür veya iptal et\./,
      label,
    );
    assert.match(
      status.text[1],
      /A conversation handoff was interrupted; resume or cancel it on the Switching page\./,
      label,
    );
  }
  assert.equal(
    automationStatus(
      input({
        settings: settings("after-exit"),
        continuation: { enabled: true, status: "reconciliation-required" },
      }),
    ).mode,
    "after-exit",
  );
  assert.match(
    automationStatus(
      input({
        continuation: { enabled: true, status: "reconciliation-required" },
      }),
    ).text[0],
    /^Kişisel · Max %100 kullanıldı · Yarım kalan bir konuşma devri var/,
  );
});

test("off with the old single-conversation watch still armed says so", () => {
  const status = automationStatus(
    input({ continuation: { enabled: true, status: "armed" } }, 40),
  );
  assert.equal(status.mode, "off");
  assert.equal(status.tone, "attention");
  assert.equal(status.banner, true);
  assert.equal(status.switchTo, undefined);
  assert.deepEqual(status.text, [
    "Kişisel · Max %40 kullanıldı · Kapalı, ama Geçiş sayfasındaki “Limit dolunca geç ve devam et” kartı hâlâ açık; oradan kapat.",
    "Kişisel · Max 40% used · Off, but the “Switch and continue when the limit is reached” card on the Switching page is still on; turn it off there.",
  ]);
  const disarmed = automationStatus(
    input({ continuation: { enabled: false, status: "off" } }, 40),
  );
  assert.equal(disarmed.tone, "off");
  assert.equal(disarmed.banner, false);
});

const AFTER_EXIT: Record<AutoSwitchReason, true> = {
  "ledger-unavailable": true,
  "exit-settling": true,
  "unsupported-platform": true,
  disabled: true,
  "not-selected": true,
  "desktop-unavailable": true,
  "desktop-busy": true,
  "desktop-recovery": true,
  "desktop-sign-in": true,
  "browser-sign-in": true,
  "continuation-active": true,
  "unknown-active": true,
  "source-not-ready": true,
  "usage-not-fresh": true,
  "quota-available": true,
  "no-ready-target": true,
  "claude-running": true,
  "already-switched": true,
  "retry-backoff": true,
  "switch-failed": true,
  "quota-exhausted": true,
  prepared: true,
};
const FLEET_REASONS = [
  "continued",
  "awaiting-quota-stop",
  "not-quiescent:busyWorkers",
  "quiescence-unverified",
  "source-quota-unconfirmed",
  "checking",
  "desktop-busy",
  "context-changed",
  "delivery-uncertain",
  "switch-failed:boom",
  "no-target",
  "desktop-unavailable",
  "source-not-enrolled",
  "accessibility-permission-required",
  "switch-interrupted",
  "account-changed",
  "target-missing",
  "something-new",
];

test("every after-exit reason and the known fleet reasons have Turkish and English text", () => {
  const sound = (label: string, [tr, en]: [string, string]) => {
    assert.ok(tr.length > 0 && en.length > 0, label);
    assert.notEqual(tr, en, label);
    for (const text of [tr, en])
      assert.doesNotMatch(text, /[{}]|undefined|NaN/, label);
  };
  for (const reason of Object.keys(AFTER_EXIT) as AutoSwitchReason[])
    sound(
      reason,
      automationStatus(
        bare({
          settings: settings("after-exit"),
          autoSwitch: autoSwitch(reason),
        }),
      ).text,
    );
  const last = {
    at: at(NOW),
    sourceId: a.id,
    targetId: b.id,
    conversations: 3,
    started: 2,
    uncertain: 1,
    skipped: 0,
  };
  for (const reason of FLEET_REASONS)
    sound(
      reason,
      automationStatus(bare({ fleet: fleet(reason, { last }) })).text,
    );
});

test("a stale confirmation is detected from fresh state", () => {
  assert.equal(
    staleManualSwitch(b.id, desktop(b.id), undefined),
    "already-active",
  );
  assert.equal(
    staleManualSwitch(
      b.id,
      desktop(a.id),
      fleet(undefined, { status: "switching" }),
    ),
    "automation-running",
  );
  assert.equal(
    staleManualSwitch(
      b.id,
      desktop(a.id),
      fleet(undefined, { status: "continuing" }),
    ),
    "automation-running",
  );
  assert.equal(
    staleManualSwitch(
      b.id,
      desktop(a.id),
      fleet(undefined, { status: "waiting" }),
    ),
    undefined,
  );
  assert.equal(staleManualSwitch(b.id, desktop(a.id), undefined), undefined);
  assert.equal(staleManualSwitch(b.id, undefined, undefined), undefined);
  assert.equal(
    staleManualSwitch(
      b.id,
      desktop(b.id),
      fleet(undefined, { status: "switching" }),
    ),
    "already-active",
  );
});

test("the switch-now label uses the dative", () => {
  assert.deepEqual(switchNowLabel("Kişisel · İkinci"), [
    "Şimdi Kişisel · İkinci’ye geç",
    "Switch to Kişisel · İkinci now",
  ]);
});
