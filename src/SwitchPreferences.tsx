import type { Account, AutoSwitchState, RelaySettings } from "../shared/types";
import { historySources } from "../shared/history-policy";
import { AutoSwitchStatus } from "./AutoSwitchStatus";
import { desktopCliMismatch } from "../shared/account-state";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Note,
  OptionSelect,
  SectionHeading,
  SettingRow,
} from "@/components/SettingRow";
import { StatusDot } from "@/components/StatusDot";

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
    <fieldset
      className="mt-1 rounded-lg border border-border p-3 disabled:opacity-60"
      disabled={disabled}
    >
      <legend className="px-1 text-[13px] font-medium">
        {label}{" "}
        <span className="text-muted-foreground">
          {selected.filter((id) => accounts.some((a) => a.id === id)).length} /{" "}
          {accounts.length}
        </span>
      </legend>
      <div className="mb-1 flex gap-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => update(accounts.map((a) => a.id))}
        >
          {t("Tümünü seç", "Select all")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => update([])}
        >
          {t("Seçimi temizle", "Clear selection")}
        </Button>
      </div>
      <div className="grid gap-1">
        {accounts.map((a) => {
          const ready = !!a.desktop && !desktopCliMismatch(a);
          return (
            <label
              key={a.id}
              className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted/60"
            >
              <Switch
                size="sm"
                aria-label={a.name}
                checked={selected.includes(a.id)}
                onCheckedChange={(checked) =>
                  update(
                    checked
                      ? [...selected, a.id]
                      : selected.filter((id) => id !== a.id),
                  )
                }
              />
              <span className="min-w-0 flex-1">
                <strong className="block truncate text-sm font-medium">
                  {a.name}
                </strong>
                <small className="block truncate text-xs text-muted-foreground">
                  {a.desktop?.email ??
                    (!desktopCliMismatch(a) ? a.auth?.email : undefined) ??
                    t("E-posta henüz bağlanmadı", "Email not connected yet")}
                </small>
              </span>
              <Badge variant="outline" className="text-muted-foreground">
                <StatusDot tone={ready ? "ok" : "warn"} />
                {desktopCliMismatch(a)
                  ? t(
                      "Bağlantı kimlikleri farklı",
                      "Connection identities differ",
                    )
                  : a.desktop
                    ? t("Desktop bağlı", "Desktop connected")
                    : t("Desktop kurulumu gerekli", "Desktop setup required")}
              </Badge>
            </label>
          );
        })}
        {!accounts.length && (
          <Note>{t("Önce hesap ekle.", "Add an account first.")}</Note>
        )}
      </div>
    </fieldset>
  );
}

type Props = {
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
};

