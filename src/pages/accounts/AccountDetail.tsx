import { Fragment, type ReactNode } from "react";
import {
  AppWindow,
  ArrowLeft,
  Link2,
  Globe2,
  LoaderCircle,
  Monitor,
  MoreHorizontal,
  RefreshCw,
} from "lucide-react";
import type { Account, ExtensionStatus } from "../../../shared/types";
import {
  desktopCliMismatch,
  duplicateCliAccount,
} from "../../../shared/account-state";
import { historySources } from "../../../shared/history-policy";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Disclosure } from "@/components/Disclosure";
import { StatusDot } from "@/components/StatusDot";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { pendingFlow } from "@/data/selectors";
import { useExtensionStatus } from "@/data/useExtension";
import { CliFlowPanel } from "@/app/ConnectionPanels";
import { PageFrame } from "@/app/PageFrame";
import { RelayErrorAlert } from "@/app/RelayErrorAlert";
import { routeHash } from "@/app/routes";
import { accountHealth, usageSignInStatus } from "@/lib/account-health";
import { accountUuids, extensionGuide } from "@/lib/extension-ui";
import { cn } from "@/lib/utils";
import { offerAfter, usePrank } from "@/pranks/PrankStage";
import { UsageCard } from "../../features/UsageCard";
import { LimitRings } from "@/components/LimitRings";
import { freshUsage } from "../../../shared/usage";
import { formatRelative } from "@/lib/time";
import { HistorySummary } from "../../features/HistorySummary";
import { DesktopSetup } from "../../features/DesktopSetup";
import { PlanEditor } from "../../features/PlanEditor";
import { itemHandlers, rowActions } from "./AccountsTable";
import { avatarClass, groupName, planLabel } from "./accountLabels";

/** `#/hesaplar/<id>`: an account's own page, in place of the list. */
export const accountHash = (id: string) =>
  `${routeHash("hesaplar")}/${encodeURIComponent(id)}`;
