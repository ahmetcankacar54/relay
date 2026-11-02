import { useEffect, useId, useState } from "react";
import {
  ArrowRight,
  Check,
  LoaderCircle,
  Pause,
  Play,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
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
    "Waiting for this conversation to stop because its quota is exhausted.",
  ],
  "awaiting-quota-stop": [
    "Bu konuşmanın limit dolduğu için durması bekleniyor. Limit yüzdesi tek başına geçiş başlatmaz.",
    "Waiting for this conversation to stop at quota. The quota percentage alone does not trigger a switch.",
  ],
  "checkpointed-handoff": [
    "Kaydedilen konuşma, hedef hesap ve izin modu doğrulanıyor. Devam mesajı yalnızca kontrollerden sonra gönderilir.",
    "Verifying the saved conversation, target account and permission mode. The continuation message is sent only after these checks.",
  ],
  "session-not-stopped": [
    "Yanıt henüz durmadı. Claude uygulaması yeniden başlatılmadan tamamlanması bekleniyor.",
    "The response has not stopped yet. Waiting for it to finish before restarting the Claude app.",
  ],
  "quota-stop-unverified": [
    "Bu yanıtın limit dolduğu için durduğu doğrulanamadı. Geçiş yapılmadı; yeniden kontrol et.",
    "Could not verify that this response stopped at quota. No switch was made; check again.",
  ],
  "quota-checkpoint-changed": [
    "Limit dolduğu için duran yanıtın kaydı değişti. Geçiş bekletiliyor; konuşmayı yeniden kontrol et.",
    "The record of the quota-stopped response changed. Switching is paused; check the conversation again.",
  ],
  "own-quota-wakeup-can-takeover": [
    "Bu konuşmada Claude’un “Auto-continue when limits reset” seçeneği açık ve Relay onu henüz kapatamadı. Konuşma iki kez sürdürülmesin diye geçiş bekliyor.",
    "Claude’s “Auto-continue when limits reset” is on for this conversation and Relay could not turn it off yet. Switching waits so the conversation is not continued twice.",
  ],
  "own-quota-wakeup-uncertain": [
    "Relay’in, Claude uygulamasındaki “Auto-continue when limits reset” seçeneğini kapatıp kapatmadığı kesinleşmedi. Otomatik işlem durdu; bu seçeneği Claude uygulamasında kontrol et. Relay aynı işlemi kendiliğinden tekrarlamaz.",
    "Relay could not confirm whether it turned off “Auto-continue when limits reset” in the Claude app. Automation stopped; check that option in the Claude app. Relay will not repeat the action on its own.",
  ],
  "quota-available": [
    "Limit henüz dolmadı. Seçtiğin konuşma izleniyor.",
    "Quota is still available. Watching your selected conversation.",
  ],
  "source-quota-available": [
    "Limit henüz dolmadı. Seçtiğin konuşma izleniyor.",
    "Quota is still available. Watching your selected conversation.",
  ],
  "quota-exhausted": [
    "Limit doldu. Yanıtın ve diğer görevlerin durması bekleniyor.",
    "Quota exhausted. Waiting for the response and other tasks to stop.",
  ],
  "desktop-work-active": [
    "Çalışan bir görev var. Görevler bitene kadar Claude uygulaması yeniden başlatılmayacak.",
    "A task is still running. The Claude app will not restart until the tasks finish.",
  ],
  "workers-not-quiescent": [
    "Çalışan görev veya bekleyen onay var. Bunlar tamamlanınca yeniden kontrol edilecek.",
    "A task is running or waiting for approval. Will check again when these finish.",
  ],
  "desktop-observation-incomplete": [
    "Bütün görevlerin durduğu doğrulanamadı. Geçiş bekliyor; Claude uygulamasına müdahale edilmiyor.",
    "Could not verify that all tasks have stopped. The switch is waiting; the Claude app is left alone.",
  ],
  "quiescence-unverified": [
    "Bütün görevlerin durduğu doğrulanamadı. Geçiş bekliyor; Claude uygulamasına müdahale edilmiyor.",
    "Could not verify that all tasks have stopped. The switch is waiting; the Claude app is left alone.",
  ],
  "coverage-unverified": [
    "Bütün görevlerin durduğu doğrulanamadı. Geçiş bekliyor; Claude uygulamasına müdahale edilmiyor.",
    "Could not verify that all tasks have stopped. The switch is waiting; the Claude app is left alone.",
  ],
  "observation-not-fresh": [
    "Konuşma kontrolü güncel değil. Yeni bir kontrol tamamlanmadan geçiş yapılmaz.",
    "The conversation check is out of date. A fresh check is required before switching.",
  ],
  "desktop-observation-unavailable": [
    "Claude uygulamasının konuşma ve görev bilgileri okunamadı. Claude uygulamasını açık tutup yeniden kontrol et.",
    "Could not read the Claude app’s conversation and task state. Keep the Claude app open and check again.",
  ],
  "accessibility-permission-required": [
    "Claude uygulamasının açık konuşmasını doğrulamak için Relay’e macOS Erişilebilirlik izni ver; ardından yeniden kontrol et.",
    "Allow Relay in macOS Accessibility to verify the Claude app’s open conversation, then check again.",
  ],
  "unsupported-platform": [
    "Claude uygulamasında otomatik devam bu platformda kullanılamıyor.",
    "Automatic continuation in the Claude app is unavailable on this platform.",
  ],
  "desktop-ui-unsupported": [
    "Claude uygulamasının bu arayüzünün konuşma ve izin kontrolleri doğrulanamadı. Otomatik işlem başlatılmadı.",
    "Could not verify conversation and permission controls in this Claude app interface. No automatic action was started.",
  ],
  "adapter-contract-unverified": [
    "Claude uygulamasında geçiş ve mesaj doğrulama desteği henüz hazır değil. Otomatik devam başlatılamıyor.",
    "Switching and message verification in the Claude app are not ready. Automatic continuation cannot start.",
  ],
  "claude-not-running": [
    "Claude uygulamasını açıp devam etmek istediğin yerel Code konuşmasını seç; ardından yeniden kontrol et.",
    "Open the Claude app and choose the local Code conversation to continue, then check again.",
  ],
  "exact-session-not-observed": [
    "Açık Code konuşması doğrulanamadı. Claude uygulamasında konuşmayı açıp yeniden kontrol et.",
    "Could not verify the open Code conversation. Open it in the Claude app, then check again.",
  ],
  "exact-session-unverified": [
    "Açık Code konuşması doğrulanamadı. Claude uygulamasında konuşmayı açıp yeniden kontrol et.",
    "Could not verify the open Code conversation. Open it in the Claude app, then check again.",
  ],
  "composer-not-empty": [
    "Claude uygulamasının mesaj alanında bir taslak var. Relay taslağın üzerine yazmayacak.",
    "The Claude app’s message field has a draft. Relay will not overwrite it.",
  ],
  "permission-mode-mismatch": [
    "Konuşmanın izin modu değişti. Devam mesajı gönderilmedi; modu kontrol edip yeniden etkinleştir.",
    "The conversation’s permission mode changed. No continuation message was sent; check the mode and enable again.",
  ],
  "permission-mode-changed": [
    "İzin modu, izlemeyi açtığındaki moddan farklı. Geçiş bekletiliyor; yeni modu kullanmak için izlemeyi kapatıp yeniden aç.",
    "The permission mode differs from the mode captured when watching began. Switching is paused; turn watching off and on to use the new mode.",
  ],
  "source-account-changed": [
    "Açık hesap, izlenen kaynak hesabından farklı. Bu hesaptan devam etmek için izlemeyi kapatıp yeniden aç.",
    "The open account differs from the watched source account. Turn watching off and on to continue from this account.",
  ],
  "selected-session-changed": [
    "Claude uygulamasında başka bir konuşma açık. Geçiş bekletiliyor; bu konuşmayı izlemek için izlemeyi kapatıp yeniden aç.",
    "A different conversation is open in the Claude app. Switching is paused; turn watching off and on to watch this conversation.",
  ],
  "target-identity-changed": [
    "Hedef hesabın girişleri artık başka bir Claude hesabına ait. Hesabın girişlerini kontrol et, sonra izlemeyi kapatıp yeniden aç.",
    "The target account’s sign-ins now belong to another Claude account. Check its sign-ins, then turn watching off and on.",
  ],
  "context-changed": [
    "Açık hesap veya konuşma değişti. Bu izleme durduruldu; yeni konuşmayı kontrol edip yeniden etkinleştir.",
    "The open account or conversation changed. This watch stopped; check the new conversation and enable again.",
  ],
  "session-changed": [
    "Açık konuşma değişti. Bu izleme durduruldu; yeni konuşmayı kontrol edip yeniden etkinleştir.",
    "The open conversation changed. This watch stopped; check the new conversation and enable again.",
  ],
  "quota-not-fresh": [
    "Güncel limit verisi bekleniyor. Geçiş yapılmadı.",
    "Waiting for fresh usage limits. No switch was made.",
  ],
  "usage-not-fresh": [
    "Güncel limit verisi bekleniyor. Geçiş yapılmadı.",
    "Waiting for fresh usage limits. No switch was made.",
  ],
  "target-quota-unavailable": [
    "Hedef hesabın güncel limiti uygun değil. Geçiş yapılmadı.",
    "The target account’s current quota is unavailable. No switch was made.",
  ],
  "automatic-target-unavailable": [
    "Ortak geçmiş kapsamındaki bağlı hesaplarda güncel ve yeterli limit bulunamadı. Limitler yenilenince yeniden değerlendirilecek; Claude uygulamasına müdahale edilmiyor.",
    "No connected account in the shared history scope has fresh, sufficient quota. Will check again when usage is refreshed; the Claude app is left alone.",
  ],
  "automatic-target-enrollment-unavailable": [
    "Otomatik geçiş için başka bir hesabın Claude uygulaması girişini ve limit okuma girişini aynı Claude hesabıyla tamamla.",
    "Complete matching Claude app and usage sign-ins for another account to enable automatic switching.",
  ],
  "target-cooldown": [
    "Hedef hesabın bekleme süresi bitmedi. Süre bitince yeniden kontrol edilecek.",
    "The target account is still in its cooldown period. Will check again when it ends.",
  ],
  "identity-not-enrolled": [
    "Açık ve hedef hesabın Claude uygulaması girişi ile limit okuma girişi aynı Claude hesabına ait olmalı ve doğrulanmalı.",
    "The current and target accounts need matching, verified Claude app and usage sign-ins.",
  ],
  "history-boundary": [
    "Bu iki hesap ortak geçmiş kapsamında değil. Kapsamı Ayarlar → Geçişte taşınanlar → “Code geçmişi” bölümünden düzenle.",
    "These accounts are outside the shared history scope. Change the scope under Settings → What comes along → “Code history”.",
  ],
  "browser-sign-in": [
    "Bir hesabın limit okuma girişi sürüyor. Giriş tamamlanana kadar geçiş bekler.",
    "An account’s usage sign-in is in progress. Switching waits until sign-in finishes.",
  ],
  "guarded-native-policy-required": [
    "Bu izleme için yeni devam onayı gerekli. İzlemeyi kapatıp yeniden etkinleştir.",
    "This watch needs a new continuation confirmation. Turn watching off and enable it again.",
  ],
  "unfinished-attempt": [
    "Yarım kalan bir geçiş kaydı var. Yeni bir izleme açmadan önce Claude uygulamasındaki konuşmayı kontrol et ve aşağıdan doğrulamayı sürdür.",
    "An interrupted handoff is recorded. Check the conversation in the Claude app and resume verification below before enabling a new handoff.",
  ],
  "attempt-interrupted": [
    "Geçiş kesildi. Claude uygulamasındaki hesabı ve konuşmayı kontrol edip aşağıdan doğrulamayı sürdür.",
    "The handoff was interrupted. Check the account and conversation in the Claude app, then resume verification below.",
  ],
  "quota-episode-already-continued": [
    "Limit dolduğu için duran bu yanıt zaten sürdürüldü. Aynı yanıt için ikinci bir devam mesajı gönderilmeyecek.",
    "This quota stop was already continued. A second continuation message will not be sent for the same response.",
  ],
  "new-turn-not-observed": [
    "Devam mesajından sonraki yanıt henüz doğrulanamadı. Mesaj tekrar gönderilmeyecek; Claude uygulamasındaki konuşmayı kontrol et.",
    "The response after the continuation message could not yet be verified. The message will not be sent again; check the conversation in the Claude app.",
  ],
  "delivery-accepted": [
    "Devam mesajı alındı; yeni yanıtın başladığı henüz doğrulanmadı. Mesaj tekrar gönderilmez.",
    "The continuation message was accepted; the new response has not yet been verified. The message will not be sent again.",
  ],
  "delivery-unknown": [
    "Devam mesajının ulaşıp ulaşmadığı kesinleşmedi. Tekrar gönderilmeyecek; Claude uygulamasındaki konuşmayı kontrol et.",
    "Could not confirm whether the continuation message arrived. It will not be sent again; check the conversation in the Claude app.",
  ],
  "delivery-ambiguous": [
    "Devam mesajının ulaşıp ulaşmadığı kesinleşmedi. Tekrar gönderilmeyecek; Claude uygulamasındaki konuşmayı kontrol et.",
    "Could not confirm whether the continuation message arrived. It will not be sent again; check the conversation in the Claude app.",
  ],
  "reconciliation-required": [
    "Yarım kalan işlemi Claude uygulamasında kontrol et. Çift mesaj göndermemek için otomatik devam durduruldu.",
    "Check the interrupted action in the Claude app. Automatic continuation stopped to avoid duplicate messages.",
  ],
  continued: [
    "Aynı konuşmada devam doğrulandı. Bu tek seferlik izleme tamamlandı.",
    "Continuation in the same conversation was verified. This one-time watch is complete.",
  ],
  "new-turn-verified": [
    "Aynı konuşmada yeni yanıtın başladığı ve izin modunun korunduğu doğrulandı. Bu tek seferlik izleme tamamlandı.",
    "Verified that a new response started in the same conversation with its permission mode preserved. This one-time watch is complete.",
  ],
  "durable-delivery-confirmed": [
    "Bu konuşmanın devamı kayıt üzerinden doğrulandı. İkinci bir mesaj gönderilmedi.",
    "Continuation of this conversation was verified from its saved record. A second message was not sent.",
  ],
  "preview-only": [
    "Bu önizleme gerçek Claude uygulamasına bağlanmaz. Claude uygulaması kontrollerini Relay uygulamasında kullan.",
    "This preview does not connect to the real Claude app. Use the Claude app checks in the Relay application.",
  ],
};

