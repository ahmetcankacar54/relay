import { Fragment, useState } from "react";
import { AccountDot } from "@/components/AccountDot";
import { LimitLine } from "@/components/LimitLine";
import { ListCard, ListGroup, ListHead, ListNote, ListOpen, ListRow, ListSection, ListSkeleton, narrowHidden } from "@/components/ListCard";
import { PageSection } from "@/components/PageSection";
import { useI18n, type T } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { relayProviders } from "@/features/Providers";
import { AntigravityAction, AntigravityPrompt, AntigravitySteps, antigravityAccountState, type AntigravityAsk } from "@/features/AntigravityAccount";
import { inUseIds } from "@/lib/provider-view";
import { boardOrder, limitStanding } from "@/lib/limit-standing";
import { accountHash } from "../accounts/AccountDetail";
import { PROVIDER_ORDER } from "../accounts/accountGroups";
import { providerShortLabel } from "../accounts/accountLabels";
import { limitColumns, spentModelWindows, usedAt, limitHeadline, type ColumnWindow } from "../../../shared/quota-windows";
import { freshUsage } from "../../../shared/usage";
import type { Account, AccountUsage } from "../../../shared/types";

type Window = ColumnWindow;

/**
 * The fifth column: what the two columns leave out. A spent model ("Fable dolu"), else the fullest
 * model limit ("Fable %88"), else, for Antigravity, the other pool ("Claude & GPT %62").
 */
function otherLimit(usage: AccountUsage | undefined, shown: Window[], now: number, t: T): { text: string; full: boolean } | undefined {
  const spent = spentModelWindows(usage, now)[0];
  if (spent && !shown.some((w) => w.label === spent.label)) return { text: t(`${spent.label} dolu`, `${spent.label} full`), full: true };
  const used = (w: { usedPercent: number; resetsAt?: string }) => usedAt(w, now);
  const rest = (usage?.modelWindows ?? []).filter((w) => !shown.some((s) => s.label === w.label));
  const top = rest.sort((a, b) => used(b) - used(a))[0];
  if (!top) return undefined;
  const n = Math.round(used(top));
  return { text: `${top.label} ${t(`%${n}`, `${n}%`)}`, full: n >= 100 };
}

/**
 * Every account but the one open in the Claude app (the card above shows it), grouped by provider:
 * its five hours, its week and the limit those leave out, read at a glance and in one place. A row
 * opens the account; an Antigravity account moves the app from here as everywhere else.
 */
