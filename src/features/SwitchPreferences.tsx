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
import { InfoTip } from "@/components/PageSection";
import type { T } from "../../shared/i18n/translate";


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
          {t("switchPreferences.selectAll")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => update([])}
        >
          {t("switchPreferences.clearSelection")}
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
                    t("switchPreferences.emailNotConnectedYet")
                  )}
                </small>
              </span>
              <Badge variant="outline" className="text-muted-foreground">
                <StatusDot tone={ready ? "ok" : "warn"} />
                {desktopCliMismatch(a)
                  ? t("switchPreferences.signInsBelongToDifferentAccounts")
                  : a.desktop
                    ? t("switchPreferences.claudeAppSignInSaved")
                    : t("switchPreferences.claudeAppSignInNeeded")}
              </Badge>
            </label>
          );
        })}
        {!accounts.length && (
          <Note>{t("switchPreferences.addAnAccountFirst")}</Note>
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
    { value: "all", label: t("switchPreferences.betweenAllAccounts") },
    { value: "same-group", label: t("switchPreferences.inTheSameSharingGroup") },
    { value: "selected", label: t("switchPreferences.betweenSelectedAccounts") },
    { value: "off", label: t("switchPreferences.doNotShare") },
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
      <SectionHeading title={t("common.rescuedDrafts")} />
      <SettingRow
        label={
          <span className="inline-flex items-center gap-2">
            {t("switchPreferences.reTypeDraftsIntoTheClaude")}
            <Badge variant="outline" className="text-muted-foreground">
              {t("switchPreferences.experimental")}
            </Badge>
          </span>
        }
        htmlFor="draft-retype"
        description={t("switchPreferences.afterASwitchTypesTheDraft")}
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
      ? t("switchPreferences.allAccountsWithASavedClaude")
      : transfer === "selected"
        ? t("switchPreferences.selectedAccountsShareCodeHistoryEven")
        : "";
  return [
    scope,
    t("switchPreferences.relaySharesOnlyLocalCodeHistory"),
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
  const where = off
    ? t("switchPreferences.yourCodeConversationsStaySeparateIn")
    : value.desktopHistoryTransfer === "all"
      ? t("switchPreferences.afterASwitchYourCodeConversations")
      : value.desktopHistoryTransfer === "selected"
        ? t("switchPreferences.afterASwitchYourCodeConversations2")
        : t("switchPreferences.afterASwitchYourCodeConversations3");
  // What the merge would do, on the button's title: the row keeps one line.
  const merge = active
    ? sources.length
      ? t("switchPreferences.relayMergesTheHistoryOfAccounts", { sourcesLength: sources.length, activeName: active.name })
      : t("switchPreferences.noAccountsAreSelectedToShare", { activeName: active.name })
    : t("switchPreferences.firstSaveTheClaudeAppSign");
  return (
    <div className="grid gap-1">
      <SettingRow
        label={<span className="font-medium">{t("switchPreferences.sharedCodeHistory")}</span>}
        htmlFor="history-transfer"
        description={
          <span className="inline-flex items-center gap-1">
            {where}
            {/* Which accounts share, and that only local Code history does: behind the ⓘ. */}
            {!off && <InfoTip>{historyScopeNote(value.desktopHistoryTransfer, t)}</InfoTip>}
          </span>
        }
      >
        <span className="flex gap-1">
          <OptionSelect
            id="history-transfer"
            value={value.desktopHistoryTransfer}
            disabled={disabled}
            onChange={(desktopHistoryTransfer) => update({ desktopHistoryTransfer })}
            options={historyTransferOptions(t)}
          />
          <Button
            type="button"
            variant="outline"
            title={merge}
            disabled={syncDisabled || disabled || !active || !sources.length}
            onClick={sync}
          >
            {t("switchPreferences.mergeIntoTheOpenAccount")}
          </Button>
        </span>
      </SettingRow>
      {/* A disabled button shows no title: say why it cannot merge, under the row. */}
      {(!active || !sources.length) && !off && (
        <p data-slot="merge-reason" className="text-right text-xs text-muted-foreground">
          {merge}
        </p>
      )}
      {value.desktopHistoryTransfer === "selected" && (
        <AccountSelection
          accounts={accounts}
          selected={value.desktopHistoryAccounts}
          update={(ids) => update({ desktopHistoryAccounts: ids })}
          disabled={disabled}
          label={t("switchPreferences.accountsThatShareHistory")}
          t={t}
        />
      )}
    </div>
  );
}
