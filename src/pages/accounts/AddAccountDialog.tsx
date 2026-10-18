import { useEffect, useState, type ReactNode } from "react";
import { Check, Globe2, LoaderCircle, Monitor, Terminal } from "lucide-react";
import type { Account, CreateAccount } from "../../../shared/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { StatusDot } from "@/components/StatusDot";
import { cn } from "@/lib/utils";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { DesktopSetup } from "../../features/DesktopSetup";
import { KEYCHAIN_HINT } from "../../features/DesktopActionReview";
import { CliFlowPanel, DesktopPendingActions } from "@/app/ConnectionPanels";
import { RelayErrorAlert } from "@/app/RelayErrorAlert";
import { historyCopy } from "./historyCopy";
import { CliSetupActions } from "../../features/CliSetup";
import {
  blockReason,
  cliBlocked,
  cliDetail,
  cliState,
  desktopBlock,
} from "@/lib/onboarding";

type Kind = "personal" | "work";
type Step = 1 | 2 | 3;

/** The create-profile payload: trimmed, with a sharing group only for work accounts. */
export function profileInput(
  name: string,
  kind: Kind,
  group: string,
): CreateAccount {
  const trimmed = group.trim();
  return kind === "work" && trimmed
    ? { name: name.trim(), kind, group: trimmed }
    : { name: name.trim(), kind };
}

