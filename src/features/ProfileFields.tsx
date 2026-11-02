import type { Account } from "../../shared/types";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { historyCopy } from "../pages/accounts/historyCopy";
import { groupName } from "@/lib/profile-suggestion";

export interface ProfileValue {
  name: string;
  kind: "personal" | "work";
  group: string;
}

/** The profile's start values from an account: its name, type and own group name. */
export const profileValue = (account: Account): ProfileValue => ({
  name: account.name,
  kind: account.kind,
  group: groupName(account),
});

/** The create/update payload: trimmed, with a sharing group only for work accounts that name one. */
export function profileInput(value: ProfileValue, groupsShown: boolean) {
  const group = value.group.trim();
  return value.kind === "work" && groupsShown && group
    ? { name: value.name.trim(), kind: value.kind, group }
    : { name: value.name.trim(), kind: value.kind };
}

/**
 * Name, type and (for work accounts, when history is shared within groups) the sharing group,
 * with the note on what the type means for Code history. Used to finish adding an account and to
 * edit one.
 */
export function ProfileFields({
  id,
  value,
  onChange,
  exceptId,
}: {
  /** Prefix for the field ids. */
  id: string;
  value: ProfileValue;
  onChange: (value: ProfileValue) => void;
  /** The account being edited, left out of the group suggestions' own entry. */
  exceptId?: string;
}) {
  const { t } = useI18n();
  const { accounts, settings } = useRelay();
  const history = historyCopy(settings.desktopHistoryTransfer, value.kind, t);
  const groups = [
    ...new Set(
      accounts
        .filter((a) => a.id !== exceptId)
        .map(groupName)
        .filter(Boolean),
    ),
  ];
  return (
    <div className="grid gap-4">
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-name`}>{t("Hesap adı", "Account name")}</Label>
        <Input
          id={`${id}-name`}
          required
          maxLength={64}
          placeholder={t("Örn. Kişisel Max", "e.g. Personal Max")}
          value={value.name}
          onChange={(e) => onChange({ ...value, name: e.target.value })}
        />
      </div>
      <div className="grid gap-1.5">
        <Label id={`${id}-kind`}>{t("Tür", "Type")}</Label>
        <ToggleGroup
          type="single"
          variant="outline"
          aria-labelledby={`${id}-kind`}
          value={value.kind}
          onValueChange={(v) => v && onChange({ ...value, kind: v as ProfileValue["kind"] })}
          className="w-full"
        >
          <ToggleGroupItem value="personal" className="flex-1">
            {t("Kişisel", "Personal")}
          </ToggleGroupItem>
          <ToggleGroupItem value="work" className="flex-1">
            {t("Şirket", "Work")}
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      {value.kind === "work" && history.groupPlaceholder && (
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-group`}>
            {t("Paylaşım grubu · isteğe bağlı", "Sharing group · optional")}
          </Label>
          <Input
            id={`${id}-group`}
            list={`${id}-groups`}
            maxLength={64}
            value={value.group}
            onChange={(e) => onChange({ ...value, group: e.target.value })}
            placeholder={history.groupPlaceholder}
          />
          <datalist id={`${id}-groups`}>
            {groups.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
        </div>
      )}
      <p className="text-xs text-muted-foreground">{history.note}</p>
    </div>
  );
}

/** Whether the group field is shown, so `profileInput` keeps or drops the group. */
export const groupsShown = (
  transfer: Parameters<typeof historyCopy>[0],
  kind: ProfileValue["kind"],
  t: (tr: string, en: string) => string,
) => !!historyCopy(transfer, kind, t).groupPlaceholder;
