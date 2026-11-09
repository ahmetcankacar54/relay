import { useEffect, useId, useState } from "react";
import { Private } from "@/components/Private";
import { ArrowRight, Check, LoaderCircle, Pause, Play, ShieldCheck } from "lucide-react";
import { RefreshIcon } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Note, SectionHeading } from "@/components/SettingRow";
import { StatusDot } from "@/components/StatusDot";
import type { Account, AccountUsage, RelaySettings } from "../../shared/types";
import {
  continuationTargetReadinessReason,
  type ContinuationTargetReadinessReason,
} from "../../shared/continuation-readiness";

type T = (tr: string, en: string) => string;

/** The manager owns observation, eligibility and every Desktop action. */
export interface ContinuationSettingsView {
  status:
    | "off"
    | "armed"
    | "waiting"
    | "executing"
    | "continued"
    | "blocked"
    | "reconciliation-required";
  reason: string;
  enabled?: boolean;
  executable?: boolean;
  checkedAt?: string;
  sourceId?: string;
  targetId?: string;
  targetSelection?: "automatic";
  allowedTargetCount?: number;
  sessionId?: string;
  projectKey?: string;
  permissionMode?: string;
  requestId?: string;
}

const explanations: Record<string, [string, string]> = {
  disabled: ["Otomatik geçiş kapalı.", "Automatic switching is off."],
  armed: [
    "Bu konuşmanın limit dolduğu için durması bekleniyor.",
    "Relay waits for this conversation to stop at the limit.",
  ],
  "awaiting-quota-stop": [
    "Bu konuşmanın limit dolduğu için durması bekleniyor. Limit yüzdesi tek başına geçiş başlatmaz.",
    "Relay waits for this conversation to stop at the limit. The limit percentage alone does not start a switch.",
  ],
  "checkpointed-handoff": [
    "Kaydedilen konuşma, hedef hesap ve izin modu doğrulanıyor. Devam mesajı yalnızca kontrollerden sonra gönderilir.",
    "Relay verifies the saved conversation, target account and permission mode. Relay sends the continue message only after these checks.",
  ],
  "session-not-stopped": [
    "Yanıt henüz durmadı. Claude uygulaması yeniden başlatılmadan tamamlanması bekleniyor.",
    "The response has not stopped yet. Relay waits for it to finish before it restarts the Claude app.",
  ],
  "quota-stop-unverified": [
    "Bu yanıtın limit dolduğu için durduğu doğrulanamadı. Geçiş yapılmadı; yeniden kontrol et.",
    "Relay cannot verify that this response stopped at the limit. Relay did not switch. Check again.",
  ],
  "quota-checkpoint-changed": [
    "Limit dolduğu için duran yanıtın kaydı değişti. Geçiş bekletiliyor; konuşmayı yeniden kontrol et.",
    "The record of the stopped response changed. The switch is on hold. Check the conversation again.",
  ],
  "own-quota-wakeup-can-takeover": [
    "Bu konuşmada Claude’un “Auto-continue when limits reset” seçeneği açık ve Relay onu henüz kapatamadı. Konuşma iki kez sürdürülmesin diye geçiş bekliyor.",
    "Claude’s “Auto-continue when limits reset” is on for this conversation, and Relay cannot turn it off yet. The switch waits so that the conversation does not continue twice.",
  ],
  "own-quota-wakeup-uncertain": [
    "Relay’in, Claude uygulamasındaki “Auto-continue when limits reset” seçeneğini kapatıp kapatmadığı kesinleşmedi. Otomatik işlem durdu; bu seçeneği Claude uygulamasında kontrol et. Relay aynı işlemi kendiliğinden tekrarlamaz.",
    "Relay cannot confirm that it turned off “Auto-continue when limits reset” in the Claude app. Automation stopped. Check this option in the Claude app. Relay does not do this action again automatically.",
  ],
  "quota-available": [
    "Limit henüz dolmadı. Seçtiğin konuşma izleniyor.",
    "The limit is not reached. Relay watches the selected conversation.",
  ],
  "source-quota-available": [
    "Limit henüz dolmadı. Seçtiğin konuşma izleniyor.",
    "The limit is not reached. Relay watches the selected conversation.",
  ],
  "quota-exhausted": [
    "Limit doldu. Yanıtın ve diğer görevlerin durması bekleniyor.",
    "The limit is reached. Relay waits for the response and other tasks to stop.",
  ],
  "desktop-work-active": [
    "Çalışan bir görev var. Görevler bitene kadar Claude uygulaması yeniden başlatılmaz.",
    "A task still runs. Relay does not restart the Claude app until the tasks finish.",
  ],
  "workers-not-quiescent": [
    "Çalışan görev veya bekleyen onay var. Bunlar tamamlanınca Relay yeniden kontrol eder.",
    "A task runs or waits for approval. Relay checks again when they finish.",
  ],
  "desktop-observation-incomplete": [
    "Bütün görevlerin durduğu doğrulanamadı. Geçiş bekliyor; Claude uygulamasına müdahale edilmiyor.",
    "Relay cannot verify that all tasks stopped. The switch waits. Relay does not change the Claude app.",
  ],
  "quiescence-unverified": [
    "Bütün görevlerin durduğu doğrulanamadı. Geçiş bekliyor; Claude uygulamasına müdahale edilmiyor.",
    "Relay cannot verify that all tasks stopped. The switch waits. Relay does not change the Claude app.",
  ],
  "coverage-unverified": [
    "Bütün görevlerin durduğu doğrulanamadı. Geçiş bekliyor; Claude uygulamasına müdahale edilmiyor.",
    "Relay cannot verify that all tasks stopped. The switch waits. Relay does not change the Claude app.",
  ],
  "observation-not-fresh": [
    "Konuşma kontrolü güncel değil. Yeni bir kontrol tamamlanmadan geçiş yapılmaz.",
    "The conversation check is out of date. Relay must check again before a switch.",
  ],
  "desktop-observation-unavailable": [
    "Claude uygulamasının konuşma ve görev bilgileri okunamadı. Claude uygulamasını açık tutup yeniden kontrol et.",
    "Relay cannot read the conversation and task state of the Claude app. Keep the Claude app open and check again.",
  ],
  "accessibility-permission-required": [
    "Açık konuşmayı doğrulamak için Relay’e macOS Erişilebilirlik izni ver. Ardından yeniden kontrol et.",
    "Allow Relay in macOS Accessibility to verify the open conversation. Then check again.",
  ],
  "unsupported-platform": [
    "Otomatik devam bu platformda kullanılamıyor.",
    "Automatic continuation is not available on this platform.",
  ],
  "desktop-ui-unsupported": [
    "Claude uygulamasının bu arayüzünün konuşma ve izin kontrolleri doğrulanamadı. Otomatik işlem başlatılmadı.",
    "Relay cannot verify the conversation and permission controls in this Claude app interface. Relay did not start an automatic action.",
  ],
  "adapter-contract-unverified": [
    "Claude uygulamasında geçiş ve mesaj doğrulama desteği henüz hazır değil. Otomatik devam başlatılamıyor.",
    "Switch and message checks in the Claude app are not ready. Automatic continuation cannot start.",
  ],
  "claude-not-running": [
    "Claude uygulamasını açıp devam etmek istediğin yerel Code konuşmasını seç. Ardından yeniden kontrol et.",
    "Open the Claude app and select the local Code conversation to continue. Then check again.",
  ],
  "exact-session-not-observed": [
    "Açık Code konuşması doğrulanamadı. Claude uygulamasında konuşmayı açıp yeniden kontrol et.",
    "Relay cannot verify the open Code conversation. Open it in the Claude app, then check again.",
  ],
  "exact-session-unverified": [
    "Açık Code konuşması doğrulanamadı. Claude uygulamasında konuşmayı açıp yeniden kontrol et.",
    "Relay cannot verify the open Code conversation. Open it in the Claude app, then check again.",
  ],
  "composer-not-empty": [
    "Claude uygulamasının mesaj alanında bir taslak var. Relay taslağın üzerine yazmaz.",
    "The message field in the Claude app has a draft. Relay does not overwrite it.",
  ],
  "permission-mode-mismatch": [
    "Konuşmanın izin modu değişti. Devam mesajı gönderilmedi; modu kontrol edip izlemeyi yeniden aç.",
    "The permission mode of the conversation changed. Relay did not send the continue message. Check the mode and turn watching on again.",
  ],
  "permission-mode-changed": [
    "İzin modu, izlemeyi açtığındaki moddan farklı. Geçiş bekletiliyor; yeni modu kullanmak için izlemeyi kapatıp yeniden aç.",
    "The permission mode is not the same as when watching started. The switch is on hold. To use the new mode, turn watching off and on.",
  ],
  "source-account-changed": [
    "Açık hesap, izlenen kaynak hesabından farklı. Bu hesaptan devam etmek için izlemeyi kapatıp yeniden aç.",
    "The open account is not the watched source account. To continue from this account, turn watching off and on.",
  ],
  "selected-session-changed": [
    "Claude uygulamasında başka bir konuşma açık. Geçiş bekletiliyor; bu konuşmayı izlemek için izlemeyi kapatıp yeniden aç.",
    "A different conversation is open in the Claude app. The switch is on hold. To watch this conversation, turn watching off and on.",
  ],
  "target-identity-changed": [
    "Hedef hesabın girişleri artık başka bir Claude hesabına ait. Hesabın girişlerini kontrol et, sonra izlemeyi kapatıp yeniden aç.",
    "The sign-ins of the target account now belong to another Claude account. Check its sign-ins, then turn watching off and on.",
  ],
  "context-changed": [
    "Açık hesap veya konuşma değişti. Bu izleme durdu; yeni konuşmayı kontrol edip izlemeyi yeniden aç.",
    "The open account or conversation changed. This watch stopped. Check the new conversation and turn watching on again.",
  ],
  "session-changed": [
    "Açık konuşma değişti. Bu izleme durdu; yeni konuşmayı kontrol edip izlemeyi yeniden aç.",
    "The open conversation changed. This watch stopped. Check the new conversation and turn watching on again.",
  ],
  "quota-not-fresh": [
    "Henüz güncel limit verisi yok. Geçiş yapılmadı.",
    "No current usage data yet. Relay did not switch.",
  ],
  "usage-not-fresh": [
    "Henüz güncel limit verisi yok. Geçiş yapılmadı.",
    "No current usage data yet. Relay did not switch.",
  ],
  "target-quota-unavailable": [
    "Hedef hesabın güncel limiti uygun değil. Geçiş yapılmadı.",
    "The current limit of the target account is not available. Relay did not switch.",
  ],
  "automatic-target-unavailable": [
    "Ortak geçmiş kapsamındaki bağlı hesaplarda güncel ve yeterli limit yok. Limitler yenilenince Relay yeniden kontrol eder.",
    "No connected account in the shared history scope has enough current limit. Relay checks again when the limits refresh.",
  ],
  "automatic-target-enrollment-unavailable": [
    "Otomatik geçiş için başka bir hesabın Claude uygulaması girişini ve limit okuma girişini aynı Claude hesabıyla tamamla.",
    "For automatic switching, complete the Claude app and usage sign-ins of another account with the same Claude account.",
  ],
  "target-cooldown": [
    "Hedef hesabın bekleme süresi bitmedi. Süre bitince Relay yeniden kontrol eder.",
    "The target account is in cooldown. Relay checks again when it ends.",
  ],
  "identity-not-enrolled": [
    "Açık ve hedef hesabın Claude uygulaması girişi ile limit okuma girişi aynı Claude hesabına ait olmalı ve doğrulanmalı.",
    "The Claude app and usage sign-ins of the current and target accounts must match and be verified.",
  ],
  "history-boundary": [
    "Bu iki hesap ortak geçmiş kapsamında değil. Kapsamı Ayarlar → Geçiş → “Code geçmişi” bölümünden düzenle.",
    "These accounts are outside the shared history scope. Change the scope under Settings → Switching → “Code history”.",
  ],
  "browser-sign-in": [
    "Bir hesabın limit okuma girişi sürüyor. Giriş tamamlanana kadar geçiş bekler.",
    "An account’s usage sign-in is in progress. The switch waits until it finishes.",
  ],
  "guarded-native-policy-required": [
    "Bu izleme için yeni devam onayı gerekli. İzlemeyi kapatıp yeniden aç.",
    "This watch needs a new confirmation. Turn watching off and on.",
  ],
  "unfinished-attempt": [
    "Yarım kalan bir geçiş kaydı var. Yeni bir izleme açmadan önce Claude uygulamasındaki konuşmayı kontrol et ve aşağıdan doğrulamayı sürdür.",
    "An incomplete handoff is on record. Before a new watch, check the conversation in the Claude app. Then continue the verification below.",
  ],
  "attempt-interrupted": [
    "Geçiş kesildi. Claude uygulamasındaki hesabı ve konuşmayı kontrol edip aşağıdan doğrulamayı sürdür.",
    "The handoff stopped before it finished. Check the account and conversation in the Claude app. Then continue the verification below.",
  ],
  "quota-episode-already-continued": [
    "Limit dolduğu için duran bu yanıt zaten sürdürüldü. Aynı yanıt için ikinci bir devam mesajı gönderilmez.",
    "Relay already continued this stopped response. Relay does not send a second continue message for it.",
  ],
  "new-turn-not-observed": [
    "Devam mesajından sonraki yanıt henüz doğrulanamadı. Mesaj tekrar gönderilmez; Claude uygulamasındaki konuşmayı kontrol et.",
    "Relay cannot verify the response after the continue message yet. Relay does not send the message again. Check the conversation in the Claude app.",
  ],
  "delivery-accepted": [
    "Devam mesajı alındı; yeni yanıtın başladığı henüz doğrulanmadı. Mesaj tekrar gönderilmez.",
    "The Claude app accepted the continue message. Relay has not verified the new response yet. Relay does not send the message again.",
  ],
  "delivery-unknown": [
    "Devam mesajının ulaşıp ulaşmadığı kesinleşmedi. Tekrar gönderilmez; Claude uygulamasındaki konuşmayı kontrol et.",
    "Relay cannot confirm whether the continue message arrived. Relay does not send it again. Check the conversation in the Claude app.",
  ],
  "delivery-ambiguous": [
    "Devam mesajının ulaşıp ulaşmadığı kesinleşmedi. Tekrar gönderilmez; Claude uygulamasındaki konuşmayı kontrol et.",
    "Relay cannot confirm whether the continue message arrived. Relay does not send it again. Check the conversation in the Claude app.",
  ],
  "reconciliation-required": [
    "Yarım kalan işlemi Claude uygulamasında kontrol et. Çift mesaj göndermemek için otomatik devam durduruldu.",
    "Check the incomplete action in the Claude app. Automatic continuation stopped to prevent duplicate messages.",
  ],
  continued: [
    "Aynı konuşmada devam doğrulandı. Bu tek seferlik izleme tamamlandı.",
    "Relay verified the continuation in the same conversation. This one-time watch is complete.",
  ],
  "new-turn-verified": [
    "Aynı konuşmada yeni yanıtın başladığı ve izin modunun korunduğu doğrulandı. Bu tek seferlik izleme tamamlandı.",
    "A new response started in the same conversation, with the same permission mode. This one-time watch is complete.",
  ],
  "durable-delivery-confirmed": [
    "Bu konuşmanın devamı kayıt üzerinden doğrulandı. İkinci bir mesaj gönderilmedi.",
    "Relay verified the continuation from the saved record. Relay did not send a second message.",
  ],
  "preview-only": [
    "Bu önizleme Claude uygulamasına bağlanmaz. Bu kontroller için Relay uygulamasını kullan.",
    "This preview does not connect to the Claude app. Use the Relay app for these checks.",
  ],
};

