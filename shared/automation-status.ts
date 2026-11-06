import type {
  Account,
  AccountUsage,
  AutoSwitchReason,
  AutoSwitchState,
  DesktopState,
  FleetContinuationState,
  RelaySettings,
  Snapshot,
} from "./types";
import { automationMode, type AutomationMode } from "./automation-mode";
import { formatUsed } from "./percent";
import { withDative } from "./tr-dative";
import { maxUsedPercent, sourceExhausted } from "./usage";

export type AutomationTone = "off" | "ok" | "waiting" | "attention";

export interface AutomationStatus {
  mode: AutomationMode;
  tone: AutomationTone;
  /** One sentence: what Relay does, why it waits, what to do. */
  text: [tr: string, en: string];
  /**
   * The "<account> %n kullanıldı · " that `text` starts with (empty without a reading).
   * It changes with every usage reading, so the UI keeps it out of live
   * announcements.
   */
  prefix: [tr: string, en: string];
  /** Account id offered as "Şimdi <hesap>’e geç". */
  switchTo?: string;
  /** Show in the page-top banner. */
  banner: boolean;
}

export interface AutomationStatusInput {
  settings: RelaySettings;
  fleet?: FleetContinuationState;
  autoSwitch?: AutoSwitchState;
  /** The legacy single-conversation watch. */
  continuation?: Pick<
    NonNullable<Snapshot["continuation"]>,
    "enabled" | "status"
  >;
  accounts: Account[];
  usage: Record<string, AccountUsage>;
  desktop?: DesktopState;
  now: number;
}

type Copy = [tr: string, en: string];
/** A sentence with its tone; `{name}` placeholders are filled when it is shown. */
interface Row {
  tone: AutomationTone;
  banner: boolean;
  copy: Copy;
}
const waiting = (copy: Copy): Row => ({ tone: "waiting", banner: false, copy });
const ok = (copy: Copy, banner = false): Row => ({
  tone: "ok",
  banner,
  copy,
});
const attention = (copy: Copy, banner = true): Row => ({
  tone: "attention",
  banner,
  copy,
});

const CHECKING: Copy = ["Kontrol ediliyor…", "Check in progress…"];
const DESKTOP_BUSY: Copy = [
  "Relay Claude uygulamasında başka bir işlem yapıyor; bitince yeniden bakar.",
  "Relay is busy with another Claude app action. Relay checks again after it.",
];
const SEPARATE_WINDOW: Copy = [
  "Ayrı bir Claude penceresi açık; kapanana kadar Relay kendiliğinden geçmez.",
  "A separate Claude window is open. Relay does not switch until it closes.",
];
const DESKTOP_UNAVAILABLE: Copy = [
  "Claude uygulaması bulunamadı.",
  "The Claude app was not found.",
];
const UNKNOWN_ACTIVE: Copy = [
  "Claude uygulamasında açık olan hesap Relay’de kayıtlı değil. Hesaplar’da Claude uygulaması girişini kaydet.",
  "The account open in the Claude app is not saved in Relay. Save its Claude app sign-in on Accounts.",
];

const USAGE_NOT_FRESH: Copy = [
  "Henüz güncel limit verisi yok.",
  "No current usage data yet.",
];

const OFF: Copy = [
  "Kapalı. Limit dolunca başka hesaba sen geçersin.",
  "Off. When the limit is reached, you switch accounts yourself.",
];
const OFF_LEGACY_WATCH: Copy = [
  "Kapalı, ama Ayarlar → Geçiş’teki “Limit dolunca geç ve devam et” kartı hâlâ açık. Oradan kapat.",
  "Off, but the “Switch and continue when the limit is reached” card in Settings → Switching is still on. Turn it off there.",
];
const HANDOFF_INTERRUPTED: Copy = [
  "Yarım kalan bir konuşma devri var. Ayarlar → Geçiş’te sürdür veya iptal et.",
  "A conversation handoff is incomplete. Continue or cancel it in Settings → Switching.",
];
const SWITCH_NOW_SUFFIX: Copy = [
  " Şimdi geçersen devam mesajını sen yazarsın.",
  " If you switch now, you type the continue message yourself.",
];

