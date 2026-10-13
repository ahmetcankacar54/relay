import { useEffect, useId, useState } from "react";
import { CalendarClock, Check, ChevronDown, Play, Search } from "lucide-react";
import type {
  Account,
  AccountPlanning,
  AccountUsage,
  WorkdaySettings,
} from "../shared/types";
import {
  validWorkday,
  workdayPlan,
  type PlanningReason,
} from "../shared/planning";
import type { RoutineSnapshot } from "../electron/core/routines";
import { DailySchedule } from "./DailySchedule";
import { TimePicker } from "./TimePicker";
import { TimeZonePicker } from "./TimeZonePicker";
import { PlanEditor } from "./PlanEditor";

type T = (tr: string, en: string) => string;
function routineReason(reason: string, t: T) {
  const labels: Record<string, [string, string]> = {
    missed: ["Planlanan saat kaçırıldı", "Scheduled time missed"],
    "account-in-use": ["Hesap kullanımda", "Account in use"],
    "already-active": ["Pencere zaten açık", "Window already active"],
    "routine-policy-unverified": [
      "Yönetim politikası doğrulanamadı",
      "Management policy unverified",
    ],
    "routine-platform-unsupported": [
      "Bu platformda rutin desteklenmiyor",
      "Routines unavailable on this platform",
    ],
    "routine-cli-unsupported": [
      "CLI izolasyon seçeneklerini desteklemiyor",
      "CLI does not support isolation flags",
    ],
    "routine-cli-unavailable": ["CLI bulunamadı", "CLI not found"],
    "routine-credentials-unavailable": ["CLI girişini yenile", "Reconnect CLI"],
    "settings-changed": ["Ayarlar değişti", "Settings changed"],
    "routine-settings-changed": ["Ayarlar değişti", "Settings changed"],
    "identity-mismatch": ["Hesap kimliği farklı", "Identity mismatch"],
    "usage-not-fresh": ["Güncel kota okunamadı", "Fresh quota unavailable"],
    "usage-incomplete": ["Limit verisi eksik", "Incomplete quota data"],
    reserve: ["Kota rezerv sınırında", "Quota at reserve limit"],
    cooldown: ["Bekleme süresinde", "On cooldown"],
    "server-reset-unconfirmed": [
      "Sunucu sıfırlanma zamanı doğrulanmadı",
      "Server reset time unconfirmed",
    ],
  };
  return labels[reason]
    ? t(...labels[reason])
    : t("İstek tamamlanamadı", "Request could not complete");
}
function reasonLabel(reason: PlanningReason | undefined, t: T) {
  if (!reason) return t("Uygun", "Ready");
  const labels: Record<PlanningReason, [string, string]> = {
    "not-selected": ["Seçili değil", "Not selected"],
    "auth-required": ["CLI bağlantısı gerekli", "CLI connection required"],
    "identity-mismatch": ["Hesap kimliği farklı", "Identity mismatch"],
    "duplicate-identity": [
      "Aynı hesaba bağlı başka profil",
      "Duplicate account profile",
    ],
    cooldown: ["Bekleme süresinde", "On cooldown"],
    "usage-not-fresh": ["Limit verisini yenile", "Refresh usage data"],
    "usage-incomplete": ["İki limit de gerekli", "Both usage limits required"],
    reserve: ["Ayrılan kota sınırında", "At reserved quota limit"],
    "already-active": ["Pencere zaten açık", "Window already active"],
    "outside-workday": ["Çalışma aralığı dışında", "Outside working hours"],
  };
  return t(...labels[reason]);
}
export function WorkdayPreferences({
  value,
  accounts,
  usage,
  routines,
  platform,
  update,
  updateAccount,
  disabled,
  t,
}: {
  value: WorkdaySettings;
  accounts: Account[];
  usage: Record<string, AccountUsage>;
  routines?: RoutineSnapshot;
  platform: string;
  update: (value: WorkdaySettings) => void;
  updateAccount: (id: string, input: AccountPlanning) => void;
  disabled: boolean;
  t: T;
}) {
  const formId = useId();
  const saved = JSON.stringify(value);
  const [draft, setDraft] = useState<WorkdaySettings>(() =>
    structuredClone(value),
  );
  const [confirm, setConfirm] = useState(false);
  const [validation, setValidation] = useState("");
  const [accountQuery, setAccountQuery] = useState("");
  useEffect(() => {
    setDraft(JSON.parse(saved));
    setConfirm(false);
    setValidation("");
  }, [saved]);
  const patch = (input: Partial<WorkdaySettings>) => {
    setDraft((s) => ({ ...s, ...input }));
    setValidation("");
    setConfirm(false);
  };
  const plan = workdayPlan(accounts, usage, draft);
  const planComplete = validWorkday(draft) && draft.weekdays.length > 0;
  const unsaved = saved !== JSON.stringify(draft);
  const filteredAccounts = accounts.filter((account) =>
    `${account.name} ${account.auth?.email ?? account.desktop?.email ?? ""}`
      .toLocaleLowerCase(t("tr", "en"))
      .includes(accountQuery.toLocaleLowerCase(t("tr", "en"))),
  );
  const recommended = accounts.find(
    (a) => a.id === plan.rankings.find((r) => !r.reason)?.accountId,
  );
  const format = (date: string) => {
    try {
      return new Intl.DateTimeFormat(t("tr-TR", "en-GB"), {
        timeZone: draft.timeZone,
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(new Date(date));
    } catch {
      return "—";
    }
  };
  const submit = (approved = false) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: draft.timeZone });
    } catch {
      setValidation(
        t("Geçerli bir saat dilimi seç.", "Choose a valid time zone."),
      );
      return;
    }
    if (!draft.weekdays.length) {
      setValidation(t("En az bir gün seç.", "Select at least one day."));
      return;
    }
    if (draft.routineEnabled && !draft.accountIds.length) {
      setValidation(
        t(
          "Rutin için en az bir hesap seç.",
          "Select at least one account for routines.",
        ),
      );
      return;
    }
    if (!validWorkday(draft)) {
      setValidation(
        t(
          "Saatleri ve sayı aralıklarını kontrol et. Birden fazla hesabın rutinleri arasında en az 1 dakika bırak.",
          "Check times and numeric ranges. Leave at least 1 minute between routines for multiple accounts.",
        ),
      );
      return;
    }
    if (draft.routineEnabled && !value.routineEnabled && !approved) {
      setConfirm(true);
      return;
    }
    update(draft);
    setConfirm(false);
  };
  return (
    <section className="workday-preferences">
      <div className="planning-section-title">
        <div>
          <h4>
            <CalendarClock size={17} />
            {t("Günlük kullanım planı", "Daily usage plan")}
          </h4>
          <p>
            {t(
              "Gününü ve hesap pencerelerini aynı yerde gör.",
              "See your day and account windows in one place.",
            )}
          </p>
        </div>
        <span className="pill">
          {value.routineEnabled
            ? t("Rutinler açık", "Routines on")
            : t("Rutinler kapalı", "Routines off")}
        </span>
      </div>
      <DailySchedule
        accounts={accounts}
        usage={usage}
        workday={draft}
        plan={plan}
        unsaved={unsaved}
        t={t}
      />
      {recommended && (
        <div className="planning-recommendation">
          <span>{t("Şu an önerilen hesap", "Recommended account now")}</span>
          <strong>{recommended.name}</strong>
          <small>
            {t(
              "Kapasite ve kalan kotalara göre öneri. Geçişi sen başlatırsın.",
              "Suggested from capacity and remaining quota. You start the switch.",
            )}
          </small>
        </div>
      )}
      <section className="planning-schedule-panel">
        <div className="planning-group-heading">
          <h5>{t("Saatler ve günler", "Hours and days")}</h5>
          <span>
            {draft.start === draft.end
              ? t("Tam gün", "Full day")
              : draft.end < draft.start
                ? t("Ertesi güne taşar", "Crosses midnight")
                : `${draft.start}–${draft.end}`}
          </span>
        </div>
        <div className="workday-grid">
          <TimePicker
            id={`${formId}-start`}
            label={t("Başlangıç", "Start")}
            value={draft.start}
            disabled={disabled}
            onChange={(start) => patch({ start })}
            t={t}
          />
          <TimePicker
            id={`${formId}-end`}
            label={t("Bitiş", "End")}
            value={draft.end}
            disabled={disabled}
            onChange={(end) => patch({ end })}
            t={t}
          />
          <TimeZonePicker
            id={`${formId}-zone`}
            label={t("Saat dilimi", "Time zone")}
            value={draft.timeZone}
            disabled={disabled}
            onChange={(timeZone) => patch({ timeZone })}
            t={t}
          />
        </div>
        <fieldset className="workday-days" disabled={disabled}>
          <legend>{t("Başlangıç günleri", "Starting days")}</legend>
          {[1, 2, 3, 4, 5, 6, 0].map((day) => (
            <label key={day}>
              <input
                type="checkbox"
                checked={draft.weekdays.includes(day)}
                onChange={(e) =>
                  patch({
                    weekdays: e.target.checked
                      ? [...draft.weekdays, day]
                      : draft.weekdays.filter((n) => n !== day),
                  })
                }
              />
              <span>
                {t(
                  ["Paz", "Pzt", "Sal", "Çar", "Per", "Cum", "Cmt"][day],
                  ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][day],
                )}
              </span>
            </label>
          ))}
        </fieldset>
      </section>
      <section className="planning-account-panel">
        <div className="planning-group-heading">
          <h5>{t("Hesaplar", "Accounts")}</h5>
          <span>
            {
              draft.accountIds.filter((id) => accounts.some((a) => a.id === id))
                .length
            }{" "}
            / {accounts.length} {t("seçili", "selected")}
          </span>
        </div>
        <p className="planning-inline-note">
          {t(
            "Plan ve kapasite değişiklikleri hemen kaydedilir. Hesap seçimi, saatler ve günler için Planı kaydet’i kullan.",
            "Plan and capacity changes save immediately. Use Save plan for account selection, hours and days.",
          )}
        </p>
        {(accounts.length > 6 || accountQuery !== "") && (
          <label className="planning-account-search">
            <Search size={14} aria-hidden="true" />
            <input
              type="search"
              aria-label={t(
                "Planlama hesaplarını ara",
                "Search planning accounts",
              )}
              placeholder={t(
                "Hesap veya e-posta ara",
                "Search account or email",
              )}
              value={accountQuery}
              onChange={(event) => setAccountQuery(event.target.value)}
            />
          </label>
        )}
        <div className="planning-table-wrap">
          <table className="planning-table account-plan-table">
            <thead>
              <tr>
                <th scope="col">
                  {t("Dahil et / hesap", "Include / account")}
                </th>
                <th scope="col">
                  {t("Plan ve kapasite", "Plan and capacity")}
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredAccounts.map((a) => {
                const rank = plan.rankings.find((r) => r.accountId === a.id);
                const selected = draft.accountIds.includes(a.id);
                const needsSchedule = selected && (!planComplete || !rank);
                const supportsRoutine =
                  ["darwin", "linux", "preview"].includes(platform) &&
                  a.kind === "personal" &&
                  ["pro", "max", "max5", "max20"].includes(
                    a.auth?.subscription?.toLowerCase() ?? "",
                  );
                return (
                  <tr key={a.id}>
                    <th scope="row">
                      <label className="planning-account">
                        <input
                          type="checkbox"
                          disabled={disabled}
                          checked={draft.accountIds.includes(a.id)}
                          onChange={(e) =>
                            patch({
                              accountIds: e.target.checked
                                ? [...draft.accountIds, a.id]
                                : draft.accountIds.filter((id) => id !== a.id),
                            })
                          }
                        />
                        <span>
                          <strong>{a.name}</strong>
                          <small>{a.auth?.email ?? a.desktop?.email}</small>
                          <small
                            className={
                              selected && planComplete && rank && !rank.reason
                                ? "planning-ready"
                                : "planning-muted"
                            }
                          >
                            {needsSchedule
                              ? t("Planı tamamla", "Complete plan")
                              : reasonLabel(
                                  rank?.reason ??
                                    (!selected ? "not-selected" : undefined),
                                  t,
                                )}
                            {!supportsRoutine && (
                              <span className="planning-manual-tag">
                                {t("Yalnızca planlama", "Planning only")}
                              </span>
                            )}
                          </small>
                        </span>
                      </label>
                    </th>
                    <td>
                      <PlanEditor
                        account={a}
                        disabled={disabled}
                        t={t}
                        update={(input) => updateAccount(a.id, input)}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!filteredAccounts.length && (
          <p className="planning-empty">
            {accounts.length
              ? t("Eşleşen hesap yok.", "No matching accounts.")
              : t(
                  "Planlamak için önce bir hesap bağla.",
                  "Connect an account to start planning.",
                )}
          </p>
        )}
      </section>
      <details className="planning-advanced">
        <summary>
          <span>
            <strong>
              {t("Başlangıçlar ve rezerv", "Starters and reserve")}
            </strong>
            <small>
              {t(
                `%${draft.reservePercent} rezerv · ${draft.staggerMinutes} dk aralık · ${draft.warmupLeadMinutes} dk önce`,
                `${draft.reservePercent}% reserve · ${draft.staggerMinutes} min spacing · ${draft.warmupLeadMinutes} min lead`,
              )}
            </small>
          </span>
          <ChevronDown size={16} aria-hidden="true" />
        </summary>
        <div className="workday-grid">
          <label>
            {t("Kota rezervi (%)", "Quota reserve (%)")}
            <input
              type="number"
              min={0}
              max={50}
              value={draft.reservePercent}
              disabled={disabled}
              onChange={(e) =>
                patch({ reservePercent: Number(e.target.value) })
              }
            />
          </label>
          <label>
            {t("Hesaplar arası aralık (dk)", "Account spacing (min)")}
            <input
              type="number"
              min={0}
              max={300}
              value={draft.staggerMinutes}
              disabled={disabled}
              onChange={(e) =>
                patch({ staggerMinutes: Number(e.target.value) })
              }
            />
          </label>
          <label>
            {t("Başlangıçtan önce (dk)", "Lead before start (min)")}
            <input
              type="number"
              min={0}
              max={300}
              value={draft.warmupLeadMinutes}
              disabled={disabled}
              onChange={(e) =>
                patch({ warmupLeadMinutes: Number(e.target.value) })
              }
            />
          </label>
        </div>
        <p className="preference-footnote">
          {t(
            "Örneğin başlangıç 09:00 ve ön süre 300 dakika ise ilk rutin 04:00’e önerilir. Beş saat sonraki sıfırlanma tahminidir; gerçek zaman sunucudan doğrulanır. Pro = 1, Max 5× = 5, Max 20× = 20 göreli kapasite olarak kullanılır; haftalık kota, ayrılan rezerv ve sıfırlanma zamanı önceliği değiştirir.",
            "For example, start 09:00 with a 300-minute lead proposes the first routine at 04:00. A reset five hours later is an estimate; the actual time is verified with the server. Pro = 1, Max 5× = 5, Max 20× = 20 are relative capacities; weekly quota, reserve and reset time affect priority.",
          )}
        </p>
      </details>
      <div className="routine-toggle">
        <label>
          <input
            type="checkbox"
            disabled={
              disabled || !["darwin", "linux", "preview"].includes(platform)
            }
            checked={draft.routineEnabled}
            onChange={(e) => patch({ routineEnabled: e.target.checked })}
          />
          <span>
            <strong>
              {t(
                "Zamanı gelince kısa mesaj gönder",
                "Send a short message at the scheduled time",
              )}
            </strong>
            <small>
              {t(
                "Kullanım penceresini başlatmayı dener ve kota tüketir. Relay açık, bilgisayar uyanık olmalı.",
                "Attempts to start a usage window and consumes quota. Relay must be open and the computer awake.",
              )}
            </small>
          </span>
        </label>
      </div>
      <details className="planning-help">
        <summary>{t("Rutin nasıl çalışır?", "How do routines work?")}</summary>
        <p className="preference-footnote">
          {t(
            "Claude’un açık hesabı çalışırken atlanır. Aktif beş saatlik penceresi olan hesaba tekrar mesaj gönderilmez. Rutinler Desktop’ta hesap değiştirmez ve oturumları devam ettirmez.",
            "Claude’s active account is skipped while the app is running. Accounts with an active 5-hour window are not pinged again. Routines do not switch Desktop accounts or resume sessions.",
          )}
        </p>
        <p className="preference-footnote">
          {t(
            "Otomatik mesaj bu sürümde macOS/Linux üzerinde kişisel Pro/Max CLI bağlantılarında desteklenir. Şirket, Team/Enterprise veya yönetilen hook’u olan hesaplar için yalnızca plan gösterilir; otomatik mesaj atlanır.",
            "Automatic messages currently support personal Pro/Max CLI connections on macOS/Linux. Work, Team/Enterprise or managed-hook accounts receive planning suggestions; automatic messages are skipped.",
          )}
        </p>
        <p className="preference-footnote">
          {t(
            "Kaçırılan saatler sonradan topluca çalıştırılmaz. Rutin kapalıyken grafik yalnızca planını gösterir.",
            "Missed times are not replayed. With routines off, the chart only shows your plan.",
          )}
        </p>
      </details>
      {validation && (
        <p role="alert" className="account-warning">
          {validation}
        </p>
      )}
      {confirm && (
        <div className="routine-confirm" role="alert">
          <strong>
            {t(
              "Kota tüketen rutinleri etkinleştir",
              "Enable quota-consuming routines",
            )}
          </strong>
          <p>
            {t(
              "Seçtiğin hesaplarda belirtilen saatlerde birer ayrı CLI isteği gönderilecek. Projelerin ve mevcut konuşmaların kullanılmaz. İşlem başlamışsa kapatmak o tek isteği geri alamaz.",
              "A separate CLI request will be sent at the scheduled times for selected accounts. Projects and existing conversations are not used. Disabling after a request starts cannot undo that request.",
            )}
          </p>
          <p>
            <strong>
              {accounts
                .filter((a) => draft.accountIds.includes(a.id))
                .map((a) => a.name)
                .join(" · ")}
            </strong>{" "}
            · {draft.timeZone}
          </p>
          <button
            className="primary"
            disabled={disabled}
            onClick={() => submit(true)}
          >
            <Play size={14} />
            {t("Etkinleştir ve kaydet", "Enable and save")}
          </button>
          <button className="text-button" onClick={() => setConfirm(false)}>
            {t("Vazgeç", "Cancel")}
          </button>
        </div>
      )}
      <div className="planning-save">
        <span>
          {saved === JSON.stringify(draft)
            ? t("Ayarlar kaydedildi", "Settings saved")
            : t("Kaydedilmemiş değişiklikler", "Unsaved changes")}
        </span>
        <button
          className="secondary"
          disabled={disabled || saved === JSON.stringify(draft) || confirm}
          onClick={() => submit()}
        >
          <Check size={14} />
          {t("Planı kaydet", "Save plan")}
        </button>
      </div>
      {routines?.error && (
        <p role="alert" className="account-warning">
          {t(
            "Rutin kayıtlarına ulaşılamıyor; otomatik mesaj gönderilmez.",
            "Routine records are unavailable; automatic messages will not be sent.",
          )}
        </p>
      )}
      {!!routines?.entries.length && (
        <details className="routine-log">
          <summary>
            {t("Son rutin sonuçları", "Recent routine results")}
          </summary>
          <ul>
            {routines.entries
              .slice()
              .sort((a, b) => b.scheduledAt.localeCompare(a.scheduledAt))
              .slice(0, 10)
              .map((r) => (
                <li key={r.key}>
                  <strong>
                    {accounts.find((a) => a.id === r.accountId)?.name ??
                      t("Hesap", "Account")}
                  </strong>
                  <span>
                    {format(r.scheduledAt)} ·{" "}
                    {r.status === "verified"
                      ? t("Pencere doğrulandı", "Window verified")
                      : r.status === "sent-unverified"
                        ? t(
                            "Gönderildi; pencere doğrulanmadı",
                            "Sent; window unverified",
                          )
                        : r.status === "failed"
                          ? t("Çalıştırılamadı", "Failed")
                          : r.status === "skipped"
                            ? t("Atlandı", "Skipped")
                            : t("İşlem hazırlanıyor", "Preparing request")}
                    {r.reason && ` · ${routineReason(r.reason, t)}`}
                  </span>
                </li>
              ))}
          </ul>
        </details>
      )}
    </section>
  );
}
