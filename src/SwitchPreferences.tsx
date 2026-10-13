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
            "Geçişten sonra Code konuşmaların diğer hesapta da görünür.",
            "After a switch, your Code conversations appear in the other account too.",
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
              "Her hesap geçişinde birleştirilir.",
              "Merged on every account switch.",
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
          <option value="all">
            {t("Tüm hesaplar arasında", "Between all accounts")}
          </option>
          <option value="same-group">
            {t("Aynı paylaşım grubunda", "Within sharing group")}
          </option>
          <option value="selected">
            {t("Seçtiğim hesaplar arasında", "Between selected accounts")}
          </option>
          <option value="off">{t("Paylaşma", "Do not share")}</option>
        </select>
      </div>
      {value.desktopHistoryTransfer === "all" && (
        <p className="sharing-scope-note">
          {t(
            "Desktop’a bağlı tüm hesaplar, kişisel ya da şirket, Code geçmişini paylaşır.",
            "All Desktop-connected accounts, personal or work, share Code history.",
          )}
        </p>
      )}
      {value.desktopHistoryTransfer === "selected" && (
        <>
          <p className="sharing-scope-note">
            {t(
              "Seçili hesaplar, farklı şirketlerden olsalar da Code geçmişini paylaşır.",
              "Selected accounts share Code history, even across companies.",
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
          "Yalnızca yerel Code geçmişi; Chat ve bulut oturumları eşitlenmez.",
          "Local Code history only; Chat and cloud sessions are not synced.",
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
              "Kota dolup Claude kapandığında sıradaki hesabı hazırlar. Claude’u kendisi açıp kapatmaz.",
              "When quota runs out and Claude has exited, prepares the next account. Never opens or quits Claude.",
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
              "Açık ve hedef hesapları seç. Hedefte en az %10 limit kalmalı.",
              "Select the current and target accounts. The target needs at least 10% quota left.",
            )}
          </p>
          {value.usageRefreshMinutes === 0 && (
            <p className="sharing-scope-note">
              {t(
                "Otomatik geçiş için düzenli limit yenilemeyi aç.",
                "Enable regular usage refresh for automatic switching.",
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
            "Başka iş çalışırken Claude yeniden başlatılmaz.",
            "Claude is not restarted while other work runs.",
          )}
        </p>
      </div>
    </>
  );
}