const readinessExplanations: Record<
  ContinuationTargetReadinessReason,
  [string, string]
> = {
  "source-not-enrolled": [
    "Kaynak hesabın Claude uygulaması girişi ile limit okuma girişi aynı hesaba ait olmalı ve doğrulanmalı.",
    "The Claude app and usage sign-ins of the source account must match and be verified.",
  ],
  "identity-not-enrolled": [
    "Aynı hesaba ait Claude uygulaması girişi ve limit okuma girişi gerekli.",
    "Needs a Claude app sign-in and a usage sign-in for the same account.",
  ],
  "duplicate-identity": [
    "Kaynakla aynı hesap; hedef olamaz.",
    "Same account as the source. Cannot be a target.",
  ],
  "history-boundary": [
    "Bu hesap ortak geçmiş kapsamına dahil değil.",
    "This account is outside the shared history scope.",
  ],
  "quota-not-fresh": [
    "Son 5 dakika içinde doğrulanmış limit gerekli. Hesaplar sayfasından limitleri yenile.",
    "Needs usage data from the last 5 min. Refresh limits on the Accounts page.",
  ],
  "five-hour-unavailable": [
    "5 saatlik limit verisi yok; otomatik geçiş hedefi olamaz.",
    "No 5-hour limit data. Cannot be an automatic target.",
  ],
  "quota-window-invalid": [
    "Limitin yenilenme zamanı güncel değil. Hesaplar sayfasından limitleri yenile.",
    "The limit reset time is out of date. Refresh limits on the Accounts page.",
  ],
  "target-quota-unavailable": [
    "5 saatlik veya haftalık limitin %90’ı ya da fazlası kullanıldı.",
    "90% or more of the 5-hour or weekly limit is used.",
  ],
  "target-cooldown": [
    "Hesap bekleme süresinde.",
    "The account is in cooldown.",
  ],
};