export function AccountsBoard({ now }: { now: number }) {
  const relay = useRelay();
  const { t } = useI18n();
  const [ask, setAsk] = useState<AntigravityAsk>();
  const usage = relay.data?.usage ?? {};
  const views = relayProviders(relay, now);
  const inUse = inUseIds(views);
  const listed = relay.accounts.filter((a) => a.id !== relay.active?.id);
  // Until the first snapshot the board holds placeholders, not the empty Overview.
  if (relay.data === undefined)
    return (
      <PageSection title={t("Tüm hesaplar", "All accounts")} slot="accounts-board">
        <ListCard label={t("Tüm hesaplar", "All accounts")}>
          <ListSkeleton />
        </ListCard>
      </PageSection>
    );
  if (!listed.length) return null;
  // The same count the Limits board used: a read account with room in its five hours and week.
  const usable = relay.accounts.filter((a) => {
    const kind = limitStanding(usage[a.id], now).kind;
    return kind === "open" || kind === "expiring";
  }).length;
  const app = relay.data?.antigravity;
  // Where Relay cannot move the Antigravity app (Windows, Linux) and the account it uses is nearly
  // spent: the steps to move it by hand to the roomiest other account, as the tray shows them.
  const ag = views.find((v) => v.id === "antigravity");
  const roomiest = (ag?.head?.usedPercent ?? 0) >= 90
    ? ag?.accounts
        .filter((a) => a.id !== ag.current?.id)
        .map((a) => ({ account: a, used: limitHeadline(usage[a.id], now)?.usedPercent ?? 100 }))
        .sort((x, y) => x.used - y.used)[0]
    : undefined;
  const handSteps =
    roomiest && roomiest.used < 90 && app?.installed && antigravityAccountState(app, roomiest.account.id) === "unavailable"
      ? roomiest.account
      : undefined;
  const promptOn = (id: string) =>
    ask ? ask.accountId === id : app?.busy ? app.signInFor === id : app?.result?.accountId === id;
  const groups = PROVIDER_ORDER.flatMap((provider) => {
    // Within a provider: a week ending soon with room first, full ones after, unread last.
    const own = boardOrder(listed.filter((a) => (a.provider ?? "claude") === provider), usage, now);
    return own.length ? [{ provider, own }] : [];
  });
  const line = (window: Window | undefined, name: string, pooled: boolean, faded: boolean) =>
    window ? (
      <LimitLine
        label={pooled ? window.label ?? "" : ""}
        ariaLabel={name}
        usedPercent={window.usedPercent}
        resetsAt={window.resetsAt}
        period={name === t("Hafta", "Week") ? "seven_day" : "five_hour"}
        now={now}
        t={t}
        faded={faded}
      />
    ) : (
      <span className="text-xs text-muted-foreground">—</span>
    );
  const row = (a: Account) => {
    const u = usage[a.id];
    const { five, week, pooled } = limitColumns(u, now);
    const faded = !!u && !freshUsage(u, now);
    const other = otherLimit(u, [five, week].filter((w): w is Window => !!w), now, t);
    return (
      <Fragment key={a.id}>
        <ListRow columns="board" onOpen={() => (window.location.hash = accountHash(a.id))} data={{ "data-account": a.id }}>
          <AccountDot color={a.color} />
          <div className="flex min-w-0 items-baseline gap-1.5">
            <ListOpen onOpen={() => (window.location.hash = accountHash(a.id))} title={a.name}>
              {a.name}
            </ListOpen>
            {inUse.has(a.id) && <span className="shrink-0 text-2xs text-muted-foreground">{t("açık", "in use")}</span>}
          </div>
          {line(five, t("5 saat", "5 hours"), pooled, faded)}
          {line(week, t("Hafta", "Week"), pooled, faded)}
          <span className={narrowHidden}>
            {other && (
              <span data-slot="other-limit" className="inline-flex max-w-full items-center rounded-sm bg-secondary px-1.5 py-0.5 text-2xs font-semibold">
                <span className={other.full ? "truncate text-crit" : "truncate"}>{other.text}</span>
              </span>
            )}
          </span>
          <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
            {a.provider === "antigravity" && <AntigravityAction account={a} onAsk={setAsk} />}
          </div>
        </ListRow>
        {a.provider === "antigravity" && promptOn(a.id) && (
          <ListNote>
            <AntigravityPrompt ask={ask} onClose={() => setAsk(undefined)} now={now} size="sm" />
          </ListNote>
        )}
      </Fragment>
    );
  };
  return (
    <PageSection
      title={t("Tüm hesaplar", "All accounts")}
      slot="accounts-board"
      aside={
        <span className="text-xs text-muted-foreground">
          {t(`${usable}/${relay.accounts.length} kullanılabilir`, `${usable}/${relay.accounts.length} usable`)}
        </span>
      }
    >
      <ListCard label={t("Tüm hesaplar", "All accounts")}>
        <ListHead columns="board">
          <span />
          <span>{t("Hesap", "Account")}</span>
          <span>{t("5 saat", "5 hours")}</span>
          <span>{t("Hafta", "Week")}</span>
          <span className={narrowHidden}>{t("Model limiti", "Model limit")}</span>
          <span />
        </ListHead>
        {groups.map(({ provider, own }) => (
          <Fragment key={provider}>
            <ListGroup provider={provider} name={providerShortLabel(provider)} count={own.length} />
            <ListSection id={`board-${provider}`} label={providerShortLabel(provider)}>
              {own.map(row)}
              {provider === "antigravity" && handSteps && (
                <ListNote className="py-2.5">
                  <AntigravitySteps target={handSteps} size="sm" />
                </ListNote>
              )}
            </ListSection>
          </Fragment>
        ))}
      </ListCard>
    </PageSection>
  );
}
