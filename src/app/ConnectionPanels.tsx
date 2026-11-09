import { useEffect, useState } from "react";
import { Private } from "@/components/Private";
import { ArrowUpRight, Globe2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { pendingFlow } from "@/data/selectors";
import { duplicateCliAccount } from "../../shared/account-state";
import { ConnectionProgress } from "../features/ConnectionProgress";
import { WorkspaceSelect } from "../features/DesktopSetup";
import { codeTabStep } from "@/lib/onboarding";
import { localizeError } from "../messages";
import type { AutoCaptureState } from "../../shared/types";

const cardClass = "gap-3 px-4 py-4";
const panelClass = `mx-5 mb-3 ${cardClass}`;
const titleClass = "flex items-start gap-3";
const iconClass = "mt-0.5 size-5 shrink-0 text-brand";
const actionsClass = "flex flex-wrap items-center gap-2";

/**
 * What Relay's automatic save of a Claude app sign-in is doing for `accountId`, as one line;
 * undefined when it is not armed for that profile or has nothing to say.
 */
export function autoCaptureLine(
  state: AutoCaptureState | undefined,
  accountId: string,
  t: (tr: string, en: string) => string,
  language: "tr" | "en",
): string | undefined {
  if (state?.accountId !== accountId) return undefined;
  switch (state.status) {
    case "waiting":
      return state.alreadySaved
        ? t(
            `Claude uygulamasında ${state.alreadySaved} açık; o zaten kayıtlı. Yeni hesapla giriş yap.`,
            `The Claude app is signed in as ${state.alreadySaved}, which is already saved. Sign in with the new account.`,
          )
        : t(
            "Code’u açınca Relay girişi kaydeder.",
            "Relay saves the sign-in when you open Code.",
          );
    case "choose-org":
      return t(
        "Bu hesabın birden çok Code çalışma alanı var; kaydedilecek olanı seç.",
        "This account has more than one Code workspace. Select the one to save.",
      );
    case "saving":
      return t(
        "Giriş kaydediliyor; Claude uygulaması yeniden başlıyor…",
        "Relay saves the sign-in. The Claude app restarts…",
      );
    case "saved":
      return t("Claude uygulaması girişi kaydedildi.", "Claude app sign-in saved.");
    case "failed":
      return state.error === "timeout"
        ? t(
            "Bekleme süresi doldu. Giriş yaptıysan “Girişi kaydet”e bas.",
            "The wait timed out. If you signed in, select “Save sign-in”.",
          )
        : state.error === "other-pending"
          ? t(
              "Başka bir hesabın girişi sürüyor; önce onu tamamla veya iptal et.",
              "Another account’s sign-in is in progress. Finish or cancel it first.",
            )
          : localizeError(state.error ?? "", language);
  }
}

/** Workspace choice and the reopen / cancel / complete actions for a pending Desktop sign-in. */
export function DesktopPendingActions() {
  const relay = useRelay();
  const { t, language } = useI18n();
  const {
    api,
    desktop,
    desktopBusy,
    pendingDesktop,
    hasUnclaimedDesktop,
    targetOrg,
    setOrg,
    action,
  } = relay;
  if (!pendingDesktop) return null;
  const identityReady =
    hasUnclaimedDesktop || desktop?.activeProfileId === pendingDesktop.id;
  const workspaces = desktop?.organizations.length ?? 0;
  const auto = desktop?.autoCapture?.accountId === pendingDesktop.id ? desktop.autoCapture : undefined;
  // Saved by Relay unless that stopped: the manual save stays as the way out.
  const manual = !auto || auto.status === "failed";
  const line = autoCaptureLine(auto, pendingDesktop.id, t, language);
  return (
    <>
      {line && (
        <p role="status" className="text-sm text-muted-foreground">
          {line}
        </p>
      )}
      {auto?.status === "choose-org" && auto.orgs ? (
        <WorkspaceSelect
          accounts={relay.accounts}
          organizations={auto.orgs}
          value=""
          onChange={(orgId) =>
            void action("auto-capture", () => api.chooseAutoCaptureOrg(pendingDesktop.id, orgId))
          }
          t={t}
        />
      ) : (
        manual &&
        workspaces > 1 && (
          <WorkspaceSelect
            accounts={relay.accounts}
            organizations={desktop!.organizations}
            value={targetOrg}
            onChange={setOrg}
            t={t}
          />
        )
      )}
      {manual && identityReady && !workspaces && (
        <p className="text-sm text-muted-foreground">{codeTabStep(t)}</p>
      )}
      <div className={actionsClass}>
        <Button
          variant="outline"
          size="sm"
          disabled={desktopBusy}
          onClick={() => void action("open", () => api.openCodeTab())}
        >
          <ArrowUpRight />
          {t("Code’u aç", "Open Code")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={desktopBusy || auto?.status === "saving"}
          onClick={() => relay.requestDesktop(pendingDesktop, "cancel")}
        >
          {t(
            "İptal et ve önceki hesaba dön",
            "Cancel and return to previous account",
          )}
        </Button>
        {manual && identityReady && targetOrg && (
          <Button
            size="sm"
            disabled={desktopBusy}
            onClick={() => relay.requestDesktop(pendingDesktop, "capture")}
          >
            {t("Girişi kaydet", "Save sign-in")}
          </Button>
        )}
      </div>
    </>
  );
}

/** Desktop sign-in in progress for a profile; shown above every page until saved or cancelled. */
export function DesktopPendingPanel() {
  const relay = useRelay();
  const { t } = useI18n();
  const { desktop, pendingDesktop, hasUnclaimedDesktop, targetOrg } = relay;
  if (!pendingDesktop) return null;
  const desktopIdentityReady =
    hasUnclaimedDesktop || desktop?.activeProfileId === pendingDesktop.id;
  return (
    <Card id="desktop-pending-panel" className={panelClass} aria-live="polite">
      <div className={titleClass}>
        <Globe2 className={iconClass} />
        <div className="min-w-0">
          <h3 className="font-semibold">
            {pendingDesktop.name} ·{" "}
            {t("Claude uygulaması girişi", "Claude app sign-in")}
          </h3>
        </div>
      </div>
      <ConnectionProgress
        current={desktopIdentityReady ? 2 : 1}
        state={
          desktop?.busy ? "working" : desktop?.error ? "failed" : "waiting"
        }
        label={
          desktop?.busy
            ? t("Giriş kaydediliyor", "Save in progress")
            : desktop?.error
              ? t("Giriş kaydedilemedi", "Sign-in not saved")
              : desktopIdentityReady
                ? targetOrg
                  ? t("Claude uygulaması girişini kaydet", "Save Claude app sign-in")
                  : t("Code’u aç", "Open Code")
                : t("Claude uygulamasına giriş yap", "Sign in to the Claude app")
        }
        steps={[
          { title: t("Claude uygulaması açık", "Claude app open") },
          { title: t("Giriş yap", "Sign in") },
          { title: t("Code’u aç", "Open Code") },
        ]}
      />
      <DesktopPendingActions />
    </Card>
  );
}

/**
 * Browser (CLI) sign-in flow for usage limits; shown above every page. The
 * `embedded` copy lives inside the add dialog and account sheet (which cover the
 * page panel) and drops the page-level id and margins.
 */
export function CliFlowPanel({ embedded = false }: { embedded?: boolean }) {
  const relay = useRelay();
  const { t, language } = useI18n();
  const { api, accounts, busy, flow, flowAccount, action } = relay;
  const pending = pendingFlow;
  const [code, setCode] = useState("");
  useEffect(() => setCode(""), [flow?.id]);
  if (!flow) return null;
  const note =
    flow.status === "failed"
      ? localizeError(flow.error ?? "", language)
      : flow.inWindow && (flow.status === "starting" || flow.status === "waiting")
        ? t(
            "Açılan Relay penceresinde Claude’a bu hesapla gir ve izin ver. Google ile giriş açılmazsa e-posta ile gir ya da “Tarayıcıda aç”a bas.",
            "In the Relay window, sign in to Claude with this account. Then allow access. If Google sign-in does not open, use email or select “Open in browser”.",
          )
        : undefined;
  return (
    <Card
      id={embedded ? undefined : "cli-connection-panel"}
      className={cn(
        embedded ? cardClass : panelClass,
        flow.status === "connected" && "border-brand/40",
      )}
      aria-live="polite"
    >
      <div className={titleClass}>
        {flow.status === "connected" ? (
          <ShieldCheck className={iconClass} />
        ) : (
          <Globe2 className={iconClass} />
        )}
        <div className="min-w-0">
          <h3 className="font-semibold">
            {flowAccount?.name} · {t("Limit okuma girişi", "Usage sign-in")}
          </h3>
          {note && <p className="text-sm text-muted-foreground">{note}</p>}
        </div>
      </div>
      {flow.status === "connected" && flowAccount?.auth?.email && (
        <p className="text-sm font-medium">
          <Private>{flowAccount.auth.email}</Private>
          {flowAccount.auth.subscription
            ? ` · ${flowAccount.auth.subscription}`
            : ""}
        </p>
      )}
      {flow.status === "connected" &&
        flowAccount &&
        duplicateCliAccount(flowAccount, accounts) && (
          <p className="rounded-md bg-amber-500/10 px-2.5 py-1.5 text-sm text-amber-700 dark:text-amber-400">
            {t(
              "Bu hesap başka bir profile de bağlı. İki profil aynı limitleri paylaşır.",
              "This account is also connected to another profile. Both profiles share the same limits.",
            )}
          </p>
        )}
      <ConnectionProgress
        current={
          flow.status === "starting" ? 0 : flow.status === "waiting" ? 1 : 2
        }
        state={
          flow.status === "connected"
            ? "complete"
            : flow.status === "failed"
              ? "failed"
              : flow.status === "cancelled"
                ? "cancelled"
                : flow.status === "waiting"
                  ? "waiting"
                  : "working"
        }
        label={
          flow.status === "connected"
            ? t("Hesap doğrulandı", "Account verified")
            : flow.status === "failed"
              ? t("Giriş tamamlanmadı", "Sign-in not completed")
              : flow.status === "cancelled"
                ? t("Giriş iptal edildi", "Sign-in cancelled")
                : flow.status === "verifying"
                  ? t("Hesap doğrulanıyor", "Relay verifies the account")
                  : flow.status === "waiting"
                    ? flow.inWindow
                      ? t("Pencerede onayla", "Approve in the window")
                      : t("Tarayıcıda onayla", "Approve in the browser")
                    : t("Giriş başlıyor", "Sign-in starts")
        }
        steps={[
          { title: t("Girişi başlat", "Start sign-in") },
          {
            title: flow.inWindow
              ? t("Pencerede onayla", "Approve in the window")
              : t("Tarayıcıda onayla", "Approve in the browser"),
          },
          { title: t("Hesabı doğrula", "Verify the account") },
        ]}
      />
      {flow.codeRequested && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const value = code;
            setCode("");
            relay.submitCode(value);
          }}
        >
          <label className="grid min-w-56 flex-1 gap-1.5 text-sm font-medium">
            {t(
              "Tarayıcı bir kod gösterdiyse buraya yapıştır",
              "If the browser shows a code, paste it here",
            )}
            <Input
              type="password"
              autoComplete="off"
              value={code}
              maxLength={4096}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
          <Button variant="outline" disabled={!!busy || !code.trim()}>
            {t("Kodu gönder", "Submit code")}
          </Button>
        </form>
      )}
      <div className={actionsClass}>
        {pending(flow) ? (
          <>
            {flow.inWindow && (
              <Button
                variant="outline"
                size="sm"
                disabled={!!busy || !flow.browserReady}
                onClick={() =>
                  void action("reopen", () =>
                    api.reopenLogin(flow.accountId, flow.id, "window"),
                  )
                }
              >
                {t("Pencereyi göster", "Show the window")}
              </Button>
            )}
            <Button
              variant={flow.inWindow ? "ghost" : "outline"}
              size="sm"
              disabled={!!busy || !flow.browserReady}
              onClick={() =>
                void action("reopen", () =>
                  api.reopenLogin(flow.accountId, flow.id, "browser"),
                )
              }
            >
              <ArrowUpRight />
              {flow.inWindow
                ? t("Tarayıcıda aç", "Open in browser")
                : t("Tarayıcıyı yeniden aç", "Reopen browser")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!!busy}
              onClick={() =>
                void action("cancel", () =>
                  api.cancelLogin(flow.accountId, flow.id),
                )
              }
            >
              {t("İptal et", "Cancel")}
            </Button>
          </>
        ) : (
          <>
            {flow.status !== "connected" && (
              <Button
                size="sm"
                disabled={!!busy}
                onClick={() => {
                  if (!flowAccount) return;
                  setCode("");
                  void relay.startCli(flowAccount);
                }}
              >
                {flowAccount?.auth?.email
                  ? t("Limit okuma girişini yenile", "Renew usage sign-in")
                  : t("Limit okuma girişi yap", "Sign in to read usage")}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                relay.dismissFlow();
              }}
            >
              {t("Tamam", "Done")}
            </Button>
          </>
        )}
      </div>
    </Card>
  );
}

export function ConnectionPanels({ cliFlow = true }: { cliFlow?: boolean }) {
  return (
    <>
      <DesktopPendingPanel />
      {cliFlow && <CliFlowPanel />}
    </>
  );
}
