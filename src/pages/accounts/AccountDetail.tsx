import type { ReactNode } from "react";
import { AppWindow, Check, CircleAlert, Link2, Globe2, KeyRound, LoaderCircle, Monitor, MoreHorizontal, Network, SquareTerminal } from "lucide-react";
import { BackIcon, RefreshIcon } from "@/components/icons";
import type { Account, ExtensionStatus, RelaySettings } from "../../../shared/types";
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Disclosure } from "@/components/Disclosure";
import { StatusDot } from "@/components/StatusDot";
import { ProviderBadge } from "@/components/ProviderBadge";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { pendingFlow, windowAccounts } from "@/data/selectors";
import { useExtensionStatus } from "@/data/useExtension";
import { useTerminalStatus } from "@/data/useTerminal";
import { terminalGuide } from "@/lib/terminal-ui";
import type { TerminalStatus } from "../../../shared/terminal-identity";
import { CliFlowPanel } from "@/app/ConnectionPanels";
import { PageFrame } from "@/app/PageFrame";
import { RelayErrorAlert } from "@/app/RelayErrorAlert";
import { routeHash } from "@/app/routes";
import { accountHealth, isClaudeAccount, usageSignInStatus } from "@/lib/account-health";
import { accountUuids, extensionGuide } from "@/lib/extension-ui";
import { cn } from "@/lib/utils";
import { offerAfter, usePrank } from "@/pranks/PrankStage";
import { UsageCard } from "../../features/UsageCard";
import { LimitBars } from "@/components/LimitBars";
import { ringState } from "@/lib/account-row";
import { freshUsage } from "../../../shared/usage";
import { formatRelative } from "@/lib/time";
import { HistorySummary } from "../../features/HistorySummary";
import { DesktopSetup } from "../../features/DesktopSetup";
import { PlanEditor } from "../../features/PlanEditor";
import { RowActionItems, rowActions, WindowBadge } from "./AccountsTable";
import { avatarClass, groupName, planLabel, providerLabel } from "./accountLabels";

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
  remove,
  edit,
}: {
  account: Account;
  back: () => void;
  /** Asks to remove the account (the confirmation dialog). */
  remove?: (id: string) => void;
  /** Opens the account's name, type and group for editing. */
  edit?: (id: string) => void;
}) {
  const relay = useRelay();
  const prank = usePrank();
  const { t, language } = useI18n();
  const plan = planLabel(a);
  const email = a.desktop?.email ?? a.auth?.email;
  const actions = rowActions(
    a,
    relay,
    t,
    (id) => {
      relay.setSetupId(id);
      relay.cancelDesktopRequest();
    },
    { remove, edit, language },
  );
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
  const inWindow = windowAccounts(relay.data).has(a.id);
  // One primary action: the fix, else the switch (which the active account does not have), or
  // its window while it has one open.
  const primary = actions.find(
    (x) => x.key === (health.fix ?? (inWindow ? "window-show" : "switch")),
  );
  return (
    <PageFrame
      title={a.name}
      account={a.id}
      description={[email, a.auth?.orgName].filter(Boolean).join(" · ") || undefined}
      cliFlowInline={relay.flow?.accountId === a.id}
      leading={
        <span
          aria-hidden="true"
          className={cn(
            "grid size-8 shrink-0 place-items-center rounded-full text-sm font-semibold",
            avatarClass[a.color] ?? "bg-muted text-muted-foreground",
          )}
        >
          {a.name.slice(0, 1).toLocaleUpperCase(language)}
        </span>
      }
      badge={
        <>
          <ProviderBadge provider={a.provider} full />
          {plan && <Badge variant="secondary">{plan}</Badge>}
          {inWindow && <WindowBadge t={t} />}
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
          <BackIcon />
          {t("Hesaplar", "Accounts")}
        </Button>
      }
      actions={
        <>
          {/* A full account's switch is tinted, and says when the limit opens beside it. */}
          {primary?.tone === "warn" && primary.note && (
            <span
              data-slot="switch-note"
              className="max-w-56 self-center text-xs text-warn-foreground"
            >
              {primary.note}
            </span>
          )}
          {!isClaudeAccount(a) && (
            <Button variant="outline" asChild>
              <a href={routeHash("proxy")}>
                <Network />
                {t("Proxy & Gateway", "Proxy & Gateway")}
              </a>
            </Button>
          )}
          {primary && (
            <Button
              disabled={primary.disabled}
              variant={primary.tone === "warn" ? "outline" : "default"}
              className={cn(
                primary.tone === "warn" &&
                  "border-warn/40 bg-warn/10 text-warn-foreground hover:bg-warn/20 hover:text-warn-foreground dark:bg-warn/10 dark:hover:bg-warn/20",
              )}
              title={primary.note}
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
                variant="ghost"
                size="icon"
                aria-label={t(`${a.name} işlemleri`, `${a.name} actions`)}
              >
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <RowActionItems
                actions={actions.filter((x) => x !== primary)}
                prank={prank}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      }
    >
      <AccountDetailBody account={a} />
    </PageFrame>
  );
}

const cardClass = "gap-0 px-4 py-3.5";

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

function CardTitle({ title, aside }: { title: string; aside?: ReactNode }) {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-2">
      <h2 className="font-semibold">{title}</h2>
      {aside && <span className="text-xs text-muted-foreground">{aside}</span>}
    </div>
  );
}

/** A connection's leading mark: a check when it is ready, a mark when it needs a step, its kind when absent. */
const toneMark = {
  ok: "text-muted-foreground",
  warn: "text-warn-foreground",
  crit: "text-crit",
  off: "text-muted-foreground",
} as const;

/**
 * The connections as one grid: mark, text, a refresh column and an action column. Each row is a
 * subgrid, so every refresh button and every Renew button sits in the same column.
 */
function ConnectionList({ children }: { children: ReactNode }) {
  return (
    <div
      data-slot="connection-list"
      className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] gap-x-3"
    >
      {children}
    </div>
  );
}

