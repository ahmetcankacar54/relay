import type { ReactNode } from "react";
import { Globe2, Monitor, RefreshCw } from "lucide-react";
import type { Account } from "../../../shared/types";
import {
  cliNeedsReconnect,
  desktopCliMismatch,
  duplicateCliAccount,
} from "../../../shared/account-state";
import { historySources } from "../../../shared/history-policy";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { StatusDot } from "@/components/StatusDot";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { pendingFlow } from "@/data/selectors";
import { CliFlowPanel } from "@/app/ConnectionPanels";
import { RelayErrorAlert } from "@/app/Banners";
import { UsageCard } from "../../features/UsageCard";
import { HistorySummary } from "../../features/HistorySummary";
import { DesktopSetup } from "../../features/DesktopSetup";
import { PlanEditor } from "../../features/PlanEditor";
import { groupName, planLabel } from "./accountLabels";

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
      <h3 className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
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
}: {
  icon: ReactNode;
  title: string;
  status: string;
  tone: "ok" | "warn" | "crit" | "off";
  actions: ReactNode;
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
    </div>
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
  const reconnect = cliNeedsReconnect(a, usage);
  const mismatch = desktopCliMismatch(a);
  const duplicate = duplicateCliAccount(a, accounts);
  return (
    <div className="grid gap-5 px-4 pb-6">
      {/* The page banners sit under the sheet; failures of its actions show here. */}
      <RelayErrorAlert />
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
      <Section title={t("Bağlantılar", "Connections")}>
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
              " · Claude’u bu hesapla açmak için kaydedilir.",
              " · Saved to open Claude with this account.",
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
          tone={waiting ? "warn" : reconnect ? "crit" : "ok"}
          status={
            (waiting
              ? t("Tarayıcı onayı bekleniyor", "Waiting for browser approval")
              : reconnect
                ? t("Giriş yenilenmeli", "Sign-in needs renewal")
                : t("Bağlı", "Connected")) +
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
                  "CLI bağlantısını doğrula",
                  "Verify CLI connection",
                )}
                title={t("Bağlantıyı kontrol et", "Check connection")}
                disabled={!!busy || waiting}
                onClick={() =>
                  void action(`verify:${a.id}`, async () => {
                    const checked = await api.checkAuth(a.id);
                    setNotice(
                      checked.auth?.loggedIn
                        ? t(
                            `${a.name} · ${checked.auth.email ?? ""} bağlantısı doğrulandı.`,
                            `${a.name} · ${checked.auth.email ?? ""} connection verified.`,
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
      {a.desktop && (
        <Section title={t("Code geçmişi", "Code history")}>
          <HistorySummary
            key={`${a.id}:${historyRevision}`}
            account={a}
            sources={historySources(a, accounts, settings)}
            api={api}
            t={t}
          />
        </Section>
      )}
    </div>
  );
}
