import { useState, type ReactNode } from "react";
import { Globe2, KeyRound, Monitor, Network } from "lucide-react";
import { PageSection } from "@/components/PageSection";
import { AccountLimits } from "@/features/Providers";
import { AntigravityAction, AntigravityPrompt, antigravityAccountState, type AntigravityAsk } from "@/features/AntigravityAccount";
import { UsageCard } from "@/features/UsageCard";
import { HistorySummary } from "@/features/HistorySummary";
import { DesktopSetup } from "@/features/DesktopSetup";
import { Private } from "@/components/Private";
import { RefreshIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Disclosure } from "@/components/Disclosure";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { pendingFlow } from "@/data/selectors";
import { useExtensionStatus } from "@/data/useExtension";
import { useTerminalStatus } from "@/data/useTerminal";
import { CliFlowPanel } from "@/app/ConnectionPanels";
import { PageBody } from "@/app/PageFrame";
import { RelayErrorAlert } from "@/app/RelayErrorAlert";
import { routeHash } from "@/app/routes";
import { isClaudeAccount, usageSignInStatus } from "@/lib/account-health";
import { formatRelative } from "@/lib/time";
import type { Account, ExtensionStatus, RelaySettings } from "../../../../shared/types";
import type { TerminalStatus } from "../../../../shared/terminal-identity";
import {
  desktopCliMismatch,
  desktopCliWorkspaceMismatch,
  duplicateCliAccount,
} from "../../../../shared/account-state";
import { historySources } from "../../../../shared/history-policy";
import { freshUsage } from "../../../../shared/usage";
import { accountPlan, groupName, providerLabel } from "../accountLabels";
import { ConnectionList, ConnectionRow } from "./Connections";
import { ExtensionConnection } from "./ExtensionConnection";
import { TerminalConnection } from "./TerminalConnection";

/**
 * The closed Code history row's summary: how many other accounts' history the next merge brings
 * (`historySources`, the list the open section names), and why, by the history setting.
 */
export function historyLine(
  sources: number,
  transfer: RelaySettings["desktopHistoryTransfer"],
  t: (tr: string, en: string) => string,
): string {
  if (!sources) return t("paylaşılmıyor", "not shared");
  return transfer === "same-group"
    ? t(`aynı gruptaki ${sources} hesapla paylaşılıyor`, `shared with ${sources} ${sources === 1 ? "account" : "accounts"} in the same group`)
    : t(`${sources} hesapla paylaşılıyor`, `shared with ${sources} ${sources === 1 ? "account" : "accounts"}`);
}