/** A guide's numbered steps, shown while the connection is not linked. */
function Steps({ steps }: { steps: string[] }) {
  return (
    <ol className="grid gap-1.5 rounded-lg bg-muted/60 px-3 py-2.5 text-sm">
      {steps.map((step, i) => (
        <li key={i} className="flex gap-2">
          <span className="grid size-5 shrink-0 place-items-center rounded-full bg-background text-xs font-semibold tabular-nums">
            {i + 1}
          </span>
          <span>{step}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * A connection: what it is for in a few words, its state, a refresh button and its action, on one
 * row; its steps, a closed "how it works" note and a setup panel open under it.
 */
function ConnectionRow({
  icon,
  title,
  purpose,
  status,
  where,
  tone,
  refresh,
  action,
  steps,
  detail,
  optional,
  children,
}: {
  /** Not needed to switch: marked, and left out of the page's ready count. */
  optional?: boolean;
  icon: ReactNode;
  title: string;
  purpose: string;
  status: string;
  /** Where the connection lives (a browser profile), muted beside the status. */
  where?: string;
  tone: "ok" | "warn" | "crit" | "off";
  /** An icon button that reads the connection again; it sits just left of the action. */
  refresh?: ReactNode;
  /** The row's one text button (Renew, Sign in, Check…), at the right edge. */
  action?: ReactNode;
  steps?: string[];
  detail?: string;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div
      data-slot="connection"
      className="col-span-full grid grid-cols-subgrid gap-y-2 border-t py-3.5 last:pb-0"
    >
      <span
        aria-hidden="true"
        className={cn("mt-0.5 grid size-5 shrink-0 place-items-center [&_svg]:size-5", toneMark[tone])}
      >
        {tone === "ok" ? <Check /> : tone === "off" ? icon : <CircleAlert />}
      </span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-sm font-semibold">{title}</span>
          {optional && (
            <Badge variant="outline" className="text-muted-foreground">
              {t("İsteğe bağlı", "Optional")}
            </Badge>
          )}
          <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <StatusDot tone={tone} />
            <span className="min-w-0 break-words">{status}</span>
          </span>
          {where && (
            <span data-slot="connection-where" className="text-xs text-muted-foreground/70">
              {where}
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">{purpose}</p>
      </div>
      <div data-slot="connection-refresh" className="flex items-center self-center">
        {refresh}
      </div>
      <div data-slot="connection-action" className="flex items-center justify-end gap-1.5 self-center">
        {action}
      </div>
      {(steps || detail || children) && (
        <div className="col-span-3 col-start-2 grid gap-2">
          {steps && <Steps steps={steps} />}
          {detail && (
            <Disclosure title={t("Nasıl çalışır?", "How it works")}>
              <p className="text-xs text-muted-foreground">{detail}</p>
            </Disclosure>
          )}
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * The browser extension's connection: linked, or the steps to link it. Opening the row checks who
 * the extension is signed in to (from a copy; no browser is quit) and links a known account.
 */
export function ExtensionRow({
  account,
  initialStatus,
}: {
  account: Account;
  /** For static rendering; otherwise read, and checked, on mount. */
  initialStatus?: ExtensionStatus;
}) {
  const extension = useExtensionStatus({ check: true, initial: initialStatus });
  return <ExtensionConnection account={account} extension={extension} />;
}

/** The extension's row from a status the caller reads, so the page can count it among the connections. */
function ExtensionConnection({
  account: a,
  extension: { status, checking, check, link },
}: {
  account: Account;
  extension: ReturnType<typeof useExtensionStatus>;
}) {
  const { accounts } = useRelay();
  const { t, language } = useI18n();
  if (status === null) return null;
  const guide = extensionGuide(a, status, accounts, t, language);
  return (
    <ConnectionRow
      icon={<AppWindow />}
      title={t("Tarayıcı eklentisi", "Browser extension")}
      purpose={t("Bu hesaba o da geçer.", "Switches to this account too.")}
      optional
      tone={guide.tone}
      status={guide.label}
      where={guide.where}
      steps={guide.steps}
      detail={guide.detail}
      refresh={
        guide.action === "claim" || (!guide.action && guide.tone === "ok") ? (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("Eklentiyi yeniden kontrol et", "Check the extension again")}
            title={t("Eklentiyi yeniden kontrol et", "Check the extension again")}
            disabled={checking}
            onClick={() => void check()}
          >
            {checking && guide.action !== "claim" ? <LoaderCircle className="animate-spin" /> : <RefreshIcon />}
          </Button>
        ) : undefined
      }
      action={
        guide.action === "claim" ? (
          <Button
            size="sm"
            disabled={checking || !accountUuids(a).length}
            title={accountUuids(a).length ? undefined : t("Önce Claude uygulaması girişini kaydet.", "Save the Claude app sign-in first.")}
            onClick={() => void link(a.id)}
          >
            {checking ? <LoaderCircle className="animate-spin" /> : <Link2 />}
            {t("Bu hesap olarak bağla", "Link as this account")}
          </Button>
        ) : guide.action === "check" ? (
          <Button
            size="sm"
            variant={guide.steps ? "default" : "outline"}
            disabled={checking}
            onClick={() => void check()}
          >
            {checking ? <LoaderCircle className="animate-spin" /> : <RefreshIcon />}
            {t("Kontrol et", "Check")}
          </Button>
        ) : guide.action === "settings" ? (
          <Button size="sm" variant="outline" asChild>
            <a href={routeHash("gecis")}>{t("Ayarlar", "Settings")}</a>
          </Button>
        ) : undefined
      }
    />
  );
}

/** The terminal's Claude Code sign-in for this account: linked, or how to link it. macOS only. */
function TerminalConnection({
  account: a,
  terminal: { status, checking, check },
}: {
  account: Account;
  terminal: ReturnType<typeof useTerminalStatus>;
}) {
  const { t, language } = useI18n();
  if (status === null) return null;
  const guide = terminalGuide(a, status, t, language);
  return (
    <ConnectionRow
      icon={<SquareTerminal />}
      title={t("Terminal", "Terminal")}
      purpose={t("Bu hesaba o da geçer.", "Switches to this account too.")}
      optional
      tone={guide.tone}
      status={guide.label}
      steps={guide.steps}
      detail={guide.detail}
      refresh={
        !guide.action && guide.tone === "ok" ? (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("Terminali yeniden kontrol et", "Check the terminal again")}
            title={t("Terminali yeniden kontrol et", "Check the terminal again")}
            disabled={checking}
            onClick={() => void check()}
          >
            {checking ? <LoaderCircle className="animate-spin" /> : <RefreshIcon />}
          </Button>
        ) : undefined
      }
      action={
        guide.action === "check" ? (
          <Button size="sm" variant="outline" disabled={checking} onClick={() => void check()}>
            {checking ? <LoaderCircle className="animate-spin" /> : <RefreshIcon />}
            {t("Kontrol et", "Check")}
          </Button>
        ) : guide.action === "settings" ? (
          <Button size="sm" variant="outline" asChild>
            <a href={routeHash("gecis")}>{t("Ayarlar", "Settings")}</a>
          </Button>
        ) : undefined
      }
    />
  );
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
  const macOS = ["darwin", "preview"].includes(data?.diagnostics?.platform ?? "");
  const extension = useExtensionStatus({ check: macOS, initial: extensionStatus });
  const terminal = useTerminalStatus({ check: macOS, initial: terminalStatus });
  // Only what a switch needs counts: the Claude app sign-in and the usage sign-in. The extension
  // and the terminal are optional and say their own state on their rows.
  const claude = isClaudeAccount(a);
  const gateway = desktop?.proxyStatus;
  // The gateway lists every account; only one with a sign-in can take requests.
  const signedIn = a.auth?.loggedIn === true;
  const inPool = !!gateway?.running && signedIn;
  const connections = claude ? [!!a.desktop, signIn.tone === "ok"] : [signedIn, inPool];
  const ready = connections.filter(Boolean).length;
  const history = historySources(a, accounts, settings);
  return (
    <div className="@container grid gap-3 px-5 pb-6">
      <RelayErrorAlert />
      {/* The header says the status; a problem also says what is wrong, here. */}
      {(health.tone === "warn" || health.tone === "crit") && (
        <div
          data-slot="account-status"
          className={cn(
            "flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-4 py-2.5 text-sm",
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
          className="rounded-lg border border-warn/40 bg-warn/10 px-4 py-2.5 text-sm"
        >
          {t(
            `Bu hesap ${duplicate.name} profiline de bağlı. İki profil aynı limitleri paylaşır.`,
            `This account is also connected to ${duplicate.name}. Both profiles share the same limits.`,
          )}
        </p>
      )}
      {mismatch && (
        <p
          role="alert"
          className="rounded-lg border border-crit/40 bg-crit/10 px-4 py-2.5 text-sm"
        >
          {t(
            "Claude uygulaması girişi ile limit okuma girişi farklı hesaplara ait. Limit okuma girişini bu profilin hesabıyla yenile.",
            "The Claude app sign-in and the usage sign-in are for different accounts. Renew the usage sign-in with this profile’s account.",
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
                ) : undefined
              }
            />
            {freshUsage(usage, now ?? Date.now()) ? (
              <div className="mt-2">
                <LimitBars
                  usage={usage}
                  now={now ?? Date.now()}
                  zone={settings.planning.timeZone}
                  state={ringState(usage, now ?? Date.now())}
                />
              </div>
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
              connectElsewhere
            />
            )}
          </Card>
          <Card className={cardClass} data-slot="connections">
            <CardTitle
              title={t("Bağlantılar", "Connections")}
              aside={t(
                `${ready} / ${connections.length} hazır`,
                `${ready} / ${connections.length} ready`,
              )}
            />
            <ConnectionList>
            {!claude && (
              <>
                <ConnectionRow
                  icon={<KeyRound />}
                  title={t("Giriş", "Sign-in")}
                  purpose={t(
                    `Ağ geçidinin ${providerLabel(a.provider)} isteklerinde kullandığı anahtar ya da oturum.`,
                    `The key or session the gateway uses for ${providerLabel(a.provider)} requests.`,
                  )}
                  tone={signedIn ? "ok" : "warn"}
                  status={
                    signedIn
                      ? t(`Kayıtlı${a.auth?.email ? ` · ${a.auth.email}` : ""}`, `Saved${a.auth?.email ? ` · ${a.auth.email}` : ""}`)
                      : t("Giriş yok: hesabı yeniden ekle", "Not signed in: add the account again")
                  }
                />
                <ConnectionRow
                  icon={<Network />}
                  title={t("Proxy Gateway", "Proxy Gateway")}
                  purpose={t(
                    "İstekleri bu hesaba da dağıtan yerel ağ geçidi.",
                    "The local gateway that spreads requests over this account too.",
                  )}
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
              tone={a.desktop ? "ok" : "off"}
              status={
                a.desktop
                  ? t("Kayıtlı", "Saved")
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
                  variant={a.auth?.email ? "outline" : "default"}
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
            </ConnectionRow>
            {/* The extension's sign-in is kept only on macOS; the browser preview shows the row too. */}
            {macOS && <ExtensionConnection account={a} extension={extension} />}
            {macOS && <TerminalConnection account={a} terminal={terminal} />}
            </>
            )}
            </ConnectionList>
          </Card>
          {a.desktop && (
            <Card className={cardClass}>
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
        </div>
        <div className="grid gap-3">
          <Card className={cardClass}>
            <CardTitle title={t("Hesap", "Account")} />
            <dl className="-mx-1 grid text-sm">
              {[
                [t("Sağlayıcı", "Provider"), providerLabel(a.provider)],
                [t("E-posta", "Email"), a.desktop?.email ?? a.auth?.email ?? "—"],
                [t("Kuruluş", "Organization"), a.auth?.orgName ?? "—"],
                [
                  t("Tür · grup", "Type · group"),
                  (a.kind === "personal" ? t("Kişisel", "Personal") : t("Şirket", "Work")) +
                    (a.kind === "work" ? ` · ${groupName(a, t)}` : ""),
                ],
                ...(a.auth?.subscription
                  ? [[t("Abonelik", "Subscription"), a.auth.subscription.replace(/^\w/, (c) => c.toUpperCase())]]
                  : []),
              ].map(([label, value]) => (
                <div key={label} className="flex min-w-0 items-baseline justify-between gap-3 border-t px-1 py-2 first:border-0">
                  <dt className="shrink-0 text-muted-foreground">{label}</dt>
                  <dd className="min-w-0 truncate text-right" title={value}>
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          </Card>
          {claude && (
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
          )}
        </div>
      </div>
    </div>
  );
}
