import type { Account, RelaySettings } from "../../shared/types";
import { historySources } from "../../shared/history-policy";
import { desktopCliMismatch } from "../../shared/account-state";
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

/** A switch per account, with select-all and clear. */
export function AccountSelection({
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
                      "Girişler farklı hesaplara ait",
                      "Sign-ins belong to different accounts",
                    )
                  : a.desktop
                    ? t("Claude uygulaması kayıtlı", "Claude app saved")
                    : t(
                        "Claude uygulaması girişi gerekli",
                        "Claude app sign-in needed",
                      )}
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
  update: (patch: Partial<RelaySettings>) => void;
  disabled: boolean;
  syncDisabled: boolean;
  sync: () => void;
  t: T;
};

/** Re-typing the drafts rescued at a switch into Claude: experimental, off unless turned on. */
export function DraftRetypePreference({
  value,
  update,
  disabled,
  t,
}: Pick<Props, "value" | "update" | "disabled" | "t">) {
  return (
    <div className="grid gap-1">
      <SectionHeading title={t("Kurtarılan taslaklar", "Rescued drafts")} />
      <SettingRow
        label={
          <span className="inline-flex items-center gap-2">
            {t("Taslakları Claude uygulamasına yeniden yaz", "Re-type drafts into the Claude app")}
            <Badge variant="outline" className="text-muted-foreground">
              {t("Deneysel", "Experimental")}
            </Badge>
          </span>
        }
        htmlFor="draft-retype"
        description={t(
          "Kapalıyken taslaklar kurtarılır ve panelde Kopyala ile sunulur. Açıkken Relay geçişten sonra konuşmayı açar ve taslağı mesaj kutusuna yazar, göndermez. Erişilebilirlik izni ister.",
          "While off, drafts are rescued and offered in the panel with Copy. While on, Relay opens the conversation after a switch and types the draft into its message box without sending it. It needs Accessibility permission.",
        )}
      >
        <Switch
          id="draft-retype"
          checked={value.draftRetype === true}
          disabled={disabled}
          onCheckedChange={(draftRetype) => update({ draftRetype })}
        />
      </SettingRow>
    </div>
  );
}

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
  // "Paylaşma": nothing is shared, so nothing may say it is.
  const off = value.desktopHistoryTransfer === "off";
  // What the chosen scope shares; "same-group" is explained by its label.
  const scope =
    value.desktopHistoryTransfer === "all"
      ? t(
          "Claude uygulaması girişi kayıtlı tüm hesaplar, kişisel ya da şirket, Code geçmişini paylaşır.",
          "All accounts with a saved Claude app sign-in, personal or work, share Code history.",
        )
      : value.desktopHistoryTransfer === "selected"
        ? t(
            "Seçili hesaplar, farklı şirketlerden olsalar da Code geçmişini paylaşır.",
            "Selected accounts share Code history, even across companies.",
          )
        : "";
  return (
    <div className="grid gap-1">
      <SectionHeading
        title={t("Ortak Code geçmişi", "Shared Code history")}
        description={
          off
            ? t(
                "Code konuşmaların her hesapta ayrı kalır.",
                "Your Code conversations stay separate in each account.",
              )
            : value.desktopHistoryTransfer === "all"
              ? t(
                  "Geçişten sonra Code konuşmaların bağlı her hesapta görünür.",
                  "After a switch, your Code conversations appear in every connected account.",
                )
              : value.desktopHistoryTransfer === "selected"
                ? t(
                    "Geçişten sonra Code konuşmaların seçtiğin hesaplarda görünür.",
                    "After a switch, your Code conversations appear in the accounts you picked.",
                  )
                : t(
                    "Geçişten sonra Code konuşmaların aynı gruptaki hesaplarda görünür.",
                    "After a switch, your Code conversations appear in the accounts of the same group.",
                  )
        }
      />
      <SettingRow
        label={t("Geçmişi paylaş", "Share history")}
        htmlFor="history-transfer"
        description={
          off
            ? t(
                "Hesaplar arasında birleştirilmez.",
                "Not merged between accounts.",
              )
            : t(
                "Her hesap geçişinde birleştirilir.",
                "Merged on every account switch.",
              )
        }
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
      <Note>
        {off
          ? t(
              "Code geçmişi hesaplar arasında paylaşılmaz.",
              "Code history is not shared between accounts.",
            )
          : [
              scope,
              t(
                "Yalnızca yerel Code geçmişi paylaşılır; Chat ve bulut oturumları eşitlenmez.",
                "Only local Code history is shared; Chat and cloud sessions are not synced.",
              ),
            ]
              .filter(Boolean)
              .join(" ")}
      </Note>
      {value.desktopHistoryTransfer === "selected" && (
        <AccountSelection
          accounts={accounts}
          selected={value.desktopHistoryAccounts}
          update={(ids) => update({ desktopHistoryAccounts: ids })}
          disabled={disabled}
          label={t("Geçmişi paylaşan hesaplar", "Accounts sharing history")}
          t={t}
        />
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
                "Önce Claude uygulamasında açık hesabı bağla.",
                "Link the account open in the Claude app first.",
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
    </div>
  );
}
