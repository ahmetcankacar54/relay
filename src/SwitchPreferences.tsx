import type { Account, AutoSwitchState, RelaySettings } from "../shared/types";
import { historySources } from "../shared/history-policy";
import { AutoSwitchStatus } from "./AutoSwitchStatus";
import { desktopCliMismatch } from "../shared/account-state";

type T = (tr: string, en: string) => string;
function AccountSelection({
  accounts,
  selected,
  update,
  disabled,
  label,
  t,
}: {
  accounts: Account[];
  selected: string[];
  update: (ids: string[]) => void;
  disabled: boolean;
  label: string;
  t: T;
}) {
  return (
    <fieldset className="account-selection" disabled={disabled}>
      <legend>
        {label}{" "}
        <span>
          {selected.filter((id) => accounts.some((a) => a.id === id)).length} /{" "}
          {accounts.length}
        </span>
      </legend>
      <div className="selection-actions">
        <button
          type="button"
          className="text-button"
          onClick={() => update(accounts.map((a) => a.id))}
        >
          {t("Tümünü seç", "Select all")}
        </button>
        <button
          type="button"
          className="text-button"
          onClick={() => update([])}
        >
          {t("Seçimi temizle", "Clear selection")}
        </button>
      </div>
      <div className="selection-list">
        {accounts.map((a) => (
          <label key={a.id} className="selection-account">
            <input
              type="checkbox"
              checked={selected.includes(a.id)}
              onChange={(e) =>
                update(
                  e.target.checked
                    ? [...selected, a.id]
                    : selected.filter((id) => id !== a.id),
                )
              }
            />
            <span>
              <strong>{a.name}</strong>
              <small>
                {a.desktop?.email ??
                  (!desktopCliMismatch(a) ? a.auth?.email : undefined) ??
                  t("E-posta henüz bağlanmadı", "Email not connected yet")}
              </small>
            </span>
            <small
              className={
                a.desktop && !desktopCliMismatch(a)
                  ? "selection-ready"
                  : "selection-missing"
              }
            >
              {desktopCliMismatch(a)
                ? t(
                    "Bağlantı kimlikleri farklı",
                    "Connection identities differ",
                  )
                : a.desktop
                  ? t("Desktop bağlı", "Desktop connected")
                  : t("Desktop kurulumu gerekli", "Desktop setup required")}
            </small>
          </label>
        ))}
        {!accounts.length && (
          <p>{t("Önce hesap ekle.", "Add an account first.")}</p>
        )}
      </div>
    </fieldset>
  );
}