const readinessExplanations: Record<
  ContinuationTargetReadinessReason,
  [string, string]
> = {
  "source-not-enrolled": [
    "Kaynak hesabın Claude uygulaması girişi ile limit okuma girişi aynı hesaba ait olmalı ve doğrulanmalı.",
    "Verify matching Claude app and usage sign-ins for the source account.",
  ],
  "identity-not-enrolled": [
    "Aynı hesaba ait Claude uygulaması girişi ve limit okuma girişi gerekli.",
    "Matching Claude app and usage sign-ins are required.",
  ],
  "duplicate-identity": [
    "Kaynakla aynı hesap; alternatif olarak kullanılamaz.",
    "Same identity as the source; cannot be used as an alternative.",
  ],
  "history-boundary": [
    "Bu hesap ortak geçmiş kapsamına dahil değil.",
    "This account is outside the shared history scope.",
  ],
  "quota-not-fresh": [
    "Son 5 dakika içinde doğrulanmış limit gerekli. Hesaplar sayfasından limitleri yenile.",
    "Usage verified within the last 5 minutes is required. Refresh it on the Accounts page.",
  ],
  "five-hour-unavailable": [
    "5 saatlik limit verisi yok; otomatik geçiş hedefi olamaz.",
    "5-hour quota is unavailable; cannot be an automatic target.",
  ],
  "quota-window-invalid": [
    "Limitin yenilenme zamanı güncel değil. Hesaplar sayfasından limitleri yenile.",
    "The quota reset time is not current. Refresh usage on the Accounts page.",
  ],
  "target-quota-unavailable": [
    "5 saatlik veya haftalık limitin %90’ı ya da fazlası kullanıldı.",
    "90% or more of the 5-hour or weekly quota is used.",
  ],
  "target-cooldown": [
    "Hesap bekleme süresinde.",
    "The account is in cooldown.",
  ],
};

