import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { RefreshCw, Settings2 } from "lucide-react";
import { maxUsedPercent } from "../../shared/usage";
import { Button } from "@/components/ui/button";
import { Panda } from "@/components/Panda";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { panelRowState } from "@/lib/account-row";
import { formatLeft } from "@/lib/meter";
import { formatRelative } from "@/lib/time";
import { RelayErrorAlert } from "@/app/RelayErrorAlert";
import { offerAfter, usePrank } from "@/pranks/PrankStage";
import { PanelActiveCard } from "./PanelActiveCard";
import { PanelAccounts, panelRows, switchingId } from "./PanelAccounts";
import { PanelAutomation } from "./PanelAutomation";
import { PanelDrafts } from "./PanelDrafts";
import { panelHead } from "./panel-head";

/** The menu bar popover: active account, other accounts, automation. */
export function Panel({
  now = Date.now(),
}: {
  /** Injected by tests; the panel re-renders with the snapshot poll. */
  now?: number;
}) {
  const relay = useRelay();
  const prank = usePrank();
  const { t, language } = useI18n();
  const { api, accounts, suggestion, usageBusy } = relay;
  const [confirmId, setConfirmId] = useState<string>();
  const root = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const report = () => api.setPanelHeight(el.scrollHeight);
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, [api]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") api.closePanel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [api]);

  const usage = relay.data?.usage ?? {};
  const latest = Object.values(usage)
    .map((u) => u.checkedAt)
    .filter((c): c is string => !!c && Number.isFinite(Date.parse(c)))
    .sort()
    .at(-1);
  const suggestedRow =
    suggestion &&
    panelRows(relay, now).find((r) => r.account.id === suggestion.id);
  const suggestionCanSwitch =
    !!suggestedRow &&
    panelRowState(suggestedRow, relay).canSwitch &&
    !switchingId(relay.busy);
  const refreshing = usageBusy.size > 0;

  return (
    <div
      ref={root}
      className="w-[360px] bg-background/90 text-[12.5px] leading-snug text-foreground"
    >
      <header className="flex items-center justify-between px-3 pt-2.5 pb-1.5">
        <span className="flex items-center gap-2 font-bold">
          <Panda scene={panelHead(relay.data, relay.desktop, now)} size={18} />
          Relay
        </span>
        <span className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t("Limitleri yenile", "Refresh limits")}
            disabled={refreshing || !accounts.length}
            onClick={(e) =>
              offerAfter(prank, "wheel", e, () => {
                for (const a of accounts) void relay.refreshUsage(a);
              })
            }
          >
            <RefreshCw className={refreshing ? "animate-spin" : undefined} />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t("Relay’i aç", "Open Relay")}
            onClick={() => void api.openPage("genel")}
          >
            <Settings2 />
          </Button>
        </span>
      </header>
      <div className="px-3 empty:hidden">
        <RelayErrorAlert />
      </div>
      <PanelActiveCard now={now} />
      {suggestion && relay.active && (
        <div className="mx-3 my-1.5 flex items-center justify-between gap-2 rounded-lg border border-warn/40 bg-warn/10 px-2.5 py-1.5 text-[11.5px]">
          <span className="min-w-0">
            {t("Limit dolmak üzere", "Limit almost reached")} ·{" "}
            {t("Önerilen", "Suggested")}: <b>{suggestion.name}</b>
            {` (${formatLeft(maxUsedPercent(usage[suggestion.id]), language)})`}
          </span>
          <Button
            size="xs"
            disabled={!suggestionCanSwitch}
            onClick={(e) => {
              // Opening the confirmation is the switch request and offers; with it already open there is nothing to request.
              if (confirmId !== suggestion.id)
                offerAfter(prank, "nibble-cursor", e, () =>
                  setConfirmId(suggestion.id),
                );
            }}
          >
            {t("Geç", "Switch")}
          </Button>
        </div>
      )}
      <PanelDrafts />
      <PanelAccounts
        now={now}
        confirmId={confirmId}
        onConfirmChange={setConfirmId}
      />
      <PanelAutomation now={now} />
      <footer className="mt-1.5 flex items-center justify-between gap-2 border-t px-3 pt-1.5 pb-2 text-muted-foreground">
        <Button
          variant="link"
          size="sm"
          className="h-auto px-0 text-[12px] font-semibold text-foreground"
          onClick={() => void api.openPage("genel")}
        >
          {t("Relay’i aç", "Open Relay")}
        </Button>
        {latest && (
          <span className="truncate text-[11.5px]">
            {`${t("Güncellendi", "Updated")} ${formatRelative(latest, now, language)}`}
          </span>
        )}
        <Button
          variant="link"
          size="sm"
          className="h-auto px-0 text-[12px] text-muted-foreground"
          onClick={() => void api.quit()}
        >
          {t("Çık", "Quit")}
        </Button>
      </footer>
    </div>
  );
}
