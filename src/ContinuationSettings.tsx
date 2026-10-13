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
import type { Account, AccountUsage, RelaySettings } from "../shared/types";
import {
  continuationTargetReadinessReason,
  type ContinuationTargetReadinessReason,
} from "../shared/continuation-readiness";

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
    "Bu konuşmanın kota nedeniyle durması bekleniyor.",
    "Waiting for this conversation to stop because its quota is exhausted.",
  ],
  "awaiting-quota-stop": [
    "Bu konuşmanın kota nedeniyle durması bekleniyor. Kota yüzdesi tek başına geçiş başlatmaz.",
    "Waiting for this conversation to stop at quota. The quota percentage alone does not trigger a switch.",
  ],
  "checkpointed-handoff": [
    "Kaydedilen konuşma, hedef hesap ve izin modu doğrulanıyor. Devam mesajı yalnızca kontrollerden sonra gönderilir.",
    "Verifying the saved conversation, target account and permission mode. The continuation message is sent only after these checks.",
  ],
  "session-not-stopped": [
    "Yanıt henüz durmadı. Claude yeniden başlatılmadan tamamlanması bekleniyor.",
    "The response has not stopped yet. Waiting for it to finish before restarting Claude.",
  ],
  "quota-stop-unverified": [
    "Bu yanıtın kota nedeniyle durduğu doğrulanamadı. Geçiş yapılmadı; yeniden kontrol et.",
    "Could not verify that this response stopped at quota. No switch was made; check again.",
  ],
  "quota-checkpoint-changed": [
    "Kota nedeniyle duran yanıtın kaydı değişti. Geçiş bekletiliyor; konuşmayı yeniden kontrol et.",
    "The record of the quota-stopped response changed. Switching is paused; check the conversation again.",
  ],
  "own-quota-wakeup-can-takeover": [
    "Bu konuşmanın kota yenilenmesindeki devamı henüz devralınamadı. Çift devam başlatmamak için geçiş bekliyor.",
    "Could not yet take over this conversation’s scheduled quota resume. Switching is waiting to avoid starting two continuations.",
  ],
  "own-quota-wakeup-uncertain": [
    "Claude’un kota yenilenmesinde devam zamanlayıcısının devralındığı kesinleşmedi. Otomatik işlem durduruldu; Claude’daki zamanlayıcıyı kontrol et. Relay aynı işlemi kendiliğinden tekrarlamaz.",
    "Could not confirm takeover of Claude’s scheduled quota resume. Automation stopped; check the timer in Claude. Relay will not repeat the action automatically.",
  ],
  "quota-available": [
    "Kota henüz dolmadı. Seçtiğin konuşma izleniyor.",
    "Quota is still available. Watching your selected conversation.",
  ],
  "source-quota-available": [
    "Kota henüz dolmadı. Seçtiğin konuşma izleniyor.",
    "Quota is still available. Watching your selected conversation.",
  ],
  "quota-exhausted": [
    "Kota doldu. Yanıtın ve diğer görevlerin durması bekleniyor.",
    "Quota exhausted. Waiting for the response and other tasks to stop.",
  ],
  "desktop-work-active": [
    "Çalışan bir görev var. Görevler bitene kadar Claude yeniden başlatılmayacak.",
    "A task is still running. Claude will not restart until the tasks finish.",
  ],
  "workers-not-quiescent": [
    "Çalışan görev veya bekleyen onay var. Bunlar tamamlanınca yeniden kontrol edilecek.",
    "A task is running or waiting for approval. Will check again when these finish.",
  ],
  "desktop-observation-incomplete": [
    "Bütün görevlerin durduğu doğrulanamadı. Geçiş bekliyor; Claude’a müdahale edilmiyor.",
    "Could not verify that all tasks have stopped. The switch is waiting; Claude is left alone.",
  ],
  "quiescence-unverified": [
    "Bütün görevlerin durduğu doğrulanamadı. Geçiş bekliyor; Claude’a müdahale edilmiyor.",
    "Could not verify that all tasks have stopped. The switch is waiting; Claude is left alone.",
  ],
  "coverage-unverified": [
    "Bütün görevlerin durduğu doğrulanamadı. Geçiş bekliyor; Claude’a müdahale edilmiyor.",
    "Could not verify that all tasks have stopped. The switch is waiting; Claude is left alone.",
  ],
  "observation-not-fresh": [
    "Konuşma kontrolü güncel değil. Yeni bir kontrol tamamlanmadan geçiş yapılmaz.",
    "The conversation check is out of date. A fresh check is required before switching.",
  ],
  "desktop-observation-unavailable": [
    "Claude’un konuşma ve görev bilgileri okunamadı. Claude’u açık tutup yeniden kontrol et.",
    "Could not read Claude’s conversation and task state. Keep Claude open and check again.",
  ],
  "accessibility-permission-required": [
    "Claude’un açık konuşmasını doğrulamak için Relay’e macOS Erişilebilirlik izni ver; ardından yeniden kontrol et.",
    "Allow Relay in macOS Accessibility to verify Claude’s open conversation, then check again.",
  ],
  "unsupported-platform": [
    "Desktop’ta otomatik devam bu platformda kullanılamıyor.",
    "Automatic Desktop continuation is unavailable on this platform.",
  ],
  "desktop-ui-unsupported": [
    "Bu Claude arayüzünün konuşma ve izin kontrolleri doğrulanamadı. Otomatik işlem başlatılmadı.",
    "Could not verify conversation and permission controls in this Claude interface. No automatic action was started.",
  ],
  "adapter-contract-unverified": [
    "Desktop geçiş ve mesaj doğrulama desteği henüz hazır değil. Otomatik devam başlatılamıyor.",
    "Desktop switching and message verification are not ready. Automatic continuation cannot start.",
  ],
  "claude-not-running": [
    "Claude’u açıp devam etmek istediğin yerel Code konuşmasını seç; ardından yeniden kontrol et.",
    "Open Claude and choose the local Code conversation to continue, then check again.",
  ],
  "exact-session-not-observed": [
    "Açık Code konuşması doğrulanamadı. Claude’da konuşmayı açıp yeniden kontrol et.",
    "Could not verify the open Code conversation. Open it in Claude, then check again.",
  ],
  "exact-session-unverified": [
    "Açık Code konuşması doğrulanamadı. Claude’da konuşmayı açıp yeniden kontrol et.",
    "Could not verify the open Code conversation. Open it in Claude, then check again.",
  ],
  "composer-not-empty": [
    "Claude’un mesaj alanında bir taslak var. Relay taslağın üzerine yazmayacak.",
    "Claude’s message field has a draft. Relay will not overwrite it.",
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
    "Claude’da başka bir konuşma açık. Geçiş bekletiliyor; bu konuşmayı izlemek için izlemeyi kapatıp yeniden aç.",
    "A different conversation is open in Claude. Switching is paused; turn watching off and on to watch this conversation.",
  ],
  "target-identity-changed": [
    "Hedef hesabın bağlantı kimliği değişti. Bağlantıyı kontrol edip izlemeyi kapat ve yeniden aç.",
    "The target account’s connection identity changed. Check the connection, then turn watching off and on.",
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
    "Ortak geçmiş kapsamındaki bağlı hesaplarda güncel ve yeterli limit bulunamadı. Limitler yenilenince yeniden değerlendirilecek; Claude’a müdahale edilmiyor.",
    "No connected account in the shared history scope has fresh, sufficient quota. Will check again when usage is refreshed; Claude is left alone.",
  ],
  "automatic-target-enrollment-unavailable": [
    "Otomatik geçiş için başka bir hesabın Desktop ve limit bağlantılarını aynı kimlikle tamamla.",
    "Complete matching Desktop and usage connections for another account to enable automatic switching.",
  ],
  "target-cooldown": [
    "Hedef hesabın bekleme süresi bitmedi. Süre bitince yeniden kontrol edilecek.",
    "The target account is still in its cooldown period. Will check again when it ends.",
  ],
  "identity-not-enrolled": [
    "Açık ve hedef hesapların Desktop ve limit bağlantıları aynı kimlikle doğrulanmalı.",
    "The current and target accounts need matching, verified Desktop and usage connections.",
  ],
  "history-boundary": [
    "Bu iki hesap ortak geçmiş kapsamında değil. Hesap geçişi ayarlarından kapsamı düzenle.",
    "These accounts are outside the shared history scope. Update the scope in account switching settings.",
  ],
  "browser-sign-in": [
    "Bir hesabın tarayıcı girişi sürüyor. Giriş tamamlanana kadar geçiş bekler.",
    "An account’s browser sign-in is in progress. Switching waits until sign-in finishes.",
  ],
  "guarded-native-policy-required": [
    "Bu izleme için yeni devam onayı gerekli. İzlemeyi kapatıp yeniden etkinleştir.",
    "This watch needs a new continuation confirmation. Turn watching off and enable it again.",
  ],
  "unfinished-attempt": [
    "Yarım kalan geçiş kaydı var. Yeni bir geçiş açmadan önce Claude’daki konuşmayı kontrol edip aşağıdan doğrulamayı sürdür.",
    "An interrupted handoff is recorded. Check the conversation in Claude and resume verification below before enabling a new handoff.",
  ],
  "attempt-interrupted": [
    "Geçiş kesildi. Claude’daki hesabı ve konuşmayı kontrol edip aşağıdan doğrulamayı sürdür.",
    "The handoff was interrupted. Check the account and conversation in Claude, then resume verification below.",
  ],
  "quota-episode-already-continued": [
    "Bu kota duruşu için zaten devam edildi. Aynı yanıt için ikinci bir devam mesajı gönderilmeyecek.",
    "This quota stop was already continued. A second continuation message will not be sent for the same response.",
  ],
  "new-turn-not-observed": [
    "Devam mesajından sonraki yanıt henüz doğrulanamadı. Mesaj tekrar gönderilmeyecek; Claude’daki konuşmayı kontrol et.",
    "The response after the continuation message could not yet be verified. The message will not be sent again; check the conversation in Claude.",
  ],
  "delivery-accepted": [
    "Devam mesajı alındı; yeni yanıtın başladığı henüz doğrulanmadı. Mesaj tekrar gönderilmez.",
    "The continuation message was accepted; the new response has not yet been verified. The message will not be sent again.",
  ],
  "delivery-unknown": [
    "Devam mesajının ulaşıp ulaşmadığı kesinleşmedi. Tekrar gönderilmeyecek; Claude’daki konuşmayı kontrol et.",
    "Could not confirm whether the continuation message arrived. It will not be sent again; check the conversation in Claude.",
  ],
  "delivery-ambiguous": [
    "Devam mesajının ulaşıp ulaşmadığı kesinleşmedi. Tekrar gönderilmeyecek; Claude’daki konuşmayı kontrol et.",
    "Could not confirm whether the continuation message arrived. It will not be sent again; check the conversation in Claude.",
  ],
  "reconciliation-required": [
    "Yarım kalan işlemi Claude’da kontrol et. Çift mesaj göndermemek için otomatik devam durduruldu.",
    "Check the interrupted action in Claude. Automatic continuation stopped to avoid duplicate messages.",
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
    "Bu önizleme gerçek Claude’a bağlanmaz. Desktop kontrollerini Relay uygulamasında kullan.",
    "This preview does not connect to the real Claude app. Use Desktop checks in the Relay application.",
  ],
};