/** Shared Code history: scope, selection and the merge into the open account. */
export function SharedHistoryPreferences({
  value,
  accounts,
  active,
  update,
  disabled,
  syncDisabled,
  sync,
  t,
}: Pick<
  Props,
  | "value"
  | "accounts"
  | "active"
  | "update"
  | "disabled"
  | "syncDisabled"
  | "sync"
  | "t"
>) {
  const sources = active ? historySources(active, accounts, value) : [];
  return (
    <div className="grid gap-1">
      <SectionHeading
        title={t("Ortak Code geçmişi", "Shared Code history")}
        description={t(
          "Geçişten sonra Code konuşmaların diğer hesapta da görünür.",
          "After a switch, your Code conversations appear in the other account too.",
        )}
      />
      <SettingRow
        label={t("Geçmişi paylaş", "Share history")}
        htmlFor="history-transfer"
        description={t(
          "Her hesap geçişinde birleştirilir.",
          "Merged on every account switch.",
        )}
      >
        <OptionSelect
          id="history-transfer"
          value={value.desktopHistoryTransfer}
          disabled={disabled}
          onChange={(desktopHistoryTransfer) =>
            update({ desktopHistoryTransfer })
          }
          options={[
            {
              value: "all",
              label: t("Tüm hesaplar arasında", "Between all accounts"),
            },
            {
              value: "same-group",
              label: t("Aynı paylaşım grubunda", "Within sharing group"),
            },
            {
              value: "selected",
              label: t(
                "Seçtiğim hesaplar arasında",
                "Between selected accounts",
              ),
            },
            { value: "off", label: t("Paylaşma", "Do not share") },
          ]}
        />
      </SettingRow>
      {value.desktopHistoryTransfer === "all" && (
        <Note>
          {t(
            "Desktop’a bağlı tüm hesaplar, kişisel ya da şirket, Code geçmişini paylaşır.",
            "All Desktop-connected accounts, personal or work, share Code history.",
          )}
        </Note>
      )}
      {value.desktopHistoryTransfer === "selected" && (
        <>
          <Note>
            {t(
              "Seçili hesaplar, farklı şirketlerden olsalar da Code geçmişini paylaşır.",
              "Selected accounts share Code history, even across companies.",
            )}
          </Note>
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
      <div className="mt-1 flex items-center justify-between gap-4 rounded-lg border border-border bg-muted/40 px-3 py-2.5">
        <p className="text-[13px]">
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
        <Button
          type="button"
          variant="outline"
          className="shrink-0"
          disabled={syncDisabled || disabled || !active || !sources.length}
          onClick={sync}
        >
          {t("Açık hesapla birleştir…", "Merge into current account…")}
        </Button>
      </div>
      <Note>
        {t(
          "Yalnızca yerel Code geçmişi; Chat ve bulut oturumları eşitlenmez.",
          "Local Code history only; Chat and cloud sessions are not synced.",
        )}
      </Note>
    </div>
  );
}

/** After-exit preparation: when to switch, which accounts, and its status. */
export function AfterExitPreferences({
  value,
  accounts,
  autoSwitch,
  platform,
  update,
  disabled,
  t,
}: Pick<
  Props,
  "value" | "accounts" | "autoSwitch" | "platform" | "update" | "disabled" | "t"
>) {
  const supported = platform === "darwin" || platform === "preview";
  return (
    <div className="grid gap-1">
      <SectionHeading
        title={t(
          "Claude kapanınca sıradaki hesabı hazırla",
          "Prepare the next account after Claude exits",
        )}
        description={t(
          "Kota dolduğunda sonraki hesabı hazırla.",
          "Prepare the next account when a quota is exhausted.",
        )}
      />
      <SettingRow
        label={t("Geçiş zamanı", "When to switch")}
        htmlFor="auto-switch-mode"
        description={t(
          "Kota dolup Claude kapandığında sıradaki hesabı hazırlar. Claude’u kendisi açıp kapatmaz.",
          "When quota runs out and Claude has exited, prepares the next account. Never opens or quits Claude.",
        )}
      >
        <OptionSelect
          id="auto-switch-mode"
          value={value.autoSwitchMode}
          disabled={disabled}
          onChange={(autoSwitchMode) => update({ autoSwitchMode })}
          options={[
            { value: "off", label: t("Kapalı", "Off") },
            {
              value: "after-exit",
              label: t("Claude kapandıktan sonra", "After Claude exits"),
              disabled: !supported,
            },
          ]}
        />
      </SettingRow>
      {!supported && (
        <Note>
          {t(
            "Otomatik geçiş bu sürümde macOS’ta kullanılabilir.",
            "Automatic switching is available on macOS in this release.",
          )}
        </Note>
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
          <Note>
            {t(
              "Açık ve hedef hesapları seç. Hedefte en az %10 limit kalmalı.",
              "Select the current and target accounts. The target needs at least 10% quota left.",
            )}
          </Note>
          {value.usageRefreshMinutes === 0 && (
            <Note>
              {t(
                "Otomatik geçiş için düzenli limit yenilemeyi aç.",
                "Enable regular usage refresh for automatic switching.",
              )}
            </Note>
          )}
          <AutoSwitchStatus value={autoSwitch} accounts={accounts} t={t} />
        </>
      )}
      <div className="mt-1 rounded-lg border border-border bg-muted/40 px-3 py-2.5">
        <strong className="text-sm font-semibold">
          {t(
            "Çalışan görevler tamamlanmayı bekler",
            "Running tasks must finish first",
          )}
        </strong>
        <Note>
          {t(
            "Başka iş çalışırken Claude yeniden başlatılmaz.",
            "Claude is not restarted while other work runs.",
          )}
        </Note>
      </div>
    </div>
  );
}

/** Both sections in one stack (used by the legacy Preferences panel). */
export function SwitchPreferences(props: Props) {
  return (
    <div className="grid gap-6">
      <SharedHistoryPreferences {...props} />
      <AfterExitPreferences {...props} />
    </div>
  );
}
