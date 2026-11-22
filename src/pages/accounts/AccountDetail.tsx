import { AccountDot } from "@/components/AccountDot";
import { StatusLabel } from "@/components/StatusLabel";
import { relayProviders } from "@/features/Providers";
import { accountStatus } from "@/lib/account-status";
import { inUseIds } from "@/lib/provider-view";
import { MoreHorizontal } from "lucide-react";
import { BackIcon } from "@/components/icons";
import type { Account } from "../../../shared/types";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ProviderBadge } from "@/components/ProviderBadge";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { pendingFlow, windowAccounts } from "@/data/selectors";
import { PageFrame } from "@/app/PageFrame";
import { routeHash } from "@/app/routes";
import { accountHealth } from "@/lib/account-health";
import { offerAfter, usePrank } from "@/pranks/PrankStage";
import { RowActionItems, rowActions, WindowBadge } from "./AccountsTable";
import { accountPlan, planTitle } from "./accountLabels";
import { AccountDetailBody } from "./account-detail/Body";

/** `#/hesaplar/<id>`: an account's own page, in place of the list. */
export const accountHash = (id: string) =>
  `${routeHash("hesaplar")}/${encodeURIComponent(id)}`;
/** The account id in `#/hesaplar/<id>`, if any. */
export function accountFromHash(hash: string): string | undefined {
  const match = hash.match(/^#\/?hesaplar\/([^?/]+)/);
  if (!match) return undefined;
  // A hand-typed or truncated hash can hold a malformed escape; that is no account.
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
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
  const plan = accountPlan(a);
  const actions = rowActions(
    a,
    relay,
    t,
    language,
    (id) => {
      relay.setSetupId(id);
      relay.cancelDesktopRequest();
    },
    { remove, edit },
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
      platform: relay.data?.diagnostics?.platform,
      language,
    },
    t,
  );
  const inWindow = windowAccounts(relay.data).has(a.id);
  const now = Date.now();
  const status = accountStatus({ account: a, usage, health, inUse: inUseIds(relayProviders(relay, now)).has(a.id), now, t });
  // One primary action: the fix, else the switch (which the active account does not have), or
  // its window while it has one open.
  const primary = actions.find(
    (x) => x.key === (health.fix ?? (inWindow ? "window-show" : "switch")),
  );
  return (
    <PageFrame
      title={a.name}
      account={a.id}
      description={<StatusLabel status={status.reason ? { ...status, text: status.reason } : status} />}
      cliFlowInline={relay.flow?.accountId === a.id}
      leading={<AccountDot color={a.color} size="md" />}
      badge={
        <>
          {/* One chip: the provider's mark, its name and the plan. */}
          <ProviderBadge provider={a.provider} detail={plan?.label} title={plan ? planTitle(a, plan, t) : undefined} />
          {inWindow && <WindowBadge t={t} />}
        </>
      }
      back={
        <Button variant="ghost" size="sm" className="-ml-2 h-7 px-2 text-muted-foreground" onClick={back}>
          <BackIcon />
          {t("common.accounts")}
        </Button>
      }
      actions={
        <>
          {/* The page's one primary action; a switch to a full account is quieter and says why on hover. */}
          {primary && (
            <Button
              disabled={primary.disabled}
              variant={primary.tone === "warn" ? "outline" : "default"}
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
                aria-label={t("accountDetail.actions", { aName: a.name })}
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