const workExplanations: Record<string, [string, string]> = {
  busyWorkers: [
    "Başka bir yanıt veya işlem çalışıyor. Bitmeden Claude uygulaması yeniden başlatılmayacak.",
    "Another response or operation is running. The Claude app will not restart before it finishes.",
  ],
  subagents: [
    "Bir alt görev hâlâ çalışıyor. Alt görevler tamamlanana kadar geçiş bekler.",
    "A subtask is still running. Switching waits until the subtasks finish.",
  ],
  pendingTasks: [
    "Tamamlanmamış görevler var. Bu görevler bitene kadar geçiş bekler.",
    "There are unfinished tasks. Switching waits until they finish.",
  ],
  waiting: [
    "Bir görev onay veya yanıt bekliyor. Claude uygulamasındaki bekleyen kararı tamamla.",
    "A task is waiting for approval or input. Complete the pending decision in the Claude app.",
  ],
  queuedPrompts: [
    "Bekleyen mesajlar var. Relay bu mesajları kesmez; tamamlanmaları beklenir.",
    "There are queued messages. Relay leaves these alone and waits for them to finish.",
  ],
  scheduledWakeups: [
    "Planlanmış bir devam işlemi var. Bu işlem doğrulanmadan geçiş yapılmaz.",
    "A continuation is scheduled. Switching waits until this operation is verified.",
  ],
  unknownWork: [
    "Bazı görevlerin durumu doğrulanamadı. Geçiş bekliyor; Claude uygulamasına müdahale edilmiyor.",
    "Could not verify the state of some tasks. The switch is waiting; the Claude app is left alone.",
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
    armed: ["İzleniyor", "Watching"],
    waiting: ["Bekliyor", "Waiting"],
    executing: ["Geçiş yapılıyor", "Switching"],
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
          "Limit dolunca uygun hesaba geçer ve bu Code konuşmasında devam eder. İzin modu korunur.",
          "When the limit is reached, switches to an eligible account and continues this Code conversation. Its permission mode is kept.",
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
            {source?.desktop?.email ??
              t(
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
              ? selectedTarget.desktop?.email
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
              `Enough quota verified on ${eligibleCount} ${eligibleCount === 1 ? "account" : "accounts"}`,
            )}
          </strong>
          <Note>
            {t(
              "Bu yalnızca şu anki limit kontrolü. Geçiş sırasında kayıtlı hesap kapsamı, kaynak hesabın limiti ve görevlerin durumu yeniden doğrulanır.",
              "This checks current quota only. The saved account scope, source quota and task state are verified again at handoff.",
            )}
          </Note>
          <ul
            className="mt-2 grid gap-1"
            aria-label={t(
              "Hesap hazırlık durumu",
              "Account preparation status",
            )}
          >
            {readiness.map(({ account, reason }) => (
              <li
                key={account.id}
                className="flex items-baseline justify-between gap-3 text-[13px]"
              >
                <strong className="font-medium">{account.name}</strong>
                <span className="text-right text-muted-foreground">
                  {reason
                    ? t(...readinessExplanations[reason])
                    : usage?.[account.id]?.sevenDay
                      ? t(
                          "5 saatlik ve haftalık limit uygun.",
                          "5-hour and weekly quota are available.",
                        )
                      : t(
                          "5 saatlik limit uygun; haftalık limit bildirilmiyor.",
                          "5-hour quota is available; no weekly limit reported.",
                        )}
                </span>
              </li>
            ))}
          </ul>
          {settings?.usageRefreshMinutes !== 5 && (
            <Note className="mt-2">
              {t(
                "Otomatik geçiş en fazla 5 dakikalık limit verisini kullanır. Ayarlar’da “Limitleri otomatik yenile” için “5 dakikada bir” seç; daha uzun aralıkta geçiş yeni veriyi bekleyebilir.",
                "Automatic switching uses usage data at most 5 minutes old. Choose “Every 5 minutes” for “Refresh limits automatically” in Settings; longer intervals can delay switching until a fresh check.",
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
            {t("Korunacak izin modu", "Permission mode to preserve")}
          </span>
          <strong className="block text-sm font-semibold">
            {value?.permissionMode ??
              t("Kontrol bekleniyor", "Awaiting verification")}
          </strong>
        </div>
      </div>

      <div className={`${panel} text-[13px]`} role="status" aria-live="polite">
        <p>
          {value?.executable === false && (!reason || reason === "disabled")
            ? t(
                "Claude uygulamasında güvenli geçiş ve mesaj doğrulaması bu ortamda hazır değil. Otomatik devam etkinleştirilemez.",
                "Safe switching and message verification in the Claude app are not ready in this environment. Automatic continuation cannot be enabled.",
              )
            : explanation
              ? t(...explanation)
              : executing
                ? t(
                    "Hesap, aynı konuşma ve izin modu doğrulanıyor. Devam mesajı yalnızca doğrulama sonrası gönderilir.",
                    "Verifying the account, same conversation and permission mode. The continuation message is sent only after verification.",
                  )
                : status === "blocked" || status === "reconciliation-required"
                  ? t(
                      "Güvenli devam koşulları doğrulanamadı. Claude uygulamasındaki konuşmayı kontrol edip yeniden dene.",
                      "Could not verify safe continuation conditions. Check the conversation in the Claude app and try again.",
                    )
                  : value?.executable === false
                    ? t(
                        "Claude uygulamasında güvenli geçiş ve mesaj doğrulaması bu ortamda hazır değil. Otomatik devam etkinleştirilemez.",
                        "Safe switching and message verification in the Claude app are not ready in this environment. Automatic continuation cannot be enabled.",
                      )
                    : !canEnable
                      ? t(
                          "Açık konuşma ve bütün görevlerin durumu doğrulanmalı. Kontrol tamamlanmadan otomatik geçiş etkinleştirilmez.",
                          "The open conversation and all task states need verification. Automatic switching stays disabled until the check succeeds.",
                        )
                      : t(
                          "Bu konuşma için izlemeyi etkinleştir; uygun hesabı Relay seçsin.",
                          "Enable watching for this conversation; Relay will choose an eligible account.",
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
          <label htmlFor={`${fieldId}-consent`} className="text-[13px]">
            {t(
              "Limit dolunca ve diğer işler bitince Claude uygulamasını yeniden başlat, uygun hesaba geç ve bu konuşmaya bir devam mesajı gönder.",
              "When the limit is reached and other work finishes, restart the Claude app, switch to an eligible account and send one continuation message to this conversation.",
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
          <RefreshCw size={15} aria-hidden="true" />
          {t("Yeniden kontrol et", "Check again")}
        </Button>
      </div>
      {legacyWatch && (
        <Note>
          {t(
            "Bu izleme önceki bir sürümde açıldı ve kayıtlı hedef hesabı kullanıyor. Otomatik hesap seçimine geçmek için izlemeyi kapatıp yeniden aç.",
            "This earlier watch retains its saved target account. Turn watching off and on to use automatic account selection.",
          )}
        </Note>
      )}
      <Note>
        {t(
          "Relay açıkken bu konuşma için bir kez çalışır. Hesap, güncel limit ve plan kapasitesine göre seçilir; sonradan eklenen hesaplar için izlemeyi yeniden aç. Geçiş sırasında Claude uygulamasında yeni iş başlatma.",
          "Runs once for this conversation while Relay is open. The account is chosen by current quota and plan capacity; enable watching again to include accounts added later. Don’t start new work in the Claude app during a handoff.",
        )}
      </Note>
    </section>
  );
}