export function SwitchPreferences({
  value,
  accounts,
  active,
  autoSwitch,
  platform,
  update,
  disabled,
  syncDisabled,
  sync,
  t,
}: {
  value: RelaySettings;
  accounts: Account[];
  active?: Account;
  autoSwitch?: AutoSwitchState;
  platform: string;
  update: (patch: Partial<RelaySettings>) => void;
  disabled: boolean;
  syncDisabled: boolean;
  sync: () => void;
  t: T;
}) {
  const sources = active ? historySources(active, accounts, value) : [];
  const supported = platform === "darwin" || platform === "preview";
  return (
    <>
      <div className="preference-section-heading">
        <h4>{t("Ortak Code geçmişi", "Shared Code history")}</h4>
        <p>
          {t(
            "Konuşmalarını Claude’un Code sekmesinde kullanmaya devam et.",
            "Keep working with your conversations in Claude’s Code tab.",
          )}
        </p>
      </div>
      <div className="preference-row">
        <div>
          <label htmlFor="history-transfer">
            {t("Geçmişi paylaş", "Share history")}
          </label>
          <p>
            {t(
              "Seçilen kapsam, bağlantı ve hesap geçişlerinde birleştirilir. Kapatmak önceki kopyaları silmez.",
              "Your chosen scope is merged on connections and account switches. Turning it off keeps existing copies.",
            )}
          </p>
        </div>
        <select
          id="history-transfer"
          value={value.desktopHistoryTransfer}
          disabled={disabled}
          onChange={(e) =>
            update({
              desktopHistoryTransfer: e.target
                .value as RelaySettings["desktopHistoryTransfer"],
            })
          }
        >
          <option value="same-group">
            {t("Aynı paylaşım grubunda", "Within sharing group")}
          </option>
          <option value="selected">
            {t("Seçtiğim hesaplar arasında", "Between selected accounts")}
          </option>
          <option value="off">{t("Paylaşma", "Do not share")}</option>
        </select>
      </div>
      {value.desktopHistoryTransfer === "selected" && (
        <>
          <p className="sharing-scope-note">
            {t(
              "Bu hesaplar, farklı şirket veya kuruluşlara ait olsalar da birbirlerinin yerel Code oturumlarını ve proje kayıtlarını alır. Paylaşım için en az iki hesap seç.",
              "These accounts receive each other’s local Code sessions and project records, including across companies or organizations. Select at least two accounts.",
            )}
          </p>
          <AccountSelection
            accounts={accounts}
            selected={value.desktopHistoryAccounts}
            update={(ids) => update({ desktopHistoryAccounts: ids })}
            disabled={disabled}
            label={t("Geçmişi paylaşan hesaplar", "Accounts sharing history")}
            t={t}
          />
        </>
      )}
      <div className="history-sync-row">
        <p>
          {active
            ? sources.length
              ? t(
                  `${active.name} için ${sources.length} hesabın geçmişi birleştirilecek.`,
                  `${sources.length} account histories will be merged into ${active.name}.`,
                )
              : t(
                  `${active.name} için paylaşılacak hesap seçili değil.`,
                  `No sharing sources are selected for ${active.name}.`,
                )
            : t(
                "Önce açık Desktop hesabını bağla.",
                "Link the current Desktop account first.",
              )}
        </p>
        <button
          className="secondary"
          disabled={syncDisabled || disabled || !active || !sources.length}
          onClick={sync}
        >
          {t("Açık hesapla birleştir…", "Merge into current account…")}
        </button>
      </div>
      <p className="preference-footnote">
        {t(
          "Yerel Code geçmişi içindir. Claude Chat, bulut oturumları ve sunucudaki Projects eşitlenmez. Eksik konuşma dosyaları otomatik oluşturulmaz.",
          "For local Code history. Claude Chat, cloud sessions and server Projects are not synchronized. Missing conversation files are not recreated.",
        )}
      </p>
      <div className="preference-section-heading">
        <h4>
          {t(
            "Claude kapandıktan sonra hesap hazırlama",
            "Prepare an account after Claude exits",
          )}
        </h4>
        <p>
          {t(
            "Kota dolduğunda sonraki hesabı hazırla.",
            "Prepare the next account when a quota is exhausted.",
          )}
        </p>
      </div>
      <div className="preference-row">
        <div>
          <label htmlFor="auto-switch-mode">
            {t("Geçiş zamanı", "When to switch")}
          </label>
          <p>
            {t(
              "Relay açıkken çalışır. Kullanım %100’e ulaşırsa ve Claude tamamen kapandıysa kayıtlı hesaba geçer. Claude’u kapatmaz veya açmaz.",
              "Runs while Relay is open. Switches to a saved account when usage reaches 100% and Claude has fully exited. Does not close or open Claude.",
            )}
          </p>
        </div>
        <select
          id="auto-switch-mode"
          value={value.autoSwitchMode}
          disabled={disabled}
          onChange={(e) =>
            update({
              autoSwitchMode: e.target.value as RelaySettings["autoSwitchMode"],
            })
          }
        >
          <option value="off">{t("Kapalı", "Off")}</option>
          <option value="after-exit" disabled={!supported}>
            {t("Claude kapandıktan sonra", "After Claude exits")}
          </option>
        </select>
      </div>
      {!supported && (
        <p className="sharing-scope-note">
          {t(
            "Otomatik geçiş bu sürümde macOS’ta kullanılabilir.",
            "Automatic switching is available on macOS in this release.",
          )}
        </p>
      )}
      {value.autoSwitchMode !== "off" && (
        <>
          <AccountSelection
            accounts={accounts}
            selected={value.autoSwitchAccounts}
            update={(ids) => update({ autoSwitchAccounts: ids })}
            disabled={disabled}
            label={t(
              "Otomatik geçişe dahil hesaplar",
              "Accounts eligible for automatic switching",
            )}
            t={t}
          />
          <p className="preference-footnote">
            {t(
              "Hem açık hem hedef hesabı seç. Hedefin Desktop ve limit bağlantıları hazır olmalı; iki limitinde de %10’dan fazla kalmalı. Farklı şirketler arasında geçiş için ortak geçmiş kapsamına da ikisini ekle.",
              "Select both the current and target account. The target needs Desktop and usage connections, with more than 10% remaining in both limits. For a switch across companies, include both in the shared history scope too.",
            )}
          </p>
          {value.usageRefreshMinutes === 0 && (
            <p className="sharing-scope-note">
              {t(
                "Limit yenileme elle seçili. Otomasyon güncel kota olmadan geçiş yapmaz; düzenli yenileme aç.",
                "Usage refresh is manual. Automation cannot switch without fresh quota data; enable regular refresh.",
              )}
            </p>
          )}
          <AutoSwitchStatus value={autoSwitch} accounts={accounts} t={t} />
        </>
      )}
      <div className="capability-note">
        <strong>
          {t(
            "Çalışan görevler tamamlanmayı bekler",
            "Running tasks must finish first",
          )}
        </strong>
        <p>
          {t(
            "Aşağıdaki otomatik devam, kota nedeniyle durmuş yerel Code konuşması içindir. Başka bir yanıt, alt görev veya bekleyen onay varsa Claude yeniden başlatılmaz. Bulut ve SSH işleri bu kapsamda değildir.",
            "Automatic continuation below applies to a local Code conversation stopped at quota. Claude does not restart while another response, subtask or approval is pending. Cloud and SSH work are outside this scope.",
          )}
        </p>
      </div>
    </>
  );
}