const workExplanations: Record<string, [string, string]> = {
  busyWorkers: [
    "Başka bir yanıt veya işlem çalışıyor. Bitmeden Claude uygulaması yeniden başlatılmaz.",
    "Another response or operation runs. Relay does not restart the Claude app before it finishes.",
  ],
  subagents: [
    "Bir alt görev hâlâ çalışıyor. Alt görevler tamamlanana kadar geçiş bekler.",
    "A subtask still runs. The switch waits until the subtasks finish.",
  ],
  pendingTasks: [
    "Tamamlanmamış görevler var. Bu görevler bitene kadar geçiş bekler.",
    "Some tasks are not finished. The switch waits until they finish.",
  ],
  waiting: [
    "Bir görev onay veya yanıt bekliyor. Claude uygulamasında yanıtla.",
    "A task waits for approval or input. Answer it in the Claude app.",
  ],
  queuedPrompts: [
    "Bekleyen mesajlar var. Relay bu mesajları kesmez; bitmelerini bekler.",
    "Some messages are in the queue. Relay waits for them to finish.",
  ],
  scheduledWakeups: [
    "Planlanmış bir devam işlemi var. Bu işlem doğrulanmadan geçiş yapılmaz.",
    "A continuation is scheduled. The switch waits until Relay verifies it.",
  ],
  unknownWork: [
    "Bazı görevlerin durumu doğrulanamadı. Geçiş bekliyor; Claude uygulamasına müdahale edilmiyor.",
    "Relay cannot verify the state of some tasks. The switch waits. Relay does not change the Claude app.",
  ],
};