/** Prepare on quit. `{tgt}` is the target account. */
const AFTER_EXIT: Record<AutoSwitchReason, Row> = {
  disabled: waiting(CHECKING),
  "desktop-busy": waiting(DESKTOP_BUSY),
  "separate-window": waiting(SEPARATE_WINDOW),
  "desktop-sign-in": waiting([
    "Bir hesabın Claude uygulaması girişi sürüyor. Hesaplar’da tamamla veya iptal et.",
    "An account’s Claude app sign-in is in progress. Finish or cancel it on Accounts.",
  ]),
  "browser-sign-in": waiting([
    "Bir hesabın limit okuma girişi veya yenilemesi sürüyor; bitince Relay yeniden bakar.",
    "An account’s usage sign-in or renewal is in progress. Relay checks again after it.",
  ]),
  "usage-not-fresh": waiting(USAGE_NOT_FRESH),
  "exit-settling": waiting([
    "Claude uygulaması kapandı; tamamen kapanması bekleniyor.",
    "The Claude app quit. Relay waits for it to close fully.",
  ]),
  "quota-exhausted": waiting(["{tgt} hazırlanıyor…", "Relay prepares {tgt}…"]),
  "claude-running": {
    ...waiting([
      "Claude uygulaması açık. Kapattığında Relay {tgt} hesabını hazırlar.",
      "The Claude app is open. When you quit it, Relay prepares {tgt}.",
    ]),
    banner: true,
  },
  "quota-available": ok([
    "Limit dolup Claude uygulaması kapanınca Relay sıradaki hesabı hazırlar.",
    "When the limit is reached and the Claude app quits, Relay prepares the next account.",
  ]),
  "already-switched": ok([
    "Bu limit dönemi için geçiş zaten yapıldı.",
    "Already switched for this limit period.",
  ]),
  prepared: ok(
    [
      "{tgt} hazır. Konuşmanı sürdürmek için Claude uygulamasını aç.",
      "{tgt} is ready. Open the Claude app to continue your conversation.",
    ],
    true,
  ),
  "unsupported-platform": attention([
    "Otomatik geçiş yalnızca macOS’ta çalışır.",
    "Automatic switching works only on macOS.",
  ]),
  "desktop-unavailable": attention(DESKTOP_UNAVAILABLE),
  // Desktop recovery has its own banner.
  "desktop-recovery": attention(
    [
      "Yarım kalan bir Claude uygulaması işlemi var. Önce yedeği geri yükle.",
      "A Claude app action is incomplete. Restore the backup first.",
    ],
    false,
  ),
  "continuation-active": attention([
    "Ayarlar → Geçiş’teki “Limit dolunca geç ve devam et” kartı açık. Kartı oradan kapat.",
    "The “Switch and continue when the limit is reached” card in Settings → Switching is on. Turn it off there.",
  ]),
  "unknown-active": attention(UNKNOWN_ACTIVE),
  "not-selected": attention([
    "Bu hesap otomatik geçişe dahil değil. Ayarlar → Geçiş’te hesapları seç.",
    "This account is not in automatic switching. Select accounts in Settings → Switching.",
  ]),
  "source-not-ready": attention([
    "Açık hesabın Claude uygulaması girişi ile limit okuma girişi farklı hesaplara ait. Hesaplar’da kontrol et.",
    "The open account’s Claude app sign-in and usage sign-in belong to different accounts. Check them on Accounts.",
  ]),
  "no-ready-target": attention([
    "Limit doldu ama hazır hesap yok. Bir hesabın limiti yenilenince Relay onu hazırlar.",
    "The limit is reached and no account is ready. Relay prepares one when a limit resets.",
  ]),
  "retry-backoff": attention([
    "Geçiş başarısız oldu; Relay biraz sonra yeniden dener. İstersen elle geç.",
    "The switch failed. Relay tries again soon. You can switch manually.",
  ]),
  "switch-failed": attention([
    "Geçiş tamamlanamadı. Claude uygulamasının açıldığından emin ol. Geri yüklenecek bir yedek var mı kontrol et.",
    "The switch did not finish. Make sure that the Claude app opens. Check for a backup to restore.",
  ]),
  "ledger-unavailable": attention([
    "Hesap hazırlandı ama otomatik geçiş kaydı yazılamadı. Relay yeniden açılırsa aynı geçişi tekrar yapabilir.",
    "Relay prepared the account but cannot save the switch record. After a Relay restart, it can do this switch again.",
  ]),
};
/** `prepared` when the prefix already names the target. */
const PREPARED_HERE = ok(
  [
    "Hazır. Konuşmanı sürdürmek için Claude uygulamasını aç.",
    "Ready. Open the Claude app to continue your conversation.",
  ],
  true,
);