/** The account id in `#/hesaplar/<id>`, if any. */
export function accountFromHash(hash: string): string | undefined {
  const match = hash.match(/^#\/?hesaplar\/([^?/]+)/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

/**
 * An account's page: its status and one primary action, its limits, the three connections Relay
 * needs (the Claude app, the usage sign-in, the browser extension), each with what it is for and
 * what to do, then its Code history; the facts and the plan sit beside them.
 */
export function AccountDetail({
  account: a,
  back,
}: {
  account: Account;
  back: () => void;
}) {
  const relay = useRelay();
  const prank = usePrank();
  const { t, language } = useI18n();
  const plan = planLabel(a);
  const email = a.desktop?.email ?? a.auth?.email;
  const actions = rowActions(a, relay, t, (id) => {
    relay.setSetupId(id);
    relay.cancelDesktopRequest();
  });
  const usage = relay.data?.usage[a.id];
  const waiting = pendingFlow(
    relay.data?.authFlows.find((f) => f.accountId === a.id),
  );
  const health = accountHealth(
    a,
    usage,
    {
      active: a.id === relay.active?.id,
      desktopRunning: !!relay.desktop?.running,
      waiting,
    },
    t,
  );
  // One primary action: the fix, else the switch (which the active account does not have).
  const primary = actions.find((x) => x.key === (health.fix ?? "switch"));
  return (
    <PageFrame
      title={a.name}
      description={[email, a.auth?.orgName].filter(Boolean).join(" · ") || undefined}
      cliFlowInline={relay.flow?.accountId === a.id}
      leading={
        <span
          aria-hidden="true"
          className={cn(
            "grid size-10 shrink-0 place-items-center rounded-full text-base font-semibold",
            avatarClass[a.color] ?? "bg-muted text-muted-foreground",
          )}
        >
          {a.name.slice(0, 1).toLocaleUpperCase(language)}
        </span>
      }
      badge={
        <>
          {plan && <Badge variant="secondary">{plan}</Badge>}
          <span
            data-slot="account-health"
            title={health.detail}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium"
          >
            <StatusDot tone={health.tone} />
            {health.label}
          </span>
        </>
      }
      back={
        <Button variant="ghost" size="sm" className="-ml-2 h-7 px-2 text-muted-foreground" onClick={back}>
          <ArrowLeft />
          {t("Hesaplar", "Accounts")}
        </Button>
      }
      actions={
        <>
          {primary && (
            <Button
              disabled={primary.disabled}
              onClick={(e) =>
                primary.key === "switch"
                  ? offerAfter(prank, "nibble-cursor", e, primary.run)
                  : primary.run()
              }
            >
              <primary.icon />
              {primary.label}
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                aria-label={t(`${a.name} işlemleri`, `${a.name} actions`)}
              >
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {actions
                .filter((x) => x !== primary)
                .map(({ key, label, icon: Icon, disabled, run }) => (
                  <Fragment key={key}>
                    {key === "refresh" && <DropdownMenuSeparator />}
                    <DropdownMenuItem
                      disabled={disabled}
                      {...itemHandlers({ key, disabled, run }, prank)}
                    >
                      <Icon />
                      {label}
                    </DropdownMenuItem>
                  </Fragment>
                ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      }
    >
      <AccountDetailBody account={a} />
    </PageFrame>
  );
}

const cardClass = "gap-0 px-5 py-4";

function CardTitle({ title, aside }: { title: string; aside?: ReactNode }) {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-2">
      <h2 className="font-semibold">{title}</h2>
      {aside && <span className="text-xs text-muted-foreground">{aside}</span>}
    </div>
  );
}

/**
 * A connection: what it is for, its state and its action, on one row; a guide or a setup panel
 * opens under it.
 */
function ConnectionRow({
  icon,
  title,
  purpose,
  status,
  tone,
  actions,
  children,
}: {
  icon: ReactNode;
  title: string;
  purpose: string;
  status: string;
  tone: "ok" | "warn" | "crit" | "off";
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div
      data-slot="connection"
      className="grid gap-2 border-t py-3.5 first:border-0 first:pt-0 last:pb-0"
    >
      <div className="flex min-w-0 items-start gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-4">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="text-sm font-semibold">{title}</span>
            <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <StatusDot tone={tone} />
              <span className="min-w-0 break-words">{status}</span>
            </span>
          </div>
          <p className="text-xs text-muted-foreground">{purpose}</p>
        </div>
        {actions && (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
            {actions}
          </div>
        )}
      </div>
      {children && <div className="grid gap-2 pl-11">{children}</div>}
    </div>
  );
}

/**
 * The browser extension's connection: linked, or the steps to link it. Opening the row checks who
 * the extension is signed in to (from a copy; no browser is quit) and links a known account.
 */
export function ExtensionRow({
  account: a,
  initialStatus,
}: {
  account: Account;
  /** For static rendering; otherwise read, and checked, on mount. */
  initialStatus?: ExtensionStatus;
}) {
  const { accounts } = useRelay();
  const { t, language } = useI18n();
  const { status, checking, check, link } = useExtensionStatus({
    check: true,
    initial: initialStatus,
  });
  if (status === null) return null;
  const guide = extensionGuide(a, status, accounts, t, language);
  return (
    <ConnectionRow
      icon={<AppWindow />}
      title={t("Tarayıcı eklentisi", "Browser extension")}
      purpose={
        guide.where
          ? t(
              `Tarayıcıdaki Claude eklentisi de bu hesaba geçer · ${guide.where}`,
              `The browser's Claude extension follows this account · ${guide.where}`,
            )
          : t(
              "Tarayıcıdaki Claude eklentisi de bu hesaba geçer.",
              "The browser's Claude extension follows this account.",
            )
      }
      tone={guide.tone}
      status={guide.label}
      actions={
        guide.action === "claim" ? (
          <>
            <Button
              size="sm"
              disabled={checking || !accountUuids(a).length}
              title={accountUuids(a).length ? undefined : t("Önce Claude uygulaması girişini kaydet.", "Save the Claude app sign-in first.")}
              onClick={() => void link(a.id)}
            >
              {checking ? <LoaderCircle className="animate-spin" /> : <Link2 />}
              {t("Bu hesap olarak bağla", "Link as this account")}
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t("Eklentiyi yeniden kontrol et", "Check the extension again")}
              title={t("Eklentiyi yeniden kontrol et", "Check the extension again")}
              disabled={checking}
              onClick={() => void check()}
            >
              <RefreshCw />
            </Button>
          </>
        ) : guide.action === "check" ? (
          <Button
            size="sm"
            variant={guide.steps ? "default" : "outline"}
            disabled={checking}
            onClick={() => void check()}
          >
            {checking ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
            {t("Kontrol et", "Check")}
          </Button>
        ) : guide.action === "settings" ? (
          <Button size="sm" variant="outline" asChild>
            <a href={routeHash("gecis")}>{t("Geçiş ayarları", "Switching settings")}</a>
          </Button>
        ) : guide.tone === "ok" ? (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("Eklentiyi yeniden kontrol et", "Check the extension again")}
            title={t("Eklentiyi yeniden kontrol et", "Check the extension again")}
            disabled={checking}
            onClick={() => void check()}
          >
            {checking ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
          </Button>
        ) : undefined
      }
    >
      {(guide.steps || guide.detail) && (
        <>
          {guide.steps && (
            <ol className="grid gap-1.5 rounded-lg bg-muted/60 px-3 py-2.5 text-sm">
              {guide.steps.map((step, i) => (
                <li key={i} className="flex gap-2">
                  <span className="grid size-5 shrink-0 place-items-center rounded-full bg-background text-xs font-semibold tabular-nums">
                    {i + 1}
                  </span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          )}
          {guide.detail && (
            <p className="text-xs text-muted-foreground">{guide.detail}</p>
          )}
        </>
      )}
    </ConnectionRow>
  );
}

/** The page's contents under its header; rendered apart so it can be tested statically. */
export function AccountDetailBody({
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
  const email = a.desktop?.email ?? a.auth?.email;
  const macOS = ["darwin", "preview"].includes(data?.diagnostics?.platform ?? "");
  const ready = [!!a.desktop, signIn.tone === "ok"].filter(Boolean).length;
  return (
    <div className="@container grid gap-3 px-6 pb-8">
      <RelayErrorAlert />
      {/* The header says the status; a problem also says what is wrong, here. */}
      {(health.tone === "warn" || health.tone === "crit") && (
        <div
          data-slot="account-status"
          className={cn(
            "flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border px-4 py-2.5 text-sm",
            health.tone === "crit" && "border-crit/40 bg-crit/5",
            health.tone === "warn" && "border-warn/40 bg-warn/5",
          )}
        >
          <span className="inline-flex items-center gap-2 font-semibold">
            <StatusDot tone={health.tone} />
            {health.label}
          </span>
          <span className="text-xs text-muted-foreground">{health.detail}</span>
        </div>
      )}
      {duplicate && (
        <p
          role="status"
          className="rounded-xl border border-warn/40 bg-warn/10 px-4 py-2.5 text-sm"
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
          className="rounded-xl border border-crit/40 bg-crit/10 px-4 py-2.5 text-sm"
        >
          {t(
            "Claude uygulaması girişi ile limit okuma girişi farklı hesaplara ait. Limit okuma girişini bu profilin hesabıyla yenile.",
            "The Claude app sign-in and the usage sign-in belong to different accounts. Renew the usage sign-in with this profile’s account.",
          )}
        </p>
      )}
      <div className="grid items-start gap-3 @3xl:grid-cols-[minmax(0,1fr)_280px]">
        <div className="grid gap-3">
          <Card className={cardClass}>
            <CardTitle
              title={t("Limitler", "Limits")}
              aside={
                freshUsage(usage, now ?? Date.now()) && usage?.checkedAt ? (
                  <span className="flex items-center gap-1">
                    {t("Güncellendi", "Updated")}{" "}
                    {formatRelative(usage.checkedAt, now ?? Date.now(), language)}
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={t("Limitleri yenile", "Refresh limits")}
                      disabled={usageBusy.has(a.id)}
                      onClick={() => void relay.refreshUsage(a)}
                    >
                      <RefreshCw className={usageBusy.has(a.id) ? "animate-spin" : undefined} />
                    </Button>
                  </span>
                ) : undefined
              }
            />
            {freshUsage(usage, now ?? Date.now()) ? (
              <LimitRings
                usage={usage}
                now={now ?? Date.now()}
                zone={settings.planning.timeZone}
                size={88}
              />
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
            />
            )}
          </Card>
          <Card className={cardClass} data-slot="connections">
            <CardTitle
              title={t("Bağlantılar", "Connections")}
              aside={t(
                `Claude uygulaması ve limitler: ${ready}/2 hazır`,
                `Claude app and limits: ${ready}/2 ready`,
              )}
            />
            <ConnectionRow
              icon={<Monitor />}
              title={t("Claude uygulaması", "Claude app")}
              purpose={t(
                "Relay, Claude uygulamasını bu hesapla açabilsin diye kaydedilir.",
                "Saved so Relay can open the Claude app with this account.",
              )}
              tone={a.desktop ? "ok" : "off"}
              status={
                a.desktop
                  ? t("Kayıtlı · geçişe hazır", "Saved · ready to switch")
                  : t("Kayıtlı değil · geçiş yapılamaz", "Not saved · cannot switch yet")
              }
              actions={
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
              title={t("Limit okuma", "Usage limits")}
              purpose={
                a.auth?.email
                  ? t(
                      `Limitleri okumak için tarayıcıda onaylanır · ${a.auth.email}`,
                      `Approved in the browser to read limits · ${a.auth.email}`,
                    )
                  : t(
                      "Limitleri okumak için tarayıcıda bir kez onaylanır.",
                      "Approved once in the browser to read limits.",
                    )
              }
              tone={signIn.tone}
              status={signIn.label}
              actions={
                <>
                  <Button
                    size="sm"
                    variant={a.auth?.email ? "outline" : "default"}
                    disabled={!!busy || waiting}
                    onClick={() => void relay.startCli(a)}
                  >
                    {waiting
                      ? t("Bağlanıyor…", "Connecting…")
                      : a.auth?.email
                        ? t("Yenile", "Renew")
                        : t("Giriş yap", "Sign in")}
                  </Button>
                  {a.auth?.email && (
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
                  )}
                </>
              }
            >
              {relay.flow?.accountId === a.id && <CliFlowPanel embedded />}
            </ConnectionRow>
            {/* The extension's sign-in is kept only on macOS; the browser preview shows the row too. */}
            {macOS && <ExtensionRow key={a.id} account={a} />}
          </Card>
          {a.desktop && (
            <Card className={cardClass}>
              <Disclosure title={t("Code geçmişi", "Code history")}>
                <HistorySummary
                  key={`${a.id}:${historyRevision}`}
                  account={a}
                  sources={historySources(a, accounts, settings)}
                  api={api}
                  t={t}
                />
              </Disclosure>
            </Card>
          )}
        </div>
        <div className="grid gap-3">
          <Card className={cardClass}>
            <CardTitle title={t("Hesap", "Account")} />
            <dl className="grid grid-cols-[80px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
              <dt className="text-muted-foreground">{t("E-posta", "Email")}</dt>
              <dd className="truncate" title={email}>
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
                  <dd className="capitalize">{a.auth.subscription}</dd>
                </>
              )}
            </dl>
          </Card>
          <Card className={cardClass}>
            <CardTitle title={t("Planlama", "Planning")} />
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
          </Card>
        </div>
      </div>
    </div>
  );
}