function enrolled(account: Account) {
  return (
    !!account.desktop?.accountUuid &&
    !!account.desktop.orgId &&
    account.auth?.loggedIn === true &&
    account.auth.accountUuid?.toLowerCase() ===
      account.desktop.accountUuid.toLowerCase() &&
    account.auth.orgId?.toLowerCase() === account.desktop.orgId.toLowerCase()
  );
}

export function ContinuationSettings({
  accounts,
  active,
  value,
  busy,
  canArm = false,
  blockingReason,
  onRefresh,
  onArm,
  onDisable,
  t,
  usage,
  settings,
  now = Date.now(),
}: {
  accounts: Account[];
  active?: Account;
  value?: ContinuationSettingsView;
  busy: boolean;
  canArm?: boolean;
  blockingReason?: string;
  onRefresh: () => void;
  onArm: () => void;
  onDisable: () => void;
  t: T;
  usage?: Record<string, AccountUsage>;
  settings?: RelaySettings;
  now?: number;
}) {
  const fieldId = useId();
  const [consent, setConsent] = useState(false);
  const status = value?.status ?? "off";
  const watching =
    value?.enabled ?? ["armed", "waiting", "executing"].includes(status);
  const executing = status === "executing";
  const canEnable = canArm && value?.executable !== false;
  const source = accounts.find((a) => a.id === value?.sourceId) ?? active;
  const targets = accounts.filter(
    (a) =>
      a.id !== source?.id &&
      enrolled(a) &&
      !(
        a.desktop?.accountUuid.toLowerCase() ===
          source?.desktop?.accountUuid.toLowerCase() &&
        a.desktop?.orgId.toLowerCase() === source?.desktop?.orgId.toLowerCase()
      ),
  );
  const selectedTarget = accounts.find((a) => a.id === value?.targetId);
  const legacyWatch = watching && value?.targetSelection !== "automatic";
  const enrollmentKey = targets
    .map((a) => `${a.id}:${a.desktop?.accountUuid}:${a.desktop?.orgId}`)
    .sort()
    .join("|");
  const targetCount = watching
    ? (value?.allowedTargetCount ?? targets.length)
    : targets.length;
  const hasTarget = targetCount > 0;
  const readiness =
    usage && settings
      ? accounts
          .filter((account) => account.id !== source?.id)
          .map((account) => ({
            account,
            reason: continuationTargetReadinessReason(
              source,
              account,
              usage[account.id],
              settings,
              now,
            ),
          }))
      : undefined;
  const eligibleCount = readiness?.filter((item) => !item.reason).length ?? 0;
  const operationStatus = [
    "executing",
    "continued",
    "reconciliation-required",
  ].includes(status);
  const reason = operationStatus
    ? value?.reason
    : (blockingReason ?? value?.reason);
  const explanation = reason
    ? (explanations[reason] ??
      (reason.startsWith("not-quiescent:")
        ? workExplanations[reason.slice("not-quiescent:".length)]
        : undefined))
    : undefined;
  const statusLabels: Record<
    ContinuationSettingsView["status"],
    [string, string]
  > = {
    off: ["Kapalı", "Off"],
    armed: ["İzleniyor", "Active"],
    waiting: ["Bekliyor", "On hold"],
    executing: ["Geçiş yapılıyor", "Switch in progress"],
    continued: ["Tamamlandı", "Completed"],
    blocked: ["Kontrol gerekli", "Check required"],
    "reconciliation-required": ["Kontrol gerekli", "Check required"],
  };

  useEffect(() => {
    setConsent(false);
  }, [
    active?.id,
    value?.sessionId,
    value?.permissionMode,
    status,
    enrollmentKey,
  ]);

  const statusDot =
    status === "armed" || status === "continued"
      ? "ok"
      : status === "off"
        ? "off"
        : status === "blocked" || status === "reconciliation-required"
          ? "crit"
          : "warn";
  const panel = "rounded-lg border border-border bg-muted/40 px-3 py-2.5";
  const caption = "block text-xs text-muted-foreground";

  return (
    <section aria-labelledby={`${fieldId}-title`} className="grid gap-3">
      <SectionHeading
        id={`${fieldId}-title`}
        icon={<ShieldCheck size={18} aria-hidden="true" />}
        title={t(
          "Limit dolunca geç ve devam et",
          "Switch and continue when the limit is reached",
        )}
        description={t(
          "Bu Code konuşmasının izin modu korunur.",
          "Relay keeps the permission mode of this Code conversation.",
        )}
        aside={
          <Badge variant="outline">
            {executing ? (
              <LoaderCircle
                size={13}
                className="animate-spin"
                aria-hidden="true"
              />
            ) : status === "continued" ? (
              <Check size={13} aria-hidden="true" />
            ) : (
              <StatusDot tone={statusDot} />
            )}
            {t(...statusLabels[status])}
          </Badge>
        }
      />

      <div className="grid items-stretch gap-2 sm:grid-cols-[1fr_auto_1fr]">
        <div className={panel}>
          <span className={caption}>{t("Kaynak hesap", "Source account")}</span>
          <strong className="block text-sm font-semibold">
            {source?.name ?? t("Henüz doğrulanmadı", "Not verified yet")}
          </strong>
          <small className={caption}>
            {source?.desktop?.email ? <Private>{source.desktop.email}</Private> : t(
                "Claude uygulaması girişi gerekli",
                "Claude app sign-in required",
              )}
          </small>
        </div>
        <ArrowRight
          size={18}
          aria-hidden="true"
          className="hidden self-center text-muted-foreground sm:block"
        />
        <div className={panel}>
          <span className={caption}>
            {t("Hesap seçimi", "Account selection")}
          </span>
          <strong className="block text-sm font-semibold">
            {selectedTarget && (operationStatus || legacyWatch)
              ? selectedTarget.name
              : t(
                  "Otomatik · kalan kapasiteye göre",
                  "Automatic · by remaining capacity",
                )}
          </strong>
          <small className={caption}>
            {selectedTarget && (operationStatus || legacyWatch)
              ? selectedTarget.desktop?.email && <Private>{selectedTarget.desktop.email}</Private>
              : t(
                  `${targetCount} bağlı hesap · geçiş anında değerlendirilir`,
                  `${targetCount} connected ${targetCount === 1 ? "account" : "accounts"} · checked at handoff`,
                )}
          </small>
          {!hasTarget && (
            <small className={caption}>
              {t(
                "Başka bir hesabın Claude uygulaması ve limit okuma girişlerini tamamla.",
                "Complete another account’s Claude app and usage sign-ins.",
              )}
            </small>
          )}
        </div>
      </div>

      {!watching && !operationStatus && readiness && (
        <div className={panel}>
          <strong className="text-sm font-semibold">
            {t(
              `${eligibleCount} hesapta yeterli limit doğrulandı`,
              `Enough limit verified on ${eligibleCount} ${eligibleCount === 1 ? "account" : "accounts"}`,
            )}
          </strong>
          <Note>
            {t(
              "Bu yalnızca şu anki limit kontrolü. Relay geçiş sırasında yeniden doğrular.",
              "This is only the current limit check. Relay checks again at handoff.",
            )}
          </Note>
          <ul
            className="mt-2 grid gap-1"
            aria-label={t(
              "Hesap hazırlık durumu",
              "Account readiness",
            )}
          >
            {readiness.map(({ account, reason }) => (
              <li
                key={account.id}
                className="flex items-baseline justify-between gap-3 text-sm"
              >
                <strong className="font-medium">{account.name}</strong>
                <span className="text-right text-muted-foreground">
                  {reason
                    ? t(...readinessExplanations[reason])
                    : usage?.[account.id]?.sevenDay
                      ? t(
                          "5 saatlik ve haftalık limit uygun.",
                          "5-hour and weekly limits are available.",
                        )
                      : t(
                          "5 saatlik limit uygun; haftalık limit bildirilmiyor.",
                          "5-hour limit is available. No weekly limit reported.",
                        )}
                </span>
              </li>
            ))}
          </ul>
          {settings?.usageRefreshMinutes !== 5 && (
            <Note className="mt-2">
              {t(
                "Otomatik geçiş en fazla 5 dakikalık limit verisini kullanır. Ayarlar’da “Limitleri otomatik yenile” için “5 dakikada bir” seç.",
                "Automatic switching needs usage data from the last 5 min. In Settings, set “Refresh limits automatically” to “Every 5 min”.",
              )}
            </Note>
          )}
        </div>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        <div className={panel}>
          <span className={caption}>{t("Konuşma", "Conversation")}</span>
          <strong className="block break-all text-sm font-semibold">
            {value?.projectKey ??
              t(
                "Claude uygulamasındaki açık Code konuşması",
                "Open Code conversation in the Claude app",
              )}
          </strong>
          {value?.sessionId && (
            <code
              className="block break-all text-xs text-muted-foreground"
              title={value.sessionId}
            >
              {value.sessionId}
            </code>
          )}
        </div>
        <div className={panel}>
          <span className={caption}>
            {t("Korunacak izin modu", "Permission mode to keep")}
          </span>
          <strong className="block text-sm font-semibold">
            {value?.permissionMode ??
              t("Henüz kontrol edilmedi", "Not checked yet")}
          </strong>
        </div>
      </div>

      <div className={`${panel} text-sm`} role="status" aria-live="polite">
        <p>
          {value?.executable === false && (!reason || reason === "disabled")
            ? t(
                "Claude uygulamasında güvenli geçiş ve mesaj doğrulaması bu ortamda hazır değil. Otomatik devam etkinleştirilemez.",
                "Safe switch and message checks are not ready in this environment. Automatic continuation cannot be enabled.",
              )
            : explanation
              ? t(...explanation)
              : executing
                ? t(
                    "Hesap, aynı konuşma ve izin modu doğrulanıyor. Devam mesajı yalnızca doğrulama sonrası gönderilir.",
                    "Relay verifies the account, the conversation and the permission mode. Relay sends the continue message only after this.",
                  )
                : status === "blocked" || status === "reconciliation-required"
                  ? t(
                      "Güvenli devam koşulları doğrulanamadı. Claude uygulamasındaki konuşmayı kontrol edip yeniden dene.",
                      "Relay cannot verify that continuation is safe. Check the conversation in the Claude app, then try again.",
                    )
                  : value?.executable === false
                    ? t(
                        "Claude uygulamasında güvenli geçiş ve mesaj doğrulaması bu ortamda hazır değil. Otomatik devam etkinleştirilemez.",
                        "Safe switch and message checks are not ready in this environment. Automatic continuation cannot be enabled.",
                      )
                    : !canEnable
                      ? t(
                          "Açık konuşma ve bütün görevlerin durumu doğrulanmalı. Kontrol tamamlanmadan otomatik geçiş açılmaz.",
                          "Relay must first verify the open conversation and all tasks. Until then, automatic switching stays off.",
                        )
                      : t(
                          "Bu konuşma için izlemeyi aç; uygun hesabı Relay seçer.",
                          "Turn on watching for this conversation. Relay selects an eligible account.",
                        )}
        </p>
      </div>

      {!watching && (
        <div className="flex items-start gap-3">
          <Switch
            id={`${fieldId}-consent`}
            size="sm"
            className="mt-0.5"
            checked={consent}
            disabled={busy || !canEnable || !hasTarget}
            onCheckedChange={setConsent}
          />
          <label htmlFor={`${fieldId}-consent`} className="text-sm">
            {t(
              "Limit dolup diğer işler bitince Relay Claude uygulamasını yeniden başlatır. Sonra uygun hesaba geçer ve bu konuşmaya bir devam mesajı gönderir.",
              "When the limit is reached and other work ends, Relay restarts the Claude app. Then it switches to an eligible account and sends one continue message to this conversation.",
            )}
          </label>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {watching ? (
          <Button
            type="button"
            variant="outline"
            disabled={busy || executing}
            onClick={onDisable}
          >
            <Pause size={15} aria-hidden="true" />
            {t("İzlemeyi kapat", "Turn off watching")}
          </Button>
        ) : (
          <Button
            type="button"
            disabled={busy || !canEnable || !hasTarget || !consent}
            onClick={() => {
              if (canEnable && hasTarget && consent) onArm();
            }}
          >
            <Play size={15} aria-hidden="true" />
            {t("Bu konuşmayı izle", "Watch this conversation")}
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          disabled={busy || executing}
          onClick={onRefresh}
        >
          <RefreshIcon className="size-4" />
          {t("Yeniden kontrol et", "Check again")}
        </Button>
      </div>
      {legacyWatch && (
        <Note>
          {t(
            "Bu izleme önceki bir sürümde açıldı ve kayıtlı hedef hesabı kullanıyor. Otomatik hesap seçimine geçmek için izlemeyi kapatıp yeniden aç.",
            "This watch is from an earlier version and keeps its saved target account. To use automatic account selection, turn watching off and on.",
          )}
        </Note>
      )}
      <Note>
        {t(
          "Relay açıkken bu konuşma için bir kez çalışır. Hesap, güncel limit ve plan kapasitesine göre seçilir; sonradan eklenen hesaplar için izlemeyi yeniden aç. Geçiş sırasında Claude uygulamasında yeni iş başlatma.",
          "Runs once for this conversation while Relay is open. Relay selects the account by current limit and plan capacity. To include accounts that you add later, turn watching on again. Do not start new work in the Claude app during a handoff.",
        )}
      </Note>
    </section>
  );
}
