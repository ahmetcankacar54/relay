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

const CHECKING: Copy = ["Kontrol ediliyor…", "Checking…"];
const DESKTOP_BUSY: Copy = [
  "Relay Claude uygulamasında başka bir işlem yapıyor; bitince yeniden bakarım.",
  "Relay is busy with another Claude app action; I’ll check again after it.",
];
const DESKTOP_UNAVAILABLE: Copy = [
  "Claude uygulaması bulunamadı.",
  "The Claude app was not found.",
];
const UNKNOWN_ACTIVE: Copy = [
  "Claude uygulamasında açık olan hesap Relay’de kayıtlı değil. Hesaplar’da Claude uygulaması girişini kaydet.",
  "The account open in the Claude app isn’t saved in Relay. Save its Claude app sign-in on Accounts.",
];

const USAGE_NOT_FRESH: Copy = [
  "Güncel limit verisi bekliyorum.",
  "Waiting for fresh usage data.",
];

const OFF: Copy = [
  "Kapalı. Limit dolunca başka hesaba sen geçersin.",
  "Off. When the limit is reached, you switch accounts yourself.",
];
const OFF_LEGACY_WATCH: Copy = [
  "Kapalı, ama Geçiş sayfasındaki “Limit dolunca geç ve devam et” kartı hâlâ açık; oradan kapat.",
  "Off, but the “Switch and continue when the limit is reached” card on the Switching page is still on; turn it off there.",
];
const HANDOFF_INTERRUPTED: Copy = [
  "Yarım kalan bir konuşma devri var; Geçiş sayfasındaki kartından sürdür veya iptal et.",
  "A conversation handoff was interrupted; resume or cancel it on the Switching page.",
];
const SWITCH_NOW_SUFFIX: Copy = [
  " Şimdi geçersen devam mesajını sen yazarsın.",
  " If you switch now, you type the continue message yourself.",
];

/** Prepare on quit. `{tgt}` is the target account. */
const AFTER_EXIT: Record<AutoSwitchReason, Row> = {
  disabled: waiting(CHECKING),
  "desktop-busy": waiting(DESKTOP_BUSY),
  "desktop-sign-in": waiting([
    "Bir hesabın Claude uygulaması girişi sürüyor; Hesaplar’da tamamla veya iptal et.",
    "An account’s Claude app sign-in is in progress; finish or cancel it on Accounts.",
  ]),
  "browser-sign-in": waiting([
    "Bir hesabın limit okuma girişi veya yenilemesi sürüyor; bitince yeniden bakarım.",
    "An account’s usage sign-in or renewal is in progress; I’ll check again after it.",
  ]),
  "usage-not-fresh": waiting(USAGE_NOT_FRESH),
  "exit-settling": waiting([
    "Claude uygulaması kapandı; tamamen kapanmasını bekliyorum.",
    "The Claude app quit; waiting for it to close completely.",
  ]),
  "quota-exhausted": waiting(["{tgt} hazırlanıyor…", "Preparing {tgt}…"]),
  "claude-running": {
    ...waiting([
      "Claude uygulaması açık, kapanmasını bekliyorum. Claude uygulamasını kapatınca {tgt} hazırlanır.",
      "The Claude app is open; waiting for it to quit. Quit the Claude app and {tgt} is prepared.",
    ]),
    banner: true,
  },
  "quota-available": ok([
    "İzliyorum. Limit dolup Claude uygulaması kapanınca sıradaki hesabı hazırlarım.",
    "Watching. When the limit is reached and the Claude app quits, I prepare the next account.",
  ]),
  "already-switched": ok([
    "Bu limit dönemi için geçiş zaten yapıldı.",
    "Already switched for this limit period.",
  ]),
  prepared: ok(
    [
      "{tgt} hazır. Claude uygulamasını açıp konuşmanı sürdür.",
      "{tgt} is ready. Open the Claude app and continue your conversation.",
    ],
    true,
  ),
  "unsupported-platform": attention([
    "Otomatik geçiş yalnızca macOS’ta çalışır.",
    "Automatic switching works on macOS only.",
  ]),
  "desktop-unavailable": attention(DESKTOP_UNAVAILABLE),
  // Desktop recovery has its own banner.
  "desktop-recovery": attention(
    [
      "Yarım kalan bir Claude uygulaması işlemi var; önce yedeği geri yükle.",
      "A Claude app action was interrupted; restore the backup first.",
    ],
    false,
  ),
  "continuation-active": attention([
    "Geçiş sayfasındaki “Limit dolunca geç ve devam et” kartı açık; o kapanana kadar hesap hazırlamıyorum. Kartı oradan kapat.",
    "The “Switch and continue when the limit is reached” card on the Switching page is on; preparing waits until it is off. Turn it off there.",
  ]),
  "unknown-active": attention(UNKNOWN_ACTIVE),
  "not-selected": attention([
    "Bu hesap otomatik geçişe dahil değil. Geçiş sayfasında hesapları seç.",
    "This account is not included. Choose accounts on the Switching page.",
  ]),
  "source-not-ready": attention([
    "Açık hesabın Claude uygulaması girişi ile limit okuma girişi farklı hesaplara ait. Hesaplar’da kontrol et.",
    "The open account’s Claude app sign-in and usage sign-in belong to different accounts. Check them on Accounts.",
  ]),
  "no-ready-target": attention([
    "Limit doldu ama hazır hesap yok; bir hesabın limiti yenilenince hazırlarım.",
    "The limit is reached but no account is ready; I’ll prepare one when a limit resets.",
  ]),
  "retry-backoff": attention([
    "Geçiş başarısız oldu; biraz sonra yeniden denerim. İstersen elle geç.",
    "The switch failed; I’ll retry shortly. You can switch by hand.",
  ]),
  "switch-failed": attention([
    "Geçiş tamamlanamadı. Claude uygulamasının açıldığını ve geri yüklenecek bir yedek olup olmadığını kontrol et.",
    "The switch couldn’t finish. Check that the Claude app opens and whether a backup needs restoring.",
  ]),
  "ledger-unavailable": attention([
    "Hesap hazırlandı ama otomatik geçiş kaydı yazılamadı; Relay yeniden açılırsa aynı geçişi tekrar yapabilir.",
    "The account was prepared, but the automatic-switch record couldn’t be saved; if Relay restarts it may repeat this switch.",
  ]),
};
/** `prepared` when the prefix already names the target. */
const PREPARED_HERE = ok(
  [
    "Hazır. Claude uygulamasını açıp konuşmanı sürdür.",
    "Ready. Open the Claude app and continue your conversation.",
  ],
  true,
);