/**
 * Continue at quota, by exact reason. `{n}` is the stopped conversations,
 * `{tgt}` the target, and `{tgt’e}` the target with its Turkish dative.
 */
const FLEET: Record<string, Row> = {
  "source-quota-unconfirmed": waiting([
    "{n} konuşma limit dolduğu için durdu; limit verisi bunu doğrulayınca Relay geçer.",
    "{n conversations} stopped at the limit. Relay switches when usage data confirms it.",
  ]),
  checking: waiting(CHECKING),
  "desktop-busy": waiting(DESKTOP_BUSY),
  "separate-window": waiting(SEPARATE_WINDOW),
  "context-changed": waiting([
    "Durum değişti; Relay yeniden kontrol ediyor.",
    "The state changed. Relay checks again.",
  ]),
  "delivery-uncertain": attention([
    "{uncertain} konuşmada devam mesajının ulaştığı doğrulanamadı. Claude uygulamasında kontrol et. Mesaj tekrar gönderilmez.",
    "Relay cannot confirm that the continue message reached {uncertain conversations}. Check them in the Claude app. Relay does not send it again.",
  ]),
  "no-target": attention([
    "{n} konuşma durdu ama limitinde yer olan hesap yok. Bir hesabın limiti yenilenince Relay geçer.",
    "{n conversations} stopped and no account has room. Relay switches when a limit resets.",
  ]),
  "desktop-unavailable": attention(DESKTOP_UNAVAILABLE),
  "source-not-enrolled": attention(UNKNOWN_ACTIVE),
  "accessibility-permission-required": attention([
    "Konuşmaları sürdürmek için Relay’e macOS Erişilebilirlik izni ver.",
    "Give Relay macOS Accessibility permission to continue conversations.",
  ]),
  "switch-interrupted": attention([
    "Bir geçiş yarıda kaldı. Önce yedeği geri yükle.",
    "A switch is incomplete. Restore the backup first.",
  ]),
  "account-changed": attention([
    "Geçişten sonra açık hesap değişti. Devam mesajları gönderilmedi.",
    "The open account changed after the switch. Relay did not send continue messages.",
  ]),
  "target-missing": attention([
    "Hedef hesap bulunamadı. Devam mesajları gönderilmedi.",
    "The target account is missing. Relay did not send continue messages.",
  ]),
};

/** Any reason Relay has no sentence for: the UI could not be read. */
const UNREADABLE: Copy = [
  "Claude uygulamasının arayüzü okunamadı ({reason}). Geçiş bekliyor.",
  "Relay cannot read the Claude app interface ({reason}). The switch waits.",
];
const OTHER_WORK: Copy = [
  "{n} konuşma limit dolduğu için durdu. Claude uygulamasında başka iş çalışıyor; bitince Relay {tgt’e} geçip devam ettirir.",
  "{n conversations} stopped at the limit. Other work runs in the Claude app. When it ends, Relay switches to {tgt} and continues.",
];
const BACKGROUND_WORK: Copy = [
  "{n} konuşma limit dolduğu için durdu. Arka planda bir komut, örneğin derleme ya da test, hâlâ çalışıyor. Bitince ya da en geç 15 dk sonra Relay onu durdurup {tgt’e} geçer. Geçiş açık sunucuları da kapatır.",
  "{n conversations} stopped at the limit. A background command, such as a build or a test, still runs. When it ends, or after 15 min at most, Relay stops it and switches to {tgt}. The switch also stops open servers.",
];
const WATCHING: Copy = [
  "Limit dolunca Relay duran konuşmaları sıradaki hesapta devam ettirir.",
  "When the limit is reached, Relay continues stopped conversations on the next account.",
];
const FULL_NOTHING_STOPPED: Copy = [
  "Limit doldu ama duran konuşma yok. İstersen şimdi {tgt’e} geç.",
  "The limit is reached, but no conversation stopped. You can switch to {tgt} now.",
];
const FULL_NOTHING_READY: Copy = [
  "Limit doldu; duran konuşma ve hazır hesap yok.",
  "The limit is reached. No conversation stopped and no account is ready.",
];