const readinessExplanations: Record<
  ContinuationTargetReadinessReason,
  [string, string]
> = {
  "source-not-enrolled": [
    "Kaynak hesabın eşleşen Desktop ve limit bağlantısı doğrulanmalı.",
    "Verify matching Desktop and usage connections for the source account.",
  ],
  "identity-not-enrolled": [
    "Eşleşen Desktop ve limit bağlantısı gerekli.",
    "Matching Desktop and usage connections are required.",
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
    "Son 5 dakika içinde doğrulanmış limit gerekli. Hesap kartından limitleri yenile.",
    "Usage verified within the last 5 minutes is required. Refresh it on the account card.",
  ],
  "five-hour-unavailable": [
    "5 saatlik limit verisi yok; otomatik geçiş hedefi olamaz.",
    "5-hour quota is unavailable; cannot be an automatic target.",
  ],
  "weekly-unavailable": [
    "Haftalık limit verisi yok; otomatik geçiş hedefi olamaz.",
    "Weekly quota is unavailable; cannot be an automatic target.",
  ],
  "quota-window-invalid": [
    "Limitin yenilenme zamanı güncel değil. Hesap kartından limitleri yenile.",
    "The quota reset time is not current. Refresh usage on the account card.",
  ],
  "target-quota-unavailable": [
    "5 saatlik veya haftalık kalan limit %10 ya da altında.",
    "5-hour or weekly remaining quota is 10% or less.",
  ],
  "target-cooldown": [
    "Hesap bekleme süresinde.",
    "The account is in cooldown.",
  ],
};