/**
 * Continue at quota, by exact reason. `{n}` is the stopped conversations,
 * `{tgt}` the target, and `{tgt’e}` the target with its Turkish dative.
 */
const FLEET: Record<string, Row> = {
  "source-quota-unconfirmed": waiting([
    "{n} konuşma limit dolduğu için durdu; limit verisi bunu doğrulayınca geçerim.",
    "{n conversations} stopped at the limit; I switch once usage data confirms it.",
  ]),
  checking: waiting(CHECKING),
  "desktop-busy": waiting(DESKTOP_BUSY),
  "context-changed": waiting([
    "Durum değişti; yeniden kontrol ediyorum.",
    "Something changed; checking again.",
  ]),
  "delivery-uncertain": attention([
    "{uncertain} konuşmada devam mesajının ulaştığı doğrulanamadı; Claude uygulamasında kontrol et. Tekrar gönderilmez.",
    "Could not confirm the continue message reached {uncertain conversations}; check them in the Claude app. Nothing is resent.",
  ]),
  "no-target": attention([
    "{n} konuşma durdu ama limitinde yer olan hesap yok; bir hesabın limiti yenilenince geçerim.",
    "{n conversations} stopped but no account has room; I switch when one resets.",
  ]),
  "desktop-unavailable": attention(DESKTOP_UNAVAILABLE),
  "source-not-enrolled": attention(UNKNOWN_ACTIVE),
  "accessibility-permission-required": attention([
    "Konuşmaları sürdürmek için Relay’e macOS Erişilebilirlik izni ver.",
    "Give Relay macOS Accessibility permission to continue conversations.",
  ]),
  "switch-interrupted": attention([
    "Bir geçiş yarıda kaldı; önce yedeği geri yükle.",
    "A switch was interrupted; restore the backup first.",
  ]),
  "account-changed": attention([
    "Geçişten sonra açık hesap değişti; devam mesajları gönderilmedi.",
    "The open account changed after the switch; no continue messages were sent.",
  ]),
  "target-missing": attention([
    "Hedef hesap bulunamadı; devam mesajları gönderilmedi.",
    "The target account is missing; no continue messages were sent.",
  ]),
};

/** Any reason Relay has no sentence for: the UI could not be read. */
const UNREADABLE: Copy = [
  "Claude uygulamasının arayüzü okunamadı ({reason}). Geçiş bekliyor.",
  "Could not read the Claude app’s interface ({reason}). The switch is waiting.",
];
const OTHER_WORK: Copy = [
  "{n} konuşma limit dolduğu için durdu. Claude uygulamasında başka iş çalışıyor; bitince {tgt’e} geçip devam ettiririm.",
  "{n conversations} stopped at the limit. Other work is running in the Claude app; when it finishes I switch to {tgt} and continue.",
];
const WATCHING: Copy = [
  "İzliyorum. Limit dolunca duran konuşmaları sıradaki hesapta devam ettiririm.",
  "Watching. When the limit is reached, I continue stopped conversations on the next account.",
];
const FULL_NOTHING_STOPPED: Copy = [
  "Limit doldu ama duran konuşma yok; devam ettirecek bir şey yok. İstersen şimdi {tgt’e} geç.",
  "The limit is reached but no conversation stopped at it, so there is nothing to continue. You can switch to {tgt} now.",
];
const FULL_NOTHING_READY: Copy = [
  "Limit doldu; duran konuşma ve hazır hesap yok.",
  "The limit is reached; no conversation stopped and no account is ready.",
];

/** Reasons where Relay holds a stop it could switch for, if the user asks. */
const holdsSwitch = (reason: string) =>
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
      waiting(["{src} hesabından {tgt} hesabına geçiliyor…", "Switching {src} → {tgt}…"]),
      vars,
    );
  if (fleet.status === "continuing")
    return show(
      waiting([
        "{tgt} hesabında {n} konuşma sürdürülüyor…",
        "Continuing {n conversations} on {tgt}…",
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
        "İzliyorum. Son geçiş: {src} → {tgt}, {started}/{conversations} konuşma sürdürüldü.",
        "Watching. Last handoff: {src} → {tgt}, {started}/{conversations} {conversations word} continued.",
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
        "Geçiş yapılamadı ({x}). Bu limit için yeniden denemeyeceğim; istersen elle geç.",
        "The switch failed ({x}). I won’t retry for this limit; you can switch by hand.",
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