export function AddAccountDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("Hesap ekle", "Add account")}</DialogTitle>
          <DialogDescription>
            {t(
              "Profil oluştur, ardından Claude uygulaması girişini ve limit okuma girişini yap.",
              "Create a profile, then add the Claude app sign-in and the usage sign-in.",
            )}
          </DialogDescription>
        </DialogHeader>
        {/* Radix unmounts the content when closed, so each opening starts at step 1. */}
        <AddAccountSteps close={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function StepIndicator({ step }: { step: Step }) {
  const { t } = useI18n();
  const titles = [
    t("Profil", "Profile"),
    t("Claude uygulaması girişi", "Claude app sign-in"),
    t("Limit okuma girişi", "Usage sign-in"),
  ];
  return (
    <ol
      className="flex items-center gap-2 text-xs"
      aria-label={t("Adımlar", "Steps")}
    >
      {titles.map((title, index) => {
        const n = (index + 1) as Step;
        const done = n < step;
        const active = n === step;
        return (
          <li
            key={title}
            className="flex min-w-0 items-center gap-1.5"
            aria-current={active ? "step" : undefined}
          >
            {index > 0 && (
              <span
                className="h-px w-3 shrink-0 bg-border"
                aria-hidden="true"
              />
            )}
            <span
              className={cn(
                "grid size-5 shrink-0 place-items-center rounded-full text-xs font-semibold",
                done
                  ? "bg-brand text-primary-foreground"
                  : active
                    ? "border-2 border-brand text-primary"
                    : "bg-muted text-muted-foreground",
              )}
              aria-hidden="true"
            >
              {done ? <Check className="size-3" /> : n}
            </span>
            <span
              className={cn(
                "truncate",
                active ? "font-semibold" : "text-muted-foreground",
              )}
            >
              {title}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** Dialog contents, rendered outside the portal so it can be tested statically. */
export function AddAccountSteps({
  close,
  initial,
  initialKind,
}: {
  close: () => void;
  /** Tests start at a later step for an existing profile. */
  initial?: { step: Step; id: string };
  /** Tests open the form on the work type. */
  initialKind?: Kind;
}) {
  const relay = useRelay();
  const { t } = useI18n();
  const {
    api,
    accounts,
    busy,
    action,
    desktop,
    desktopBusy,
    pendingDesktop,
    settings,
  } = relay;
  const [step, setStep] = useState<Step>(initial?.step ?? 1);
  const [createdId, setCreatedId] = useState(initial?.id);
  const [created, setCreated] = useState<Account>();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Kind>(initialKind ?? "personal");
  const [group, setGroup] = useState("");
  // Only "same-group" has a group to name; in the other modes the field would do nothing.
  const history = historyCopy(settings.desktopHistoryTransfer, kind, t);
  // The snapshot catches up after creation; until then use the API's result.
  const account =
    accounts.find((a) => a.id === createdId) ??
    (created?.id === createdId ? created : undefined);
  const groups = [
    ...new Set(
      accounts
        .filter((a) => a.kind === "work" && a.group !== `work:${a.id}`)
        .map((a) => a.group.slice(5)),
    ),
  ];
  const desktopLock = desktopBlock({ desktop, desktopBusy, pendingDesktop });
  // Without a usable CLI the usage sign-in would only fail: say so instead of starting it.
  const cli = cliState(relay.data?.diagnostics);
  // A completed Desktop link moves the wizard on to the limit step.
  const linked = !!account?.desktop;
  useEffect(() => {
    if (linked) setStep((current) => (current === 2 ? 3 : current));
  }, [linked]);
  const flow = relay.flow?.accountId === account?.id ? relay.flow : undefined;
  return (
    <div className="grid gap-4">
      <StepIndicator step={step} />
      {/* The page banners sit under the overlay; failures from these steps show here. */}
      <RelayErrorAlert />
      {step === 1 && (
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void action("create", async () => {
              const next = await api.createAccount(
                profileInput(
                  name,
                  kind,
                  history.groupPlaceholder ? group : "",
                ),
              );
              setCreated(next);
              relay.setSetupId(next.id);
              setStep(2);
              setCreatedId(next.id);
            });
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="add-account-name">
              {t("Hesap adı", "Account name")}
            </Label>
            <Input
              id="add-account-name"
              required
              autoFocus
              maxLength={64}
              placeholder={t("Örn. Kişisel Max", "e.g. Personal Max")}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label id="add-account-kind">{t("Tür", "Type")}</Label>
            <ToggleGroup
              type="single"
              variant="outline"
              aria-labelledby="add-account-kind"
              value={kind}
              onValueChange={(v) => v && setKind(v as Kind)}
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
          {kind === "work" && history.groupPlaceholder && (
            <div className="grid gap-1.5">
              <Label htmlFor="add-account-group">
                {t("Paylaşım grubu · isteğe bağlı", "Sharing group · optional")}
              </Label>
              <Input
                id="add-account-group"
                list="add-account-groups"
                maxLength={64}
                value={group}
                onChange={(e) => setGroup(e.target.value)}
                placeholder={history.groupPlaceholder}
              />
              <datalist id="add-account-groups">
                {groups.map((g) => (
                  <option key={g} value={g} />
                ))}
              </datalist>
            </div>
          )}
          <p className="text-xs text-muted-foreground">{history.note}</p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={close}>
              {t("Vazgeç", "Cancel")}
            </Button>
            <Button type="submit" disabled={!!busy || !name.trim()}>
              {busy === "create" && <LoaderCircle className="animate-spin" />}
              {t("Profil oluştur", "Create profile")}
            </Button>
          </div>
        </form>
      )}
      {step === 2 && account && (
        <>
          {account.desktop ? (
            <StatusLine tone="ok" icon={<Monitor />}>
              {t(
                "Claude uygulaması girişi kaydedildi.",
                "Claude app sign-in saved.",
              )}
            </StatusLine>
          ) : pendingDesktop?.id === account.id ? (
            <div className="grid gap-3">
              <StatusLine tone="warn" icon={<Monitor />}>
                {t(
                  "Claude uygulamasında giriş bekleniyor",
                  "Waiting for sign-in in the Claude app",
                )}
              </StatusLine>
              <p className="text-sm text-muted-foreground">
                {t(
                  "Claude uygulamasında doğru hesaba giriş yap ve Code sekmesini aç. Sonra buradan bağlantıyı kaydet.",
                  "Sign in to the matching account inside the Claude app and open Code. Then save the connection here.",
                )}
              </p>
              <DesktopPendingActions />
            </div>
          ) : (
            <DesktopSetup
              bare
              account={account}
              accounts={accounts}
              desktop={desktop}
              unclaimed={relay.hasUnclaimedDesktop}
              org={relay.targetOrg}
              busy={!!desktopLock}
              reason={blockReason(desktopLock, t)}
              t={t}
              selectOrg={relay.setOrg}
              close={() => setStep(3)}
              connect={() =>
                relay.requestDesktop(
                  account,
                  relay.hasUnclaimedDesktop ? "capture" : "login",
                )
              }
            />
          )}
          {!account.desktop && (
            <p className="text-xs text-muted-foreground">
              {t(...KEYCHAIN_HINT)}
            </p>
          )}
          <div className="flex justify-end gap-2">
            {account.desktop ? (
              <Button onClick={() => setStep(3)}>
                {t("Devam", "Continue")}
              </Button>
            ) : (
              <Button variant="ghost" onClick={() => setStep(3)}>
                {t("Atla", "Skip")}
              </Button>
            )}
          </div>
        </>
      )}
      {step === 3 && account && (
        <>
          <p className="text-sm text-muted-foreground">
            {t(
              "Limit okuma girişi bu hesabın kullanım limitlerini okur.",
              "The usage sign-in reads this account’s usage limits.",
            )}
          </p>
          {/* The page-frame panel sits under the overlay; finish the sign-in here. */}
          {flow ? (
            <CliFlowPanel embedded />
          ) : account.auth?.loggedIn ? (
            <StatusLine tone="ok" icon={<Globe2 />}>
              {t("Bağlı", "Connected")}
              {account.auth.email ? ` · ${account.auth.email}` : ""}
            </StatusLine>
          ) : cliBlocked(cli) ? (
            <div className="grid gap-2">
              <StatusLine tone="warn" icon={<Terminal />}>
                {`Claude Code CLI · ${cliDetail(cli, relay.data?.diagnostics.version, t)}`}
              </StatusLine>
              <p className="text-sm text-muted-foreground">
                {t("Limitleri okumak için gerekir.", "Needed to read usage limits.")}
              </p>
              <CliSetupActions />
            </div>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            {!flow && !cliBlocked(cli) && (
              <Button
                variant="outline"
                disabled={!!busy}
                onClick={() => void relay.startCli(account)}
              >
                <Globe2 />
                {t("Limit okuma girişi yap", "Sign in to read usage")}
              </Button>
            )}
            <Button onClick={close}>{t("Bitti", "Done")}</Button>
          </div>
        </>
      )}
    </div>
  );
}

function StatusLine({
  tone,
  icon,
  children,
}: {
  tone: "ok" | "warn";
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-muted-foreground"
      aria-live="polite"
    >
      {icon}
      <StatusDot tone={tone} />
      <span className="min-w-0">{children}</span>
    </div>
  );
}
