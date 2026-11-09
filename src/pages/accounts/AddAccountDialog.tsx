import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Globe2, LoaderCircle, Monitor, Terminal } from "lucide-react";
import type { Account, AccountProvider, OneClickCascadeResult } from "../../../shared/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { WorkspaceSelect } from "../../features/DesktopSetup";
import {
  CliFlowPanel,
  DesktopPendingActions,
  autoCaptureLine,
} from "@/app/ConnectionPanels";
import { RelayErrorAlert } from "@/app/RelayErrorAlert";
import { CliSetupActions } from "../../features/CliSetup";
import {
  ProfileFields,
  groupsShown,
  profileInput,
  profileValue,
  type ProfileValue,
} from "../../features/ProfileFields";
import {
  blockReason,
  cliBlocked,
  cliDetail,
  cliState,
  desktopBlock,
} from "@/lib/onboarding";
import {
  CascadeBanner,
  ClaudeOneClick,
  ConnectionDone,
  ProviderCards,
  ProviderForm,
  AntigravityOAuthForm,
  useConnectForm,
  useDetectedProviders,
} from "./AddAccountProviders";
import {
  isProvisionalName,
  provisionalName,
  suggestProfile,
} from "@/lib/profile-suggestion";

type Step = 1 | 2 | 3;

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
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{t("Hesap ekle", "Add account")}</DialogTitle>
        </DialogHeader>
        {/* Radix unmounts the content when closed, so each opening starts at the first provider. */}
        <AddAccountFlow close={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

/**
 * Adding an account for any provider: the provider cards (with the local sessions found), and
 * then the provider's own way in. Claude keeps its three steps (`AddAccountSteps`) under a
 * one-click panel and its four layers; Codex connects a detected sign-in or a checked API key;
 * Antigravity signs in with Google.
 */
export function AddAccountFlow({ close }: { close: () => void }) {
  const { accounts, busy, desktop, pendingDesktop } = useRelay();
  const [provider, setProvider] = useState<AccountProvider>("claude");
  const [result, setResult] = useState<OneClickCascadeResult>();
  const detected = useDetectedProviders();
  const [form, setForm] = useConnectForm(
    provider,
    accounts.map((a) => a.name),
  );
  // Claude's three steps are mid-way (a profile exists, or a sign-in waits): the provider cannot change under them.
  const locked = !!busy || !!pendingDesktop || !!desktop?.autoCapture;
  const reset = () => {
    setResult(undefined);
    setForm((f) => ({ ...f, apiKey: "" }));
  };
  return (
    <div className="grid gap-4">
      <ProviderCards
        value={provider}
        onChange={(next) => {
          setProvider(next);
          setResult(undefined);
        }}
        detected={detected}
        disabled={locked}
      />
      {/* The four layers are Claude's: Codex and Antigravity only serve the gateway. */}
      {provider === "claude" && !result && <CascadeBanner />}
      {result && !(provider === "claude" && result.layers.desktop === "pending") ? (
        <ConnectionDone result={result} provider={provider} onAnother={reset} close={close} />
      ) : provider === "claude" ? (
        <AddAccountSteps
          // A one-click that still waits for the Claude app (a sign-in, or Code) continues with its profile.
          key={result?.account.id ?? "new"}
          close={close}
          initial={result ? { step: 1, id: result.account.id } : undefined}
          intro={
            result ? undefined : (
              <ClaudeOneClick form={form} onChange={setForm} session={detected.claude} onResult={setResult} />
            )
          }
        />
      ) : provider === "antigravity" ? (
        <AntigravityOAuthForm form={form} onChange={setForm} onResult={setResult} close={close} />
      ) : (
        <ProviderForm
          provider="codex"
          form={form}
          onChange={setForm}
          session={detected[provider]}
          onResult={setResult}
          close={close}
        />
      )}
    </div>
  );
}

/**
 * Where the wizard stands: three segments, each a bar over its numbered name; done and current
 * bars are filled, the current name is bold.
 */
function StepIndicator({ step }: { step: Step }) {
  const { t } = useI18n();
  const titles = [
    t("Claude uygulaması", "Claude app"),
    t("Limit okuma girişi", "Usage sign-in"),
    t("Hazır", "Ready"),
  ];
  return (
    <div className="grid gap-2">
      <ol
        className="grid grid-cols-3 gap-1.5 text-xs"
        aria-label={t("Adımlar", "Steps")}
      >
        {titles.map((title, index) => {
          const n = (index + 1) as Step;
          const done = n < step;
          const active = n === step;
          return (
            <li
              key={title}
              className="grid min-w-0 gap-1.5"
              aria-current={active ? "step" : undefined}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "h-1 rounded-full",
                  done || active ? "bg-primary" : "bg-track",
                )}
              />
              <span
                className={cn(
                  "flex min-w-0 items-start gap-1 leading-tight",
                  active ? "font-semibold" : "text-muted-foreground",
                )}
              >
                {done && <Check aria-hidden="true" className="size-3 shrink-0 text-ok" />}
                {done ? title : `${n} · ${title}`}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** A step's own heading. */
function StepTitle({ children }: { children: ReactNode }) {
  return <h3 className="text-lg font-semibold leading-snug">{children}</h3>;
}

/**
 * Adding an account in three steps, with one confirmation for the Claude app's restarts:
 * 1. the Claude app sign-in: the account open in Claude now, or a new sign-in; Relay saves it by
 *    itself once Code is opened (see AutoCapture);
 * 2. the usage sign-in, started on its own in Relay's window;
 * 3. the name, type and group, suggested from the sign-in.
 * The profile is created with a provisional name at the start; closing before the Claude app
 * sign-in removes it again. Rendered outside the dialog so it can be tested statically.
 */
export function AddAccountSteps({
  close,
  initial,
  intro,
}: {
  close: () => void;
  /** The first step's one-click panel, above its step-by-step button. */
  intro?: ReactNode;
  /** Tests start at a later step for an existing profile. */
  initial?: { step: Step; id: string };
}) {
  const relay = useRelay();
  const { t, language } = useI18n();
  const { api, accounts, busy, action, desktop, desktopBusy, pendingDesktop, settings } = relay;
  const [step, setStep] = useState<Step>(initial?.step ?? 1);
  const [createdId, setCreatedId] = useState(initial?.id);
  const [created, setCreated] = useState<Account>();
  // The snapshot catches up after creation; until then use the API's result.
  const account =
    accounts.find((a) => a.id === createdId) ??
    (created?.id === createdId ? created : undefined);
  const desktopLock = desktopBlock({ desktop, desktopBusy, pendingDesktop });
  const current = !!relay.hasUnclaimedDesktop;
  const cli = cliState(relay.data?.diagnostics);
  const flow = relay.flow?.accountId === account?.id ? relay.flow : undefined;
  const auto = desktop?.autoCapture?.accountId === account?.id ? desktop?.autoCapture : undefined;
  const linked = !!account?.desktop;
  const connected = !!account?.auth?.loggedIn;

  // A saved Claude app sign-in moves on to the usage step, a finished usage sign-in to the end.
  useEffect(() => {
    if (linked) setStep((s) => (s === 1 ? 2 : s));
  }, [linked]);
  useEffect(() => {
    if (connected) setStep((s) => (s === 2 ? 3 : s));
  }, [connected]);

  // The usage sign-in starts on its own, once per profile.
  const startedFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (step !== 2 || !account || connected || flow || cliBlocked(cli)) return;
    if (startedFor.current === account.id) return;
    startedFor.current = account.id;
    void relay.startCli(account);
  }, [step, account, connected, flow, cli, relay]);

  // Closing before the Claude app sign-in was saved takes the provisional profile away again.
  const latest = useRef({ account, pending: false });
  latest.current = { account, pending: pendingDesktop?.id === account?.id };
  useEffect(
    () => () => {
      const { account: left, pending } = latest.current;
      if (!left || left.desktop || left.auth?.loggedIn || initial) return;
      void api.disarmAutoCapture(left.id).catch(() => {});
      if (!pending) void api.removeAccount(left.id).catch(() => {});
    },
    [],
  );

  const begin = () =>
    void action("create", async () => {
      const next =
        account ??
        (await api.createAccount({ name: provisionalName(accounts, t), kind: "personal" }));
      if (!account) {
        setCreated(next);
        setCreatedId(next.id);
      }
      relay.requestDesktop(next, current ? "capture" : "login");
    });

  const [profile, setProfile] = useState<ProfileValue>();
  useEffect(() => {
    if (step !== 3 || !account || profile) return;
    const suggestion = isProvisionalName(account.name) ? suggestProfile(account, accounts) : undefined;
    setProfile(
      suggestion
        ? { name: suggestion.name, kind: suggestion.kind, group: suggestion.group ?? "" }
        : profileValue(account),
    );
  }, [step, account, accounts, profile]);
  const save = (then: () => void) =>
    void action("profile", async () => {
      if (account && profile) {
        const input = profileInput(profile, groupsShown(settings.desktopHistoryTransfer, profile.kind, t));
        const same =
          input.name === account.name &&
          input.kind === account.kind &&
          (input.group ?? "") === profileValue(account).group;
        if (!same) await api.updateAccount(account.id, input);
      }
      then();
    });
  const another = () =>
    save(() => {
      setCreated(undefined);
      setCreatedId(undefined);
      setProfile(undefined);
      setStep(1);
    });

  const showIntroFirst =
    step === 1 &&
    !!intro &&
    !(account && pendingDesktop?.id === account.id) &&
    !(auto && auto.status !== "failed" && auto.status !== "saved");

  return (
    <div className="grid gap-4">
      {showIntroFirst ? (
        <>
          <RelayErrorAlert />
          <div className="grid gap-3 rounded-lg border bg-card px-3.5 py-3">
            {intro}
          </div>
          {auto?.status === "failed" && (
            <p role="status" className="text-sm text-warn-foreground">
              {autoCaptureLine(auto, auto.accountId, t, language)}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <Button variant="outline" size="sm" disabled={!!busy || !!desktopLock} onClick={begin}>
                {busy === "create" && <LoaderCircle className="animate-spin" />}
                {current
                  ? t("Bu hesabı ekle…", "Add this account…")
                  : t("Claude uygulamasında giriş ekranını aç…", "Open sign-in in the Claude app…")}
              </Button>
              {desktopLock && blockReason(desktopLock, t) && (
                <small className="text-xs text-muted-foreground">{blockReason(desktopLock, t)}</small>
              )}
            </div>
            <Button type="button" variant="ghost" size="sm" onClick={close}>
              {t("Vazgeç", "Cancel")}
            </Button>
          </div>
        </>
      ) : (
        <>
          <StepIndicator step={step} />
          {/* The page banners sit under the overlay; failures from these steps show here. */}
          <RelayErrorAlert />
          {step === 1 && (
            <>
              <StepTitle>
                {current
                  ? t("Claude uygulamasında açık hesabı ekle", "Add the account open in the Claude app")
                  : t("Yeni hesapla giriş yap", "Sign in with the new account")}
              </StepTitle>
              {account && pendingDesktop?.id === account.id ? (
                <div className="grid gap-3">
                  <StatusLine tone="warn" icon={<Monitor />}>
                    {t("Claude uygulamasına giriş yap", "Sign in to the Claude app")}
                  </StatusLine>
                  <DesktopPendingActions />
                </div>
              ) : auto && auto.status !== "failed" && auto.status !== "saved" ? (
                <div className="grid gap-3">
                  <StatusLine tone="warn" icon={<Monitor />}>
                    {autoCaptureLine(auto, auto.accountId, t, language)}
                  </StatusLine>
                  {auto.status === "choose-org" && auto.orgs && (
                    <WorkspaceSelect
                      accounts={accounts}
                      organizations={auto.orgs}
                      value=""
                      onChange={(orgId) =>
                        void action("auto-capture", () => api.chooseAutoCaptureOrg(auto.accountId, orgId))
                      }
                      t={t}
                    />
                  )}
                  {auto.status === "waiting" && (
                    <div>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={desktopBusy}
                        onClick={() => void action("open", () => api.openCodeTab())}
                      >
                        {t("Code’u aç", "Open Code")}
                      </Button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="grid gap-3">
                  {auto?.status === "failed" && (
                    <p role="status" className="text-sm text-warn-foreground">
                      {autoCaptureLine(auto, auto.accountId, t, language)}
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <Button disabled={!!busy || !!desktopLock} onClick={begin}>
                      {busy === "create" && <LoaderCircle className="animate-spin" />}
                      {current
                        ? t("Bu hesabı ekle…", "Add this account…")
                        : t("Claude uygulamasında giriş ekranını aç…", "Open sign-in in the Claude app…")}
                    </Button>
                    {desktopLock && blockReason(desktopLock, t) && (
                      <small className="text-xs text-muted-foreground">{blockReason(desktopLock, t)}</small>
                    )}
                  </div>
                </div>
              )}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={close}>
                  {t("Vazgeç", "Cancel")}
                </Button>
              </div>
            </>
          )}
        </>
      )}
      {step === 2 && account && (
        <>
          <StepTitle>
            {t(`“${account.name}” için limit okuma girişi`, `Usage sign-in for “${account.name}”`)}
          </StepTitle>
          <p className="text-sm text-muted-foreground">
            {t(
              "Relay’in bu hesabın limitlerini okuyabilmesi için bir kez giriş yap. Bu, Claude uygulamasından ayrı ve yalnızca okuyan bir giriştir; resmi Claude Code ile tarayıcıda onaylanır.",
              "Sign in once so that Relay can read the limits of this account. This is a separate, read-only sign-in, approved in the browser with the official Claude Code.",
            )}
          </p>
          {/* The page-frame panel sits under the overlay; finish the sign-in here. */}
          {flow ? (
            <CliFlowPanel embedded />
          ) : connected ? (
            <StatusLine tone="ok" icon={<Globe2 />}>
              {t("Bağlı", "Connected")}
              {account.auth?.email ? ` · ${account.auth.email}` : ""}
            </StatusLine>
          ) : cliBlocked(cli) ? (
            <div className="grid gap-2">
              <StatusLine tone="warn" icon={<Terminal />}>
                {`Claude Code · ${cliDetail(cli, relay.data?.diagnostics.version, t)}`}
              </StatusLine>
              <p className="text-sm text-muted-foreground">
                {t(
                  "Limitleri okumak için Claude Code gerekir. Claude uygulamasında Code’u aç ya da CLI’yi kur.",
                  "Relay needs Claude Code to read limits. Open Code in the Claude app, or install the CLI.",
                )}
              </p>
              <CliSetupActions />
            </div>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            {!flow && !connected && !cliBlocked(cli) && (
              <Button
                variant="outline"
                disabled={!!busy}
                onClick={() => void relay.startCli(account)}
              >
                <Globe2 />
                {t("Limit okuma girişi yap", "Sign in to read usage")}
              </Button>
            )}
            <Button variant={connected ? "default" : "ghost"} onClick={() => setStep(3)}>
              {connected ? t("Devam", "Continue") : t("Sonra yap", "Do it later")}
            </Button>
          </div>
        </>
      )}
      {step === 3 && account && (
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save(close);
          }}
        >
          <StepTitle>{t("Hesap hazır", "Account ready")}</StepTitle>
          <div className="grid gap-2">
            <StatusLine tone={linked ? "ok" : "warn"} icon={<Monitor />} static>
              {linked
                ? t("Claude uygulaması girişi kaydedildi", "Claude app sign-in saved")
                : t("Claude uygulaması girişi henüz kaydedilmedi", "Claude app sign-in not saved yet")}
            </StatusLine>
            <StatusLine tone={connected ? "ok" : "warn"} icon={<Globe2 />} static>
              {connected
                ? t(`Limit okuma girişi bağlı${account.auth?.email ? ` · ${account.auth.email}` : ""}`, `Usage sign-in connected${account.auth?.email ? ` · ${account.auth.email}` : ""}`)
                : t("Limit okuma girişi yok", "No usage sign-in")}
            </StatusLine>
          </div>
          {profile && (
            <ProfileFields id="add-account" value={profile} onChange={setProfile} exceptId={account.id} />
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="ghost" disabled={!!busy || !profile?.name.trim()} onClick={another}>
              {t("Başka hesap ekle", "Add another account")}
            </Button>
            <Button type="submit" disabled={!!busy || !profile?.name.trim()}>
              {busy === "profile" && <LoaderCircle className="animate-spin" />}
              {t("Kaydet ve bitir", "Save and finish")}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

/**
 * One state row: a check when done, a spinner while waiting (or a still mark with `static`),
 * then what it is.
 */
function StatusLine({
  tone,
  icon,
  children,
  static: still = false,
}: {
  tone: "ok" | "warn";
  icon: ReactNode;
  children: ReactNode;
  static?: boolean;
}) {
  return (
    <div
      className="flex items-center gap-2.5 rounded-lg border bg-card px-3.5 py-2.5 text-sm [&>svg]:size-4 [&>svg]:shrink-0"
      aria-live="polite"
    >
      {tone === "ok" ? (
        <span aria-hidden="true" className="grid size-5 shrink-0 place-items-center rounded-full bg-ok/15 text-ok">
          <Check className="size-3" />
        </span>
      ) : still ? (
        <span aria-hidden="true" className="size-5 shrink-0 rounded-full border-2 border-warn/60" />
      ) : (
        <LoaderCircle aria-hidden="true" className="animate-spin text-warn" />
      )}
      <span className="min-w-0 flex-1">{children}</span>
      <span aria-hidden="true" className="text-muted-foreground [&>svg]:size-4">
        {icon}
      </span>
    </div>
  );
}
