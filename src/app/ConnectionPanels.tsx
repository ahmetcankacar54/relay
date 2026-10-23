import { useEffect, useState } from "react";
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

const cardClass = "gap-3 px-4 py-4";
const panelClass = `mx-6 mb-3 ${cardClass}`;
const titleClass = "flex items-start gap-3";
const iconClass = "mt-0.5 size-5 shrink-0 text-brand";
const actionsClass = "flex flex-wrap items-center gap-2";

/** Workspace choice and the reopen / cancel / complete actions for a pending Desktop sign-in. */
export function DesktopPendingActions() {
  const relay = useRelay();
  const { t } = useI18n();
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
  return (
    <>
      {workspaces > 1 && (
        <WorkspaceSelect
          accounts={relay.accounts}
          organizations={desktop!.organizations}
          value={targetOrg}
          onChange={setOrg}
          t={t}
        />
      )}
      {identityReady && !workspaces && (
        <p className="text-sm text-muted-foreground">{codeTabStep(t)}</p>
      )}
      <div className={actionsClass}>
        <Button
          variant="outline"
          size="sm"
          disabled={desktopBusy}
          onClick={() => void action("open", () => api.openDesktop())}
        >
          <ArrowUpRight />
          {t("Claude uygulamasını yeniden aç", "Reopen the Claude app")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={desktopBusy}
          onClick={() => relay.requestDesktop(pendingDesktop, "cancel")}
        >
          {t(
            "İptal et ve önceki hesaba dön",
            "Cancel and return to previous account",
          )}
        </Button>
        {identityReady && targetOrg && (
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
          <p className="text-sm text-muted-foreground">
            {t(
              "Claude uygulamasında doğru hesaba giriş yap ve Code sekmesini aç. Sonra girişi buradan kaydet.",
              "Sign in to the matching account inside the Claude app and open Code. Then save the sign-in here.",
            )}
          </p>
        </div>
      </div>
      <ConnectionProgress
        current={desktopIdentityReady ? 2 : 1}
        state={
          desktop?.busy ? "working" : desktop?.error ? "failed" : "waiting"
        }
        label={
          desktop?.busy
            ? t("Giriş kaydediliyor", "Saving sign-in")
            : desktop?.error
              ? t("Giriş kaydedilemedi", "Sign-in not saved")
              : desktopIdentityReady
                ? targetOrg
                  ? t("Claude uygulaması girişini kaydet", "Save Claude app sign-in")
                  : t("Code sekmesinin açılması bekleniyor", "Waiting for the Code tab")
                : t(
                    "Claude uygulamasında giriş bekleniyor",
                    "Waiting for sign-in in the Claude app",
                  )
        }
        steps={[
          {
            title: t("Claude uygulaması açıldı", "The Claude app opened"),
            detail: t("Giriş ekranı hazır", "Sign-in is ready"),
          },
          {
            title: t("Hesabına giriş yap", "Sign in"),
            detail: t(
              "Bağlayacağın hesabı seç",
              "Choose the account to connect",
            ),
          },
          {
            title: t("Code’u aç ve bağla", "Open Code & connect"),
            detail: t(
              "Girişi Relay’de kaydet",
              "Save the sign-in in Relay",
            ),
          },
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
          <p className="text-sm text-muted-foreground">
            {flow.status === "connected"
              ? t(
                  "Limit okuma girişi tamamlandı. Bu hesaba ait kullanım limitleri okunabilir.",
                  "Usage sign-in completed. Usage limits for this account can now be read.",
                )
              : flow.status === "verifying"
                ? t(
                    "Tarayıcı onayı alındı. Hesabın doğrulanıyor…",
                    "Browser authorization received. Verifying your account…",
                  )
                : flow.status === "failed"
                  ? localizeError(flow.error ?? "", language)
                  : flow.status === "cancelled"
                    ? t(
                        "Giriş iptal edildi. İstediğinde yeniden bağlanabilirsin.",
                        "Sign-in cancelled. You can reconnect whenever you like.",
                      )
                    : t(
                        "Tarayıcıda seçtiğin hesabı onayla. Bu ekran otomatik güncellenecek.",
                        "Authorize your chosen account in the browser. This screen updates automatically.",
                      )}
          </p>
        </div>
      </div>
      {flow.status === "connected" && flowAccount?.auth?.email && (
        <p className="text-sm font-medium">
          {flowAccount.auth.email}
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
              "This account is connected to another profile too. Both profiles share the same limits.",
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
                  ? t("Hesap doğrulanıyor", "Verifying account")
                  : flow.status === "waiting"
                    ? t(
                        "Tarayıcı onayı bekleniyor",
                        "Waiting for browser approval",
                      )
                    : t("Giriş hazırlanıyor", "Preparing sign-in")
        }
        steps={[
          {
            title: t("Girişi başlat", "Start sign-in"),
            detail: t(
              "Giriş sayfası hazırlanır",
              "The sign-in page is prepared",
            ),
          },
          {
            title: t("Tarayıcıda onayla", "Approve in browser"),
            detail: t(
              "Hesabını seç ve izin ver",
              "Choose and authorize your account",
            ),
          },
          {
            title: t("Bağlantıyı doğrula", "Verify connection"),
            detail: t(
              "Relay sonucu otomatik kontrol eder",
              "Relay checks the result automatically",
            ),
          },
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
            <Button
              variant="outline"
              size="sm"
              disabled={!!busy || !flow.browserReady}
              onClick={() =>
                void action("reopen", () =>
                  api.reopenLogin(flow.accountId, flow.id),
                )
              }
            >
              <ArrowUpRight />
              {t("Tarayıcıyı yeniden aç", "Reopen browser")}
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
