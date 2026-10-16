import { StatusDot } from "@/components/StatusDot";
import type { Account, AutoSwitchState } from "../../shared/types";

export function AutoSwitchStatus({
  value,
  accounts,
  t,
}: {
  value?: AutoSwitchState;
  accounts: Account[];
  t: (tr: string, en: string) => string;
}) {
  if (!value || value.status === "off") return null;
  const target = accounts.find((a) => a.id === value.targetId)?.name;
  const reasons: Record<AutoSwitchState["reason"], [string, string]> = {
    "ledger-unavailable": [
      "Hesap hazırlandı; otomasyon kaydı kaydedilemedi. Tekrarlı geçiş koruması bu Relay çalıştırması için geçerli.",
      "The account was prepared, but the automation record could not be saved. Repeat protection applies for this Relay run.",
    ],
    "exit-settling": [
      "Claude kapalı görünüyor. Kapanışın tamamlanması bekleniyor.",
      "Claude appears closed. Waiting for the exit to settle.",
    ],
    disabled: ["Kapalı", "Off"],
    "unsupported-platform": [
      "Bu platformda otomatik geçiş kullanılamıyor.",
      "Automatic switching is unavailable on this platform.",
    ],
    "not-selected": [
      "Açık hesabı ve en az bir hedefi otomatik geçişe dahil et.",
      "Include the current account and at least one target in automatic switching.",
    ],
    "desktop-unavailable": [
      "Claude Desktop bulunamadı.",
      "Claude Desktop was not found.",
    ],
    "desktop-busy": [
      "Desktop işlemi tamamlanınca tekrar kontrol edilecek.",
      "Will check again after the Desktop action finishes.",
    ],
    "desktop-recovery": [
      "Önce yarım kalan Desktop işlemini geri yükle.",
      "Restore the interrupted Desktop action first.",
    ],
    "desktop-sign-in": [
      "Desktop girişi tamamlanmalı.",
      "Complete the Desktop sign-in first.",
    ],
    "browser-sign-in": [
      "Bir hesabın girişi veya bağlantı yenilemesi sürüyor. Tarayıcıda açık bir giriş varsa Hesaplar sayfasında tamamla veya iptal et.",
      "An account’s sign-in or connection renewal is in progress. If a browser sign-in is open, finish or cancel it on the Accounts page.",
    ],
    "continuation-active": [
      "Kota dolunca devam açık. Kotası dolan konuşmaları o devam ettirir; bu sırada Claude kapanınca hazırlama beklemede.",
      "Continue at quota is on. It continues conversations stopped at quota; preparing on quit waits meanwhile.",
    ],
    "unknown-active": [
      "Açık Desktop hesabını bir Relay profiline bağla.",
      "Link the current Desktop account to a Relay profile.",
    ],
    "source-not-ready": [
      "Açık hesabın bağlantıları doğrulanmalı.",
      "Verify the current account’s connections.",
    ],
    "usage-not-fresh": [
      "Geçiş için güncel limit verisi bekleniyor.",
      "Waiting for fresh usage data before switching.",
    ],
    "quota-available": [
      "Kullanım limiti henüz dolmadı.",
      "Usage quota has not been exhausted.",
    ],
    "no-ready-target": [
      "Kapsama uygun, iki limiti de güncel bir hedef hesap yok.",
      "No eligible target has fresh data and room in both limits.",
    ],
    "claude-running": [
      "Kota doldu. Claude tamamen kapanana kadar geçiş bekliyor.",
      "Quota is exhausted. Waiting for Claude to fully exit.",
    ],
    "already-switched": [
      "Bu limit dönemi için geçiş zaten yapıldı.",
      "Already switched for this quota period.",
    ],
    "retry-backoff": [
      "Geçiş başarısız oldu; yeniden deneme bekliyor. Elle geçişi kontrol edebilirsin.",
      "Switch failed; waiting before retrying. You can review a manual switch.",
    ],
    "switch-failed": [
      "Geçiş tamamlanamadı. Desktop bağlantısını veya kurtarma durumunu kontrol et.",
      "Switch could not finish. Check the Desktop connection or recovery status.",
    ],
    "quota-exhausted": [
      "Kota doldu; seçili hedef hazırlanıyor.",
      "Quota exhausted; preparing the selected target.",
    ],
    prepared: [
      "Sonraki hesap hazır. Claude’u açıp konuşmanı sürdür.",
      "The next account is ready. Open Claude and resume your conversation.",
    ],
  };
  const [tr, en] = reasons[value.reason];
  const tone =
    value.status === "switched"
      ? "ok"
      : value.status === "blocked"
        ? "warn"
        : "off";
  return (
    <div
      className="flex items-start gap-2.5 rounded-lg border border-border bg-muted/40 px-3 py-2.5"
      role="status"
    >
      <StatusDot tone={tone} className="mt-1.5" />
      <div>
        <strong className="text-sm font-semibold">
          {t("Otomatik geçiş", "Automatic switching")}
          {target ? ` · ${target}` : ""}
        </strong>
        <p className="text-[13px] text-muted-foreground">{t(tr, en)}</p>
      </div>
    </div>
  );
}
