import { useCallback, useEffect, useState, type ReactNode } from "react";
import { AppWindow, Globe2, Monitor, RefreshCw } from "lucide-react";
import type { Account, InstalledBrowser } from "../../../shared/types";
import {
  desktopCliMismatch,
  duplicateCliAccount,
} from "../../../shared/account-state";
import { historySources } from "../../../shared/history-policy";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Disclosure } from "@/components/Disclosure";
import { StatusDot } from "@/components/StatusDot";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { pendingFlow } from "@/data/selectors";
import { CliFlowPanel } from "@/app/ConnectionPanels";
import { RelayErrorAlert } from "@/app/RelayErrorAlert";
import { accountHealth, usageSignInStatus } from "@/lib/account-health";
import { UsageCard } from "../../features/UsageCard";
import { HistorySummary } from "../../features/HistorySummary";
import { DesktopSetup } from "../../features/DesktopSetup";
import { PlanEditor } from "../../features/PlanEditor";
import { rowActions } from "./AccountsTable";
import { groupName, planLabel } from "./accountLabels";
import {
  browserOptions,
  browserStatus,
  browserValue,
  chosenLabel,
  openResultText,
} from "./browserProfile";

export function AccountSheet({
  account,
  close,
}: {
  account?: Account;
  close: () => void;
}) {
  const { t } = useI18n();
  const plan = account && planLabel(account);
  return (
    <Sheet open={!!account} onOpenChange={(open) => !open && close()}>
      <SheetContent
        side="right"
        className="w-[360px] gap-0 overflow-y-auto sm:max-w-[360px]"
      >
        {account && (
          <>
            <SheetHeader className="pr-10">
              <div className="flex min-w-0 items-center gap-2">
                <SheetTitle className="truncate text-base">
                  {account.name}
                </SheetTitle>
                {plan && <Badge variant="secondary">{plan}</Badge>}
              </div>
              <SheetDescription className="sr-only">
                {t("Hesap ayrıntıları", "Account details")}
              </SheetDescription>
            </SheetHeader>
            <AccountSheetBody account={account} />
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-2">
      <h3 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

function ConnectionRow({
  icon,
  title,
  status,
  tone,
  actions,
  children,
}: {
  icon: ReactNode;
  title: string;
  status: string;
  tone: "ok" | "warn" | "crit" | "off";
  actions: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="grid gap-2 rounded-lg border p-3">
      <div className="flex min-w-0 items-start gap-2.5">
        <span className="mt-0.5 text-muted-foreground [&_svg]:size-4">
          {icon}
        </span>
        <div className="min-w-0">
          <div className="text-sm font-semibold">{title}</div>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <StatusDot tone={tone} />
            <span className="min-w-0 break-words">{status}</span>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">{actions}</div>
      {children}
    </div>
  );
}

/**
 * The browser profile opened after a switch to this account, so the Claude extension signed in
 * there is the one Claude finds. Profiles are listed when the sheet opens and the picker does.
 */
export function BrowserProfileRow({
  account: a,
  initialBrowsers,
}: {
  account: Account;
  /** For static rendering; otherwise listed on mount. */
  initialBrowsers?: InstalledBrowser[];
}) {
  const { api, accounts, busy, action } = useRelay();
  const { t } = useI18n();
  const [browsers, setBrowsers] = useState(initialBrowsers);
  const [opened, setOpened] = useState<string>();
  const list = useCallback(() => {
    api.browserProfiles().then(setBrowsers, () => {});
  }, [api]);
  useEffect(list, [list]);
  useEffect(
    () => setOpened(undefined),
    [a.id, a.browser?.app, a.browser?.profile],
  );
  const status = browserStatus(a, browsers, t);
  const options = browserOptions(a, accounts, browsers ?? [], t);
  const current = a.browser ? browserValue(a.browser) : "none";
  const label = chosenLabel(a, browsers);
  return (
    <ConnectionRow
      icon={<AppWindow />}
      title={t("Tarayıcı profili", "Browser profile")}
      tone={status.tone}
      status={status.label}
      actions={
        <>
          <Select
            value={current}
            disabled={!!busy}
            onOpenChange={(open) => open && list()}
            onValueChange={(value) => {
              const option = options.find((o) => o.value === value);
              void action(`browser:${a.id}`, () =>
                api.setAccountBrowser(
                  a.id,
                  option ? { app: option.app, profile: option.profile } : null,
                ),
              );
            }}
          >
            <SelectTrigger
              size="sm"
              aria-label={t(
                `${a.name} tarayıcı profili`,
                `${a.name} browser profile`,
              )}
              className="max-w-full min-w-0"
            >
              {/* Children keep the label in static markup, before Radix measures items. */}
              <SelectValue>
                {label ?? t("Profil seç", "Choose a profile")}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">{t("Yok", "None")}</SelectItem>
              {label && !options.some((o) => o.value === current) && (
                <SelectItem value={current}>{label}</SelectItem>
              )}
              {options.map((o) => (
                <SelectItem key={o.value} value={o.value} disabled={o.disabled}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {a.browser && label && (
            <Button
              size="sm"
              variant="outline"
              disabled={!!busy}
              onClick={() =>
                void action(`browser-open:${a.id}`, async () =>
                  setOpened(
                    openResultText(
                      await api.openAccountBrowser(a.id),
                      label,
                      t,
                    ),
                  ),
                )
              }
            >
              {t("Şimdi aç", "Open now")}
            </Button>
          )}
        </>
      }
    >
      {opened && (
        <p role="status" className="text-xs">
          {opened}
        </p>
      )}
      {browsers?.length === 0 && (
        <p className="text-xs text-warn-foreground">
          {t(
            "Desteklenen bir tarayıcı bulunamadı (Chrome, Brave, Edge, Chromium, Vivaldi).",
            "No supported browser found (Chrome, Brave, Edge, Chromium, Vivaldi).",
          )}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        {t(
          "Claude uygulaması tarayıcı eklentisini hesaba göre bulur. Her hesap için ayrı bir tarayıcı profili aç ve Claude eklentisine orada bu hesapla bir kez giriş yap. Relay geçişten sonra yalnızca bu profili açar; eklentiye giriş yapmaz, girişini okumaz.",
          "The Claude app finds the browser extension by account. Give each account its own browser profile, and sign in to the Claude extension there once, with this account. After a switch, Relay only opens this profile; it never signs in to the extension or reads its sign-in.",
        )}
      </p>
    </ConnectionRow>
  );
}

/** Sheet contents, rendered outside the portal so it can be tested statically. */
export function AccountSheetBody({
  account: a,
  now,
}: {
  account: Account;
  now?: number;
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
  const health = accountHealth(
    a,
    usage,
    {
      active: a.id === relay.active?.id,
      desktopRunning: !!desktop?.running,
      waiting,
    },
    t,
  );
  const signIn = usageSignInStatus(a, usage, waiting, t);
  // What the connections must show, so a new one opens them: a sign-in flow of this account (even a
  // failed or finished one, whose panel sits there), the Claude app setup, or a problem.
  const connectionsKey =
    relay.flow?.accountId === a.id
      ? `flow:${relay.flow.id}`
      : setupId === a.id
        ? "setup"
        : health.tone !== "ok"
          ? "attention"
          : undefined;
  // One primary action: the fix, else the switch (which the active account does not have).
  const primary = rowActions(a, relay, t, (id) => {
    setSetupId(id);
    relay.cancelDesktopRequest();
  }).find((x) => x.key === (health.fix ?? "switch"));
  return (
    <div className="grid gap-5 px-4 pb-6">
      {/* The page banners sit under the sheet; failures of its actions show here. */}
      <RelayErrorAlert />
      <div
        data-slot="account-status"
        className="grid gap-1.5 rounded-lg border p-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2 text-sm font-semibold">
            <StatusDot tone={health.tone} />
            <span className="min-w-0 break-words">{health.label}</span>
          </div>
          {primary && (
            <Button size="sm" disabled={primary.disabled} onClick={primary.run}>
              {primary.label}
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">{health.detail}</p>
      </div>
      <dl className="grid grid-cols-[96px_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">{t("E-posta", "Email")}</dt>
        <dd className="min-w-0 break-words">
          {a.desktop?.email ??
            a.auth?.email ??
            t("Giriş bekleniyor", "Waiting for sign-in")}
        </dd>
        <dt className="text-muted-foreground">
          {t("Kuruluş", "Organization")}
        </dt>
        <dd className="min-w-0 break-words">{a.auth?.orgName ?? "—"}</dd>
        <dt className="text-muted-foreground">
          {t("Tür · grup", "Type · group")}
        </dt>
        <dd className="min-w-0 break-words">
          {a.kind === "personal"
            ? t("Kişisel", "Personal")
            : t("Şirket", "Work")}
          {a.kind === "work" ? ` · ${groupName(a, t)}` : ""}
        </dd>
        {a.auth?.subscription && (
          <>
            <dt className="text-muted-foreground">
              {t("Abonelik", "Subscription")}
            </dt>
            <dd>{a.auth.subscription}</dd>
          </>
        )}
      </dl>
      {duplicate && (
        <p
          role="status"
          className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm"
        >
          {t(
            `Bu hesap ${duplicate.name} profiline de bağlı. İki profil aynı kullanım limitlerini paylaşır.`,
            `This account is also connected to ${duplicate.name}. Both profiles share the same usage limits.`,
          )}
        </p>
      )}
      {mismatch && (
        <p
          role="alert"
          className="rounded-lg border border-crit/40 bg-crit/10 px-3 py-2 text-sm"
        >
          {t(
            "Claude uygulaması girişi ile limit okuma girişi farklı hesaplara ait. Limit okuma girişini bu profilin hesabıyla yenile.",
            "The Claude app sign-in and the usage sign-in belong to different accounts. Renew the usage sign-in with this profile’s account.",
          )}
        </p>
      )}
      <Section title={t("Plan", "Plan")}>
        <PlanEditor
          account={a}
          disabled={!!busy}
          t={t}
          update={(input) =>
            void action(`plan:${a.id}`, () =>
              api.updateAccountPlanning(a.id, input),
            )
          }
        />
      </Section>
      <Section title={t("Limitler", "Limits")}>
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
        />
      </Section>
      <Disclosure
        title={t("Bağlantılar", "Connections")}
        defaultOpen={!!connectionsKey}
        openKey={connectionsKey}
      >
        <ConnectionRow
          icon={<Monitor />}
          title={t("Claude uygulaması girişi", "Claude app sign-in")}
          tone={a.desktop ? "ok" : "off"}
          status={
            (a.desktop
              ? t(
                  "Kaydedildi · hesap geçişine hazır",
                  "Saved · ready to switch",
                )
              : t(
                  "İlk kurulum gerekli · henüz geçiş yapılamaz",
                  "Setup required · switching is not ready yet",
                )) +
            t(
              " · Claude uygulamasını bu hesapla açmak için kaydedilir.",
              " · Saved to open the Claude app with this account.",
            )
          }
          actions={
            a.desktop ? (
              <Button
                size="sm"
                variant="outline"
                disabled={desktopBusy || !!pendingDesktop}
                onClick={() => relay.requestDesktop(a, "reconnect")}
              >
                {t(
                  "Claude uygulaması girişini yenile…",
                  "Renew Claude app sign-in…",
                )}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
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
                {t(
                  "Claude uygulaması girişini kaydet",
                  "Save Claude app sign-in",
                )}
              </Button>
            )
          }
        />
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
        <ConnectionRow
          icon={<Globe2 />}
          title={t("Limit okuma girişi", "Usage sign-in")}
          tone={signIn.tone}
          status={
            signIn.label +
            (a.auth?.email ? ` · ${a.auth.email}` : "") +
            t(
              " · Limitleri okumak için tarayıcıda onaylanır.",
              " · Approved in the browser to read limits.",
            )
          }
          actions={
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={!!busy || waiting}
                onClick={() => void relay.startCli(a)}
              >
                {waiting
                  ? t("Bağlanıyor…", "Connecting…")
                  : a.auth?.email
                    ? t("Limit okuma girişini yenile", "Renew usage sign-in")
                    : t("Limit okuma girişi yap", "Sign in to read usage")}
              </Button>
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
                            "Could not verify the usage sign-in. Renew the usage sign-in.",
                          ),
                    );
                  })
                }
              >
                <RefreshCw />
              </Button>
            </>
          }
        />
        {/* The page-frame panel sits under the sheet; finish the sign-in here. */}
        {relay.flow?.accountId === a.id && <CliFlowPanel embedded />}
        {/* Profiles open only on macOS; the browser preview shows the row too. */}
        {["darwin", "preview"].includes(data?.diagnostics?.platform ?? "") && (
          <BrowserProfileRow key={a.id} account={a} />
        )}
      </Disclosure>
      {a.desktop && (
        <Disclosure title={t("Code geçmişi", "Code history")}>
          <HistorySummary
            key={`${a.id}:${historyRevision}`}
            account={a}
            sources={historySources(a, accounts, settings)}
            api={api}
            t={t}
          />
        </Disclosure>
      )}
    </div>
  );
}
