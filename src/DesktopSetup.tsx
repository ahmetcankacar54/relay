import { Monitor, X } from "lucide-react";
import type { Account, DesktopState } from "../shared/types";

export function DesktopSetup({
  account,
  accounts,
  desktop,
  unclaimed,
  org,
  busy,
  t,
  selectAccount,
  selectOrg,
  close,
  connect,
}: {
  account?: Account;
  accounts: Account[];
  desktop?: DesktopState;
  unclaimed: boolean;
  org: string;
  busy: boolean;
  t: (tr: string, en: string) => string;
  selectAccount: (id: string) => void;
  selectOrg: (id: string) => void;
  close: () => void;
  connect: () => void;
}) {
  return (
    <section
      id={account ? `setup-${account.id}` : "desktop-setup-picker"}
      className="desktop-setup"
      aria-label={t("Desktop ilk kurulumu", "First Desktop setup")}
    >
      <div className="form-title">
        <h3>
          <Monitor size={16} />{" "}
          {t("Desktop ilk kurulumu", "First Desktop setup")}
        </h3>
        <button
          className="icon"
          disabled={busy}
          aria-label={t("Kurulumu kapat", "Close setup")}
          onClick={close}
        >
          <X size={16} />
        </button>
      </div>
      <p>
        {unclaimed
          ? t(
              "Claude’da açık hesabı doğru Relay profiliyle eşleştir. E-posta ve çalışma alanı aynı hesaba ait olmalı.",
              "Link the account open in Claude to the matching Relay profile. The email and workspace must belong to that account.",
            )
          : t(
              "Bu profil henüz Desktop’a bağlı değil. Tarayıcı girişi kullanım limitlerini bağlar; Desktop geçişi için bir kez Claude’da da giriş yapman gerekir.",
              "This profile is not connected to Desktop yet. Browser sign-in connects usage limits; switching in Desktop requires one sign-in inside Claude too.",
            )}
      </p>
      {!account && (
        <label className="setup-select">
          {t("Claude’da açık olan hesap", "Account currently open in Claude")}
          <select
            value=""
            onChange={(e) => selectAccount(e.target.value)}
            disabled={busy}
          >
            <option value="">{t("Profil seç", "Choose a profile")}</option>
            {accounts
              .filter((a) => !a.desktop)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.auth?.email ? ` · ${a.auth.email}` : ""}
                </option>
              ))}
          </select>
        </label>
      )}
      {account &&
        unclaimed &&
        (!org || (desktop?.organizations.length ?? 0) > 1) && (
          <label className="setup-select">
            {t("Code çalışma alanı", "Code workspace")}
            <select
              value={org}
              onChange={(e) => selectOrg(e.target.value)}
              disabled={busy}
            >
              <option value="">
                {t(
                  "Code’u aç / çalışma alanı seç",
                  "Open Code / choose workspace",
                )}
              </option>
              {desktop?.organizations.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </label>
        )}
      {account && (
        <div className="panel-actions">
          <button
            className="secondary"
            disabled={busy || (unclaimed && !org)}
            onClick={connect}
          >
            {unclaimed
              ? t("Bu hesabı eşleştir…", "Link this account…")
              : t("Desktop bağlantısını başlat…", "Start Desktop connection…")}
          </button>
          <small>
            {t(
              "Sonraki adımda yeniden başlatmayı onaylarsın.",
              "Review the restart in the next step.",
            )}
          </small>
        </div>
      )}
    </section>
  );
}
