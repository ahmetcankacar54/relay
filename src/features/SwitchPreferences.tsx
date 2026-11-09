import type { Account, RelaySettings } from "../../shared/types";
import { Private } from "@/components/Private";
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
import { Disclosure } from "@/components/Disclosure";

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
      <legend className="px-1 text-sm font-medium">
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
                  {(a.desktop?.email ?? (!desktopCliMismatch(a) ? a.auth?.email : undefined)) ? (
                    <Private>{a.desktop?.email ?? a.auth?.email}</Private>
                  ) : (
                    t("E-posta henüz bağlanmadı", "Email not connected yet")
                  )}
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
                    ? t("Claude uygulaması girişi kayıtlı", "Claude app sign-in saved")
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

/** The "Geçmişi paylaş" choices, for the details' select and the Switching page's card. */
export function historyTransferOptions(
  t: T,
): { value: RelaySettings["desktopHistoryTransfer"]; label: string }[] {
  return [
    { value: "all", label: t("Tüm hesaplar arasında", "Between all accounts") },
    { value: "same-group", label: t("Aynı paylaşım grubunda", "In the same sharing group") },
    { value: "selected", label: t("Seçtiğim hesaplar arasında", "Between selected accounts") },
    { value: "off", label: t("Paylaşma", "Do not share") },
  ];
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
          "Geçişten sonra taslağı mesaj kutusuna yazar, göndermez. Erişilebilirlik izni ister.",
          "After a switch, types the draft into the message box but does not send it. Needs Accessibility permission.",
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

/** What the chosen scope shares, and that only local Code history is; nothing when it is off. */
export function historyScopeNote(
  transfer: RelaySettings["desktopHistoryTransfer"],
  t: T,
): string {
  if (transfer === "off") return "";
  // "same-group" is explained by its label.
  const scope =
    transfer === "all"
      ? t(
          "Claude uygulaması girişi kayıtlı tüm hesaplar, kişisel ya da şirket, Code geçmişini paylaşır.",
          "All accounts with a saved Claude app sign-in, personal or work, share Code history.",
        )
      : transfer === "selected"
        ? t(
            "Seçili hesaplar, farklı şirketlerden olsalar da Code geçmişini paylaşır.",
            "Selected accounts share Code history, even across companies.",
          )
        : "";
  return [
    scope,
    t(
      "Yalnızca yerel Code geçmişi paylaşılır; Chat ve bulut oturumları eşitlenmez.",
      "Relay shares only local Code history. Chat and cloud sessions do not sync.",
    ),
  ]
    .filter(Boolean)
    .join(" ");
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
                    "After a switch, your Code conversations appear in the accounts you selected.",
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
      >
        <OptionSelect
          id="history-transfer"
          value={value.desktopHistoryTransfer}
          disabled={disabled}
          onChange={(desktopHistoryTransfer) =>
            update({ desktopHistoryTransfer })
          }
          options={historyTransferOptions(t)}
        />
      </SettingRow>
      {value.desktopHistoryTransfer === "selected" && (
        <AccountSelection
          accounts={accounts}
          selected={value.desktopHistoryAccounts}
          update={(ids) => update({ desktopHistoryAccounts: ids })}
          disabled={disabled}
          label={t("Geçmişi paylaşan hesaplar", "Accounts that share history")}
          t={t}
        />
      )}
      <div className="mt-1 flex items-center justify-between gap-4 rounded-lg border border-border bg-muted/40 px-3 py-2.5">
        <p className="text-sm">
          {active
            ? sources.length
              ? t(
                  `${sources.length} hesabın geçmişi ${active.name} hesabında birleştirilir.`,
                  `Relay merges the history of ${sources.length} ${sources.length === 1 ? "account" : "accounts"} into ${active.name}.`,
                )
              : t(
                  `${active.name} için paylaşılacak hesap seçili değil.`,
                  `No accounts are selected to share with ${active.name}.`,
                )
            : t(
                "Önce Claude uygulamasında açık hesabın girişini kaydet.",
                "First, save the Claude app sign-in of the open account.",
              )}
        </p>
        <Button
          type="button"
          variant="outline"
          className="shrink-0"
          disabled={syncDisabled || disabled || !active || !sources.length}
          onClick={sync}
        >
          {t("Açık hesapla birleştir…", "Merge into the open account…")}
        </Button>
      </div>
      {!off && (
        <Disclosure title={t("Ayrıntılar", "Details")}>
          <Note>{historyScopeNote(value.desktopHistoryTransfer, t)}</Note>
        </Disclosure>
      )}
    </div>
  );
}