/** The page's contents under its header; rendered apart so it can be tested statically. */
export function AccountDetailBody({
  account: a,
  now,
  extensionStatus,
  terminalStatus,
}: {
  account: Account;
  now?: number;
  /** The browser extension's status, for static rendering; otherwise read, and checked, on mount. */
  extensionStatus?: ExtensionStatus;
  /** The terminal's sign-in status, for static rendering; otherwise read, and checked, on mount. */
  terminalStatus?: TerminalStatus;
}) {
  const relay = useRelay();
  const { t, language } = useI18n();
  const {
    api,
    data,
    desktop,
    accounts,
    settings,
    busy,
    usageBusy,
    desktopBusy,
    pendingDesktop,
    hasUnclaimedDesktop,
    targetOrg,
    desktopRequest,
    setupId,
    setSetupId,
    action,
    setNotice,
    historyRevision,
  } = relay;
  const usage = data?.usage[a.id];
  const authFlow = data?.authFlows.find((f) => f.accountId === a.id);
  const waiting = pendingFlow(authFlow);
  const mismatch = desktopCliMismatch(a);
  const duplicate = duplicateCliAccount(a, accounts);
  const signIn = usageSignInStatus(a, usage, waiting, t, data?.diagnostics?.platform);
  // The header badge's name, never the raw word ("plus", "Antigravity OAuth").
  const plan = accountPlan(a);
  const browserSteps = ["darwin", "preview", "linux"].includes(data?.diagnostics?.platform ?? "");
  const extension = useExtensionStatus({ check: browserSteps, initial: extensionStatus });
  const terminal = useTerminalStatus({ check: browserSteps, initial: terminalStatus });
  // Only what a switch needs counts: the Claude app sign-in and the usage sign-in. The extension
  // and the terminal are optional and say their own state on their rows.
  const claude = isClaudeAccount(a);
  const gateway = desktop?.proxyStatus;
  // The gateway lists every account; only one with a sign-in can take requests.
  const signedIn = a.auth?.loggedIn === true;
  const inPool = !!gateway?.running && signedIn;
  // Antigravity's own app is a connection too: the app and agy run on the account Relay moves them to.
  const [antigravityAsk, setAntigravityAsk] = useState<AntigravityAsk>();
  const appState = a.provider === "antigravity" ? antigravityAccountState(data?.antigravity, a.id) : undefined;
  const appRow = appState !== undefined && appState !== "unavailable";
  const connections = claude
    ? [!!a.desktop, signIn.tone === "ok"]
    : [...(appRow ? [appState === "current" || appState === "saved"] : []), signedIn, inPool];
  const ready = connections.filter(Boolean).length;
  const history = historySources(a, accounts, settings);
  return (
    <PageBody className="gap-3 pb-6">
      <RelayErrorAlert />
      {duplicate && (
        <p
          role="status"
          className="rounded-lg border border-warn/40 bg-warn/10 px-4 py-2.5 text-sm"
        >
          {t(
            `Bu hesap ${duplicate.name} profiline de bağlı. İki profil aynı limitleri paylaşır.`,
            `This account is also connected to ${duplicate.name}. Both profiles share the same limits.`,
          )}
        </p>
      )}
      {a.desktop?.rejectedAt && (
        <div
          role="alert"
          data-slot="sign-in-ended"
          className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-crit/40 bg-crit/10 px-4 py-2.5 text-sm"
        >
          <p className="min-w-0 flex-1">
            {t(
              "Bu hesabın kayıtlı Claude girişi sona ermiş: Claude hesabı açınca oturumu kapattı ya da hesap uzun süre kullanılmadığı için girişin süresi doldu. Yeniden giriş yapana kadar Relay bu hesaba kendiliğinden geçmez. Hesap eklerken Claude’un içinden çıkış yapma; çıkış, kayıtlı girişi de bitirir.",
              "This account’s saved Claude sign-in has ended: Claude signed out when it opened the account, or the sign-in expired because the account was not used for a long time. Relay does not switch to it by itself until you sign in again. Do not sign out inside Claude to add an account; signing out also ends the saved sign-in.",
            )}
          </p>
          <Button
            size="sm"
            disabled={desktopBusy || !!pendingDesktop}
            onClick={() => relay.requestDesktop(a, "reconnect")}
          >
            {t("Yeniden giriş yap", "Sign in again")}
          </Button>
        </div>
      )}
      {mismatch && (
        <p
          role="alert"
          className="rounded-lg border border-crit/40 bg-crit/10 px-4 py-2.5 text-sm"
        >
          {desktopCliWorkspaceMismatch(a)
            ? t(
                "Limit okuma girişi bu hesabın başka bir çalışma alanına ait. Claude uygulamasında o çalışma alanında Code’u aç; Relay profili oraya kendisi taşır.",
                "The usage sign-in belongs to another workspace of this account. Open Code in that workspace in the Claude app; Relay then moves the profile there.",
              )
            : t(
                "Claude uygulaması girişi ile limit okuma girişi farklı hesaplara ait. Limit okuma girişini bu profilin hesabıyla yenile.",
                "The Claude app sign-in and the usage sign-in are for different accounts. Renew the usage sign-in with this profile’s account.",
              )}
        </p>
      )}
      <div className="grid gap-5">
        <PageSection title={t("Limitler", "Limits")} aside={freshUsage(usage, now ?? Date.now()) && usage?.checkedAt ? (
                  <span className="flex items-center gap-1">
                    {t(
                      `${formatRelative(usage.checkedAt, now ?? Date.now(), language)} güncellendi`,
                      `Updated ${formatRelative(usage.checkedAt, now ?? Date.now(), language)}`,
                    )}
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={t("Limitleri yenile", "Refresh limits")}
                      disabled={usageBusy.has(a.id)}
                      onClick={() => void relay.refreshUsage(a)}
                    >
                      <RefreshIcon className={usageBusy.has(a.id) ? "animate-spin" : undefined} />
                    </Button>
                  </span>
                ) : undefined}>
          <Card padded>
            {freshUsage(usage, now ?? Date.now()) ? (
              <AccountLimits usage={usage} now={now ?? Date.now()} max={8} layout="grid" />
            ) : !claude ? (
              // No Claude sign-in to offer: Relay has no limit reader for this provider yet.
              <p data-slot="no-limit-reader" className="text-xs text-muted-foreground">
                {t(
                  `Relay ${providerLabel(a.provider)} hesaplarının limitini okuyamıyor; ağ geçidi bu hesabı limit bilgisi olmadan kullanır.`,
                  `Relay cannot read ${providerLabel(a.provider)} limits; the gateway uses this account without them.`,
                )}
              </p>
            ) : (
            <UsageCard
              usage={usage}
              busy={usageBusy.has(a.id)}
              connectBusy={!!busy || waiting}
              settings={settings}
              t={t}
              language={language}
              now={now}
              refresh={(allowPrompt) => void relay.refreshUsage(a, allowPrompt)}
              connect={() => void relay.startCli(a)}
              appSignIn={!!a.desktop}
              connectElsewhere
            />
            )}
          </Card>
        </PageSection>
        <PageSection title={t("Bağlantılar", "Connections")} aside={<span className="text-xs text-muted-foreground">{t(
                `${ready} / ${connections.length} hazır`,
                `${ready} / ${connections.length} ready`,
              )}</span>}>
          <Card padded data-slot="connections">
            <ConnectionList>
            {!claude && (
              <>
                {appRow && (
                  <ConnectionRow
                    icon={<Monitor />}
                    title={t("Antigravity uygulaması", "Antigravity app")}
                    purpose={t("Uygulama ve agy bu hesapla çalışır.", "The app and agy run on this account.")}
                    tone={appState === "current" || appState === "saved" ? "ok" : "warn"}
                    status={
                      appState === "current"
                        ? t("Şu an açık", "Open now")
                        : appState === "saved"
                          ? t("Giriş kayıtlı", "Sign-in saved")
                          : appState === "waiting"
                            ? t("Giriş bekleniyor", "Waiting for sign-in")
                            : t("Giriş kayıtlı değil", "Sign-in not saved")
                    }
                    action={<AntigravityAction account={a} onAsk={setAntigravityAsk} primary />}
                  >
                    <div className="mt-2 empty:hidden">
                      <AntigravityPrompt ask={antigravityAsk} onClose={() => setAntigravityAsk(undefined)} now={now ?? Date.now()} />
                    </div>
                  </ConnectionRow>
                )}
                <ConnectionRow
                  icon={<KeyRound />}
                  title={t("Ağ geçidi girişi", "Gateway sign-in")}
                  purpose={t("Ağ geçidi bu girişle istek gönderir.", "The gateway sends requests with it.")}
                  tone={signedIn ? "ok" : "warn"}
                  status={signedIn ? t("Kayıtlı", "Saved") : t("Giriş yok: hesabı yeniden ekle", "Not signed in: add the account again")}
                  where={signedIn && a.auth?.email ? <Private>{a.auth.email}</Private> : undefined}
                />
                <ConnectionRow
                  icon={<Network />}
                  title={t("Ağ geçidi", "Gateway")}
                  purpose={t("İstekleri hesaplara dağıtır.", "Spreads requests over the accounts.")}
                  tone={inPool ? "ok" : "off"}
                  status={
                    gateway?.running
                      ? inPool
                        ? t("Havuzda", "In the pool")
                        : t("Girişi olmadığı için havuzda değil", "Not in the pool: no sign-in")
                      : t("Proxy kapalı", "Gateway off")
                  }
                  action={
                    <Button size="sm" variant="outline" asChild>
                      <a href={routeHash("proxy")}>{t("Aç", "Open")}</a>
                    </Button>
                  }
                />
              </>
            )}
            {claude && (
            <>
            <ConnectionRow
              icon={<Monitor />}
              title={t("Claude uygulaması", "Claude app")}
              purpose={t("Claude uygulamasını bu hesapla açar.", "Opens the Claude app with this account.")}
              tone={a.desktop ? (a.desktop.rejectedAt ? "crit" : "ok") : "off"}
              status={
                a.desktop
                  ? a.desktop.rejectedAt
                    ? t("Sona ermiş", "Ended")
                    : t("Kayıtlı", "Saved")
                  : t("Kayıtlı değil", "Not saved")
              }
              action={
                a.desktop ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={desktopBusy || !!pendingDesktop}
                    onClick={() => relay.requestDesktop(a, "reconnect")}
                  >
                    {t("Yenile…", "Renew…")}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    disabled={
                      desktopBusy ||
                      !desktop?.available ||
                      !!pendingDesktop ||
                      !!desktop?.recoveryRequired
                    }
                    onClick={() => {
                      setSetupId(a.id);
                      relay.cancelDesktopRequest();
                    }}
                  >
                    {t("Girişi kaydet", "Save sign-in")}
                  </Button>
                )
              }
            >
              {setupId === a.id && !pendingDesktop && !desktopRequest && (
                <DesktopSetup
                  account={a}
                  accounts={accounts}
                  desktop={desktop}
                  unclaimed={hasUnclaimedDesktop}
                  org={targetOrg}
                  busy={desktopBusy}
                  t={t}
                  selectOrg={relay.setOrg}
                  close={() => setSetupId(undefined)}
                  connect={() =>
                    relay.requestDesktop(a, hasUnclaimedDesktop ? "capture" : "login")
                  }
                />
              )}
            </ConnectionRow>
            <ConnectionRow
              icon={<Globe2 />}
              title={t("Limit okuma girişi", "Usage sign-in")}
              purpose={t("Limitleri okur.", "Reads the limits.")}
              tone={signIn.tone}
              status={signIn.label}
              action={
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!!busy || waiting}
                  onClick={() => void relay.startCli(a)}
                >
                  {a.auth?.email ? t("Yenile", "Renew") : t("Giriş yap", "Sign in")}
                </Button>
              }
              refresh={
                a.auth?.email && (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t(
                        "Limit okuma girişini doğrula",
                        "Verify usage sign-in",
                      )}
                      title={t(
                        "Limit okuma girişini doğrula",
                        "Verify usage sign-in",
                      )}
                      disabled={!!busy || waiting}
                      onClick={() =>
                        void action(`verify:${a.id}`, async () => {
                          const checked = await api.checkAuth(a.id);
                          setNotice(
                            checked.auth?.loggedIn
                              ? t(
                                  `${a.name} · ${checked.auth.email ?? ""} limit okuma girişi doğrulandı.`,
                                  `${a.name} · ${checked.auth.email ?? ""} usage sign-in verified.`,
                                )
                              : t(
                                  "Limit okuma girişi doğrulanamadı. Limit okuma girişini yenile.",
                                  "Relay cannot verify the usage sign-in. Renew it.",
                                ),
                          );
                        })
                      }
                    >
                      <RefreshIcon />
                    </Button>
                )
              }
            >
              {relay.flow?.accountId === a.id && <CliFlowPanel embedded />}
              {/* The renewal Relay runs by itself near a sign-in's end, started now. */}
              {data?.diagnostics?.platform === "darwin" && a.desktop && a.auth?.loggedIn && (
                <Button
                  size="xs"
                  variant="ghost"
                  className="justify-self-start"
                  disabled={!!busy || waiting}
                  onClick={() =>
                    void action(`renew-quiet:${a.id}`, async () => {
                      const outcome = await api.renewSignInNow(a.id);
                      setNotice(
                        outcome.result === "connected"
                          ? t(
                              `${a.name} · Claude Code girişi arka planda yenilendi.`,
                              `${a.name} · the Claude Code sign-in was renewed in the background.`,
                            )
                          : outcome.result === "waiting"
                            ? t(
                                `${a.name} · claude.ai yeni bir giriş istiyor (${outcome.detail ?? ""}). Claude uygulamasında bu hesaba yeniden gir ya da “Yenile” ile tarayıcıdan gir.`,
                                `${a.name} · claude.ai asks for a recent sign-in (${outcome.detail ?? ""}). Sign in to this account again in the Claude app, or use “Renew” to sign in through the browser.`,
                              )
                            : t(
                              `${a.name} · arka planda yenilenemedi (${outcome.detail ?? outcome.result}). “Yenile” ile tarayıcıdan giriş yap.`,
                              `${a.name} · could not be renewed in the background (${outcome.detail ?? outcome.result}). Use “Renew” to sign in through the browser.`,
                            ),
                      );
                      await relay.refreshUsage(a);
                    })
                  }
                >
                  {t("Girişi şimdi arka planda yenile", "Renew the sign-in in the background now")}
                </Button>
              )}
            </ConnectionRow>
            {/* The extension's and terminal's sign-ins are kept on macOS and Linux; the browser preview shows the rows too. */}
            {browserSteps && <ExtensionConnection account={a} extension={extension} />}
            {browserSteps && <TerminalConnection account={a} terminal={terminal} />}
            </>
            )}
            </ConnectionList>
          </Card>
        </PageSection>
        <PageSection title={t("Hesap", "Account")}>
          <Card padded>
            <dl className="-mx-1 grid text-sm @xl:grid-cols-2 @xl:gap-x-8">
              {([
                [t("Sağlayıcı", "Provider"), providerLabel(a.provider)],
                [t("E-posta", "Email"), (a.desktop?.email ?? a.auth?.email) ? <Private>{a.desktop?.email ?? a.auth?.email}</Private> : "—"],
                [t("Kuruluş", "Organization"), a.auth?.orgName ? <Private>{a.auth.orgName}</Private> : "—"],
                [
                  t("Tür · grup", "Type · group"),
                  (a.kind === "personal" ? t("Kişisel", "Personal") : t("Şirket", "Work")) +
                    (a.kind === "work" ? ` · ${groupName(a, t)}` : ""),
                ],
                ...(plan ? [[t("Abonelik", "Subscription"), plan.label]] : []),
                // The plan is set on the Planning page; here it only says whether the account is in it.
                ...(claude
                  ? [[
                      t("Planda", "In the plan"),
                      <a key="plan" href={routeHash("planlama")} className="text-primary hover:underline">
                        {a.planning?.plan ? t("Evet · Planlama ›", "Yes · Planning ›") : t("Hayır · Planlama ›", "No · Planning ›")}
                      </a>,
                    ]]
                  : []),
              ] as [string, ReactNode][]).map(([label, value]) => (
                <div key={label} className="flex min-w-0 items-baseline justify-between gap-3 border-t px-1 py-2 first:border-0 @xl:[&:nth-child(2)]:border-0">
                  <dt className="shrink-0 text-muted-foreground">{label}</dt>
                  <dd className="min-w-0 truncate text-right" title={typeof value === "string" ? value : undefined}>
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          </Card>
          {a.desktop && (
            <Card padded>
              <Disclosure
                title={t("Code geçmişi", "Code history")}
                summary={historyLine(history.length, settings.desktopHistoryTransfer, t)}
              >
                <HistorySummary
                  key={`${a.id}:${historyRevision}`}
                  account={a}
                  sources={history}
                  api={api}
                  t={t}
                />
              </Disclosure>
            </Card>
          )}
        </PageSection>
      </div>
    </PageBody>
  );
}
