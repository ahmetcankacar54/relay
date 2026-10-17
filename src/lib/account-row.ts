import type { Language, T } from "@/data/i18n";
import type { Relay } from "@/data/relay-context";
import type { OverviewRow } from "@/data/selectors";
import { formatClock, formatReset } from "@/lib/time";

/** Status line under an account name (Overview and the menu bar panel). */
export function accountRowSubtitle(
  row: OverviewRow,
  t: T,
  language: Language,
  zone: string,
  now: number,
): string {
  switch (row.state) {
    case "window-open": {
      const reset = row.usage?.fiveHour?.resetsAt;
      const left = reset ? formatReset(reset, now, language, zone) : "";
      return t(
        `Dönem açık${left ? ` · ${left}` : ""}`,
        `Period open${left ? ` · ${left}` : ""}`,
      );
    }
    case "ready":
      return t("Hazır · dönem başlamadı", "Ready · no period started");
    case "exhausted": {
      const at = row.availableAt
        ? formatClock(row.availableAt, language, zone)
        : "—";
      return t(`Açılış ${at}`, `Opens ${at}`);
    }
    case "not-linked":
      return t("Desktop’a bağlı değil", "Not linked to Desktop");
    default:
      return t("Limit verisi eski", "Usage data is out of date");
  }
}

export type PanelRowBlock =
  | "not-linked"
  | "exhausted"
  | "busy"
  | "pending"
  | "recovery";

/** Whether the panel’s “Geç” button may switch Desktop to this row’s account. */
export function panelRowState(
  row: OverviewRow,
  relay: Pick<Relay, "desktopBusy" | "pendingDesktop" | "desktop">,
): { canSwitch: boolean; reason?: PanelRowBlock } {
  const blocked = (reason: PanelRowBlock) => ({ canSwitch: false, reason });
  if (row.state === "not-linked") return blocked("not-linked");
  if (row.state === "exhausted") return blocked("exhausted");
  if (relay.desktopBusy) return blocked("busy");
  if (relay.pendingDesktop) return blocked("pending");
  if (relay.desktop?.recoveryRequired) return blocked("recovery");
  return { canSwitch: true };
}