const workExplanations: Record<string, [string, string]> = {
  busyWorkers: [
    "Başka bir yanıt veya işlem çalışıyor. Bitmeden Claude yeniden başlatılmayacak.",
    "Another response or operation is running. Claude will not restart before it finishes.",
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
    "Bir görev onay veya yanıt bekliyor. Claude’daki bekleyen kararı tamamla.",
    "A task is waiting for approval or input. Complete the pending decision in Claude.",
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
    "Bazı görevlerin durumu doğrulanamadı. Geçiş bekliyor; Claude’a müdahale edilmiyor.",
    "Could not verify the state of some tasks. The switch is waiting; Claude is left alone.",
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

  return (
    <section
      className="continuation-settings"
      aria-labelledby={`${fieldId}-title`}
    >
      <div className="continuation-heading">
        <div>
          <h4 id={`${fieldId}-title`}>
            <ShieldCheck size={19} aria-hidden="true" />
            {t("Kota dolunca geç ve devam et", "Switch and continue at quota")}
          </h4>
          <p>
            {t(
              "Relay, güncel limiti olan uygun hesabı otomatik seçer ve bu Code konuşmasında devam eder. İzin modu korunur; çalışan görevler varsa geçiş bekler.",
              "Relay automatically chooses an eligible account with current quota and continues this Code conversation. Preserve its permission mode; wait while tasks are running.",
            )}
          </p>
        </div>
        <span className={`continuation-badge ${status}`}>
          {executing ? (
            <LoaderCircle size={13} className="spin" aria-hidden="true" />
          ) : status === "continued" ? (
            <Check size={13} aria-hidden="true" />
          ) : (
            <span aria-hidden="true" className="continuation-dot" />
          )}
          {t(...statusLabels[status])}
        </span>
      </div>

      <div className="continuation-route">
        <div className="continuation-source">
          <span>{t("Kaynak hesap", "Source account")}</span>
          <strong>
            {source?.name ?? t("Henüz doğrulanmadı", "Not verified yet")}
          </strong>
          <small>
            {source?.desktop?.email ??
              t("Desktop bağlantısı gerekli", "Desktop connection required")}
          </small>
        </div>
        <ArrowRight size={18} aria-hidden="true" />
        <div className="continuation-target">
          <span>{t("Hesap seçimi", "Account selection")}</span>
          <strong>
            {selectedTarget && (operationStatus || legacyWatch)
              ? selectedTarget.name
              : t(
                  "Otomatik · kalan kapasiteye göre",
                  "Automatic · by remaining capacity",
                )}
          </strong>
          <small>
            {selectedTarget && (operationStatus || legacyWatch)
              ? selectedTarget.desktop?.email
              : t(
                  `${targetCount} bağlı hesap · geçiş anında değerlendirilir`,
                  `${targetCount} connected accounts · checked at handoff`,
                )}
          </small>
          {!hasTarget && (
            <small>
              {t(
                "Başka bir hesabın Desktop ve limit bağlantısını tamamla.",
                "Complete another account’s Desktop and usage connections.",
              )}
            </small>
          )}
        </div>
      </div>

      {!watching && !operationStatus && readiness && (
        <div className="continuation-readiness">
          <strong>
            {t(
              `${eligibleCount} hesabın hedef kapasitesi doğrulandı`,
              `${eligibleCount} accounts have verified target capacity`,
            )}
          </strong>
          <p>
            {t(
              "Bu, şu anki limit kontrolüdür. Geçiş sırasında kayıtlı hesap kapsamı, kaynak kota ve görevlerin durumu yeniden doğrulanır.",
              "This checks current quota only. The saved account scope, source quota and task state are verified again at handoff.",
            )}
          </p>
          <ul
            aria-label={t(
              "Hesap hazırlık durumu",
              "Account preparation status",
            )}
          >
            {readiness.map(({ account, reason }) => (
              <li key={account.id}>
                <strong>{account.name}</strong>
                <span>
                  {reason
                    ? t(...readinessExplanations[reason])
                    : t(
                        "5 saatlik ve haftalık limit uygun.",
                        "5-hour and weekly quota are available.",
                      )}
                </span>
              </li>
            ))}
          </ul>
          {settings?.usageRefreshMinutes !== 5 && (
            <p>
              {t(
                "Otomatik geçiş en fazla 5 dakikalık limit verisi kullanır. Kullanım ayarlarında 5 dakikalık yenileme seç; daha uzun aralıkta geçiş yeni veriyi bekleyebilir.",
                "Automatic switching uses usage data at most 5 minutes old. Choose 5-minute refresh in Usage settings; longer intervals can delay switching until a fresh check.",
              )}
            </p>
          )}
        </div>
      )}

      <div className="continuation-session">
        <div>
          <span>{t("Konuşma", "Conversation")}</span>
          <strong>
            {value?.projectKey ??
              t(
                "Claude’daki açık Code konuşması",
                "Open Code conversation in Claude",
              )}
          </strong>
          {value?.sessionId && (
            <code title={value.sessionId}>{value.sessionId}</code>
          )}
        </div>
        <div className="continuation-permission">
          <span>{t("Korunacak izin modu", "Permission mode to preserve")}</span>
          <strong>
            {value?.permissionMode ??
              t("Kontrol bekleniyor", "Awaiting verification")}
          </strong>
        </div>
      </div>

      <div
        className={`continuation-feedback ${status}`}
        role="status"
        aria-live="polite"
      >
        <p>
          {value?.executable === false && (!reason || reason === "disabled")
            ? t(
                "Desktop’ta güvenli geçiş ve mesaj doğrulaması bu ortamda hazır değil. Otomatik devam etkinleştirilemez.",
                "Safe Desktop switching and message verification are not ready in this environment. Automatic continuation cannot be enabled.",
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
                      "Güvenli devam koşulları doğrulanamadı. Claude’daki konuşmayı kontrol edip yeniden dene.",
                      "Could not verify safe continuation conditions. Check the conversation in Claude and try again.",
                    )
                  : value?.executable === false
                    ? t(
                        "Desktop’ta güvenli geçiş ve mesaj doğrulaması bu ortamda hazır değil. Otomatik devam etkinleştirilemez.",
                        "Safe Desktop switching and message verification are not ready in this environment. Automatic continuation cannot be enabled.",
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
        <label className="continuation-consent" htmlFor={`${fieldId}-consent`}>
          <input
            id={`${fieldId}-consent`}
            type="checkbox"
            checked={consent}
            disabled={busy || !canEnable || !hasTarget}
            onChange={(event) => setConsent(event.target.checked)}
          />
          <span>
            {t(
              "Kota nedeniyle yanıt durunca ve diğer işler bitince, bu konuşmanın kota yenilenmesinde otomatik devamını devral; Claude’u yeniden başlat, şu an bağlı hesaplarımdan limiti uygun olana otomatik geç ve aynı konuşmaya tek devam mesajı gönder.",
              "When this response stops at quota and other work finishes, take over this conversation’s scheduled quota resume; restart Claude, automatically switch to an eligible account connected now and send one continuation message in the same conversation.",
            )}
          </span>
        </label>
      )}

      <div className="continuation-actions">
        {watching ? (
          <button
            type="button"
            className="secondary"
            disabled={busy || executing}
            onClick={onDisable}
          >
            <Pause size={15} aria-hidden="true" />
            {t("İzlemeyi kapat", "Turn off watching")}
          </button>
        ) : (
          <button
            type="button"
            className="primary"
            disabled={busy || !canEnable || !hasTarget || !consent}
            onClick={() => {
              if (canEnable && hasTarget && consent) onArm();
            }}
          >
            <Play size={15} aria-hidden="true" />
            {t("Bu konuşmayı izle", "Watch this conversation")}
          </button>
        )}
        <button
          type="button"
          className="secondary"
          disabled={busy || executing}
          onClick={onRefresh}
        >
          <RefreshCw size={15} aria-hidden="true" />
          {t("Yeniden kontrol et", "Check again")}
        </button>
      </div>
      {legacyWatch && (
        <p className="continuation-footnote">
          {t(
            "Bu önceki izleme, kayıtlı hedef hesabı kullanır. Otomatik hesap seçimine geçmek için izlemeyi kapatıp yeniden aç.",
            "This earlier watch retains its saved target account. Turn watching off and on to use automatic account selection.",
          )}
        </p>
      )}
      <p className="continuation-footnote">
        {t(
          "Seçim, güncel 5 saatlik ve haftalık kalan limit ile plan kapasitesine göre yapılır. Yalnızca ortak geçmiş kapsamındaki hesaplar kullanılır. Sonradan eklenen hesaplar için izlemeyi yeniden aç.",
          "Selection uses fresh remaining 5-hour and weekly quota, weighted by plan capacity. Only accounts in the shared history scope are used. Enable watching again to include accounts added later.",
        )}
      </p>
      <p className="continuation-footnote">
        {t(
          "Relay açıkken bu konuşma için bir kez çalışır. Çalışan yanıt veya alt görevler taşınmaz. Geçiş, bütün işler durduktan sonra Claude’un yeniden başlatılmasıyla yapılır.",
          "Runs once for this conversation while Relay is open. Running responses and subtasks are not transferred. Switching restarts Claude after all work has stopped.",
        )}
      </p>
      <p className="continuation-footnote">
        {t(
          "Deneysel arayüz kontrolü: geçiş sırasında Claude’da yeni iş başlatma veya açık konuşmayı değiştirme. Mesajın ulaştığı kesinleşmezse Relay tekrar göndermez.",
          "Experimental interface control: do not start new work or change the open conversation in Claude during a handoff. Relay does not resend a message whose delivery is uncertain.",
        )}
      </p>
    </section>
  );
}