/** Reasons where Relay holds a stop it could switch for, if the user asks. */
const holdsSwitch = (reason: string) =>
  reason === "background-work" ||
  reason.startsWith("not-quiescent:") ||
  reason === "quiescence-unverified" ||
  reason === "awaiting-quota-stop";

/** A ready reading that shows a limit reached, however long ago it was taken. */
function readsFull(u: AccountUsage | undefined) {
  return (
    u?.status === "ready" &&
    !u.stale &&
    ((u.fiveHour?.usedPercent ?? 0) >= 100 ||
      (u.sevenDay?.usedPercent ?? 0) >= 100 ||
      u.otherLimitReached === true)
  );
}

/** "1 conversation", "3 conversations": the English count of conversations. */
const conversations = (count: number) =>
  `${count} conversation${count === 1 ? "" : "s"}`;

function fill(copy: Copy, vars: Record<string, string | number>): Copy {
  const sub = (text: string) =>
    text.replace(/\{([^{}]+)\}/g, (whole, key: string) =>
      Object.hasOwn(vars, key) ? String(vars[key]) : whole,
    );
  return [sub(copy[0]), sub(copy[1])];
}

/** What automatic switching is doing, in one sentence, from one snapshot. */
export function automationStatus(
  input: AutomationStatusInput,
): AutomationStatus {
  const {
    settings,
    fleet,
    autoSwitch,
    continuation,
    accounts,
    usage,
    desktop,
  } = input;
  const mode = automationMode(settings, fleet);
  const active = accounts.find((a) => a.id === desktop?.activeProfileId);
  const name = (id?: string) => accounts.find((a) => a.id === id)?.name ?? "—";
  const used = active ? maxUsedPercent(usage[active.id]) : undefined;
  const prefix: Copy =
    active && typeof used === "number"
      ? [
          `${active.name} ${formatUsed(used, "tr")} · `,
          `${active.name} ${formatUsed(used, "en")} · `,
        ]
      : ["", ""];
  const show = (
    row: Row,
    vars: Record<string, string | number> = {},
    switchTo?: string,
    suffix?: Copy,
  ): AutomationStatus => {
    const [tr, en] = fill(row.copy, vars);
    return {
      mode,
      tone: row.tone,
      text: [
        `${prefix[0]}${tr}${suffix?.[0] ?? ""}`,
        `${prefix[1]}${en}${suffix?.[1] ?? ""}`,
      ],
      prefix,
      ...(switchTo ? { switchTo } : {}),
      banner: row.banner || !!switchTo,
    };
  };

  if (continuation?.status === "reconciliation-required")
    return show(attention(HANDOFF_INTERRUPTED));
  if (mode === "off")
    return show(
      // An interrupted watch was handled above; an armed one still runs.
      continuation?.enabled
        ? attention(OFF_LEGACY_WATCH)
        : { tone: "off", banner: false, copy: OFF },
    );

  if (mode === "after-exit") {
    const row =
      autoSwitch?.reason === "prepared" &&
      prefix[0] !== "" &&
      active?.id === autoSwitch.targetId
        ? PREPARED_HERE
        : (AFTER_EXIT[autoSwitch?.reason ?? "disabled"] ?? AFTER_EXIT.disabled);
    return show(
      row,
      { tgt: name(autoSwitch?.targetId) },
      autoSwitch?.reason === "claude-running" ? autoSwitch.targetId : undefined,
    );
  }

  if (!fleet || fleet.status === "off") return show(waiting(CHECKING));
  const n = fleet.stopped ?? 0;
  const src = name(fleet.sourceId);
  const tgt = name(fleet.targetId);
  const vars = {
    n,
    "n conversations": conversations(n),
    src,
    tgt,
    "tgt’e": withDative(tgt),
  };
  if (fleet.status === "switching")
    return show(
      waiting(["{src} hesabından {tgt} hesabına geçiliyor…", "Switch in progress: {src} → {tgt}…"]),
      vars,
    );
  if (fleet.status === "continuing")
    return show(
      waiting([
        "{tgt} hesabında {n} konuşma sürdürülüyor…",
        "Relay continues {n conversations} on {tgt}…",
      ]),
      vars,
    );

  // A saved-enabled fleet is published without a reason before its first check.
  const reason = fleet.reason ?? "";
  if (!reason) return show(waiting(CHECKING));
  const last = fleet.last;
  const activeUsage = active && usage[active.id];
  // The fleet's own rule: only a reading under 15 minutes old confirms a full
  // account. An older one that reads full waits for a fresh reading.
  const full = sourceExhausted(activeUsage, input.now);
  // Switching now is offered only for the account the fleet is watching, and
  // only once fresh usage says it is full.
  const offer =
    holdsSwitch(reason) &&
    !!fleet.targetId &&
    fleet.sourceId === active?.id &&
    full;
  const switchTo = offer ? fleet.targetId : undefined;

  if (reason === "continued" && last)
    return show(
      ok([
        "Son geçiş: {src} → {tgt}, {started}/{conversations} konuşma sürdürüldü.",
        "Last handoff: {src} → {tgt}, {started}/{conversations} {conversations word} continued.",
      ]),
      {
        src: name(last.sourceId),
        tgt: name(last.targetId),
        started: last.started,
        conversations: last.conversations,
        "conversations word": last.conversations === 1 ? "conversation" : "conversations",
      },
    );
  if (reason === "continued") return show(ok(WATCHING));
  if (reason === "awaiting-quota-stop") {
    if (offer) return show(waiting(FULL_NOTHING_STOPPED), vars, switchTo);
    if (!fleet.targetId && full) return show(waiting(FULL_NOTHING_READY));
    if (!full && readsFull(activeUsage)) return show(waiting(USAGE_NOT_FRESH));
    return show(ok(WATCHING));
  }
  if (reason === "background-work")
    return show(
      waiting(BACKGROUND_WORK),
      vars,
      switchTo,
      switchTo ? SWITCH_NOW_SUFFIX : undefined,
    );
  if (reason.startsWith("not-quiescent:") || reason === "quiescence-unverified")
    return show(
      waiting(OTHER_WORK),
      vars,
      switchTo,
      switchTo ? SWITCH_NOW_SUFFIX : undefined,
    );
  if (reason.startsWith("switch-failed:"))
    return show(
      attention([
        "Geçiş yapılamadı ({x}). Relay bu limit için yeniden denemez; istersen elle geç.",
        "The switch failed ({x}). Relay does not try again for this limit. You can switch manually.",
      ]),
      { x: reason.slice("switch-failed:".length) },
    );
  if (Object.hasOwn(FLEET, reason))
    return show(FLEET[reason], {
      ...vars,
      uncertain: last?.uncertain ?? 0,
      "uncertain conversations": conversations(last?.uncertain ?? 0),
    });
  return show(
    fleet.status === "attention" ? attention(UNREADABLE) : waiting(UNREADABLE),
    { reason },
  );
}

/** Labels for the switch-now button: "Şimdi Kişisel’e geç" / "Switch to Kişisel now". */
export function switchNowLabel(name: string): [string, string] {
  return [`Şimdi ${withDative(name)} geç`, `Switch to ${name} now`];
}

/** Why a confirmed manual switch is no longer wanted, read from fresh state. */
export function staleManualSwitch(
  targetId: string,
  desktop: DesktopState | undefined,
  fleet: FleetContinuationState | undefined,
): "already-active" | "automation-running" | undefined {
  if (desktop?.activeProfileId === targetId) return "already-active";
  if (fleet?.status === "switching" || fleet?.status === "continuing")
    return "automation-running";
}
