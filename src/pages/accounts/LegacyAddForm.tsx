import { useState } from "react";
import { LoaderCircle, X } from "lucide-react";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";

// Temporary: the pre-redesign add-profile form. Task 9 replaces it with a dialog.
export function LegacyAddForm({
  close,
  created,
}: {
  close: () => void;
  /** Called with the new profile id after it is created. */
  created: (id: string) => void;
}) {
  const { api, accounts, busy, action, setNotice } = useRelay();
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"personal" | "work">("personal");
  const [group, setGroup] = useState("");
  return (
    <form
      className="profile-form"
      onSubmit={(e) => {
        e.preventDefault();
        void action("create", async () => {
          const account = await api.createAccount({
            name,
            kind,
            group: kind === "work" && group.trim() ? group.trim() : undefined,
          });
          setName("");
          setGroup("");
          created(account.id);
          setNotice(
            t(
              "Profil oluşturuldu. Bağlantı seçeneklerini aşağıdan seç.",
              "Profile created. Choose a connection option below.",
            ),
          );
        });
      }}
    >
      <div className="form-title">
        <h3>{t("Yeni profil", "New profile")}</h3>
        <button
          type="button"
          className="icon"
          aria-label={t("Formu kapat", "Close form")}
          onClick={close}
        >
          <X size={17} />
        </button>
      </div>
      <div className="form-grid">
        <label>
          {t("Hesap adı", "Account name")}
          <input
            required
            autoFocus
            maxLength={64}
            placeholder={t("Örn. Kişisel Max", "e.g. Personal Max")}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          {t("Tür", "Type")}
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as "personal" | "work")}
          >
            <option value="personal">{t("Kişisel", "Personal")}</option>
            <option value="work">{t("Şirket", "Work")}</option>
          </select>
        </label>
      </div>
      {kind === "work" && (
        <label>
          {t("Paylaşım grubu · isteğe bağlı", "Sharing group · optional")}
          <input
            list="groups"
            maxLength={64}
            value={group}
            onChange={(e) => setGroup(e.target.value)}
            placeholder={t(
              "Aynı gruptaki şirket hesapları Code geçmişini paylaşır",
              "Work accounts in the same group share Code history",
            )}
          />
          <datalist id="groups">
            {[
              ...new Set(
                accounts
                  .filter((a) => a.kind === "work" && a.group !== `work:${a.id}`)
                  .map((a) => a.group.slice(5)),
              ),
            ].map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
        </label>
      )}
      <div className="form-end">
        <small>
          {kind === "personal"
            ? t(
                "Kişisel hesapların Code geçmişi aynı grupta korunur.",
                "Personal accounts share their local Code history.",
              )
            : t(
                "Boş bırakırsan bu şirket hesabı ayrı tutulur.",
                "Leave blank to keep this work account separate.",
              )}
        </small>
        <button className="primary" disabled={!!busy || !name.trim()}>
          {busy === "create" ? <LoaderCircle className="spin" size={15} /> : null}
          {t("Profil oluştur", "Create profile")}
        </button>
      </div>
    </form>
  );
}
