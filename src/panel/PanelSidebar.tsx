import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useI18n, type T } from "@/data/i18n";
import { useRelay, type Relay } from "@/data/relay-context";
import type { SidebarGapSummary } from "../../shared/types";
import { panelCard, panelEyebrow } from "./PanelActiveCard";

/** What the account lacks, in one line: "Alto hesabında 9 bölüm eksik, 157 oturum bölümsüz". */
export function sidebarGapLine(gap: SidebarGapSummary, t: T): string {
  const { missingSections: n, sessions: m } = gap;
  const tr = [
    ...(n > 0 ? [`${n} bölüm eksik`] : []),
    ...(m > 0 ? [`${m} oturum bölümsüz`] : []),
  ].join(", ");
  const en = [
    ...(n > 0 ? [`${n} ${n === 1 ? "section" : "sections"} missing`] : []),
    ...(m > 0 ? [`${m} ${m === 1 ? "session" : "sessions"} unfiled`] : []),
  ].join(", ");
  return t(`${gap.to} hesabında ${tr}`, `On ${gap.to}: ${en}`);
}

export const copySidebarRecipeAction = (
  relay: Relay,
  id: string,
  copied: () => void,
) =>
  relay.action(`sidebar-copy:${id}`, async () => {
    await relay.api.copySidebarRecipe(id);
    copied();
  });

export const dismissSidebarGapAction = (relay: Relay, id: string) =>
  relay.action(`sidebar-dismiss:${id}`, () => relay.api.dismissSidebarGap(id));

/**
 * The Code sidebar sections the account switched to lacks, from the accounts it came from, with
 * Copy recipe and Dismiss. The recipe is pasted into a Code session, where Claude rebuilds the
 * sections with Desktop's own tools. Counts and account names only: the sessions stay in main.
 */
export function PanelSidebar() {
  const relay = useRelay();
  const { t } = useI18n();
  const [copiedId, setCopiedId] = useState<string>();
  const gap = relay.data?.sidebar;
  if (!gap) return null;
  const running = [
    `sidebar-copy:${gap.id}`,
    `sidebar-dismiss:${gap.id}`,
  ].includes(relay.busy);
  const from = gap.from.join(", ");
  return (
    <section className="px-3 py-1.5">
      <div className={panelEyebrow}>
        {t("Kenar çubuğu düzeni", "Sidebar layout")}
      </div>
      <div
        className={`${panelCard} grid grid-cols-[1fr_auto] items-center gap-2 px-2 py-1.5`}
      >
        <div className="min-w-0">
          <div className="min-w-0 font-semibold">{sidebarGapLine(gap, t)}</div>
          <div className="min-w-0 text-xs text-muted-foreground">
            {copiedId === gap.id
              ? t(
                  `Kopyalandı. ${gap.to} hesabında bir Code oturumuna yapıştır; Claude bölümleri kurar ve her taşımayı sorar.`,
                  `Copied. Paste it into a Code session on ${gap.to}; Claude rebuilds the sections and asks before each move.`,
                )
              : t(
                  `${from ? `Kaynak: ${from}. ` : ""}Tarifi bir Code oturumuna yapıştırınca Claude bölümleri kurar.`,
                  `${from ? `From ${from}. ` : ""}Paste the recipe into a Code session and Claude rebuilds the sections.`,
                )}
          </div>
        </div>
        <span className="flex shrink-0 gap-1">
          <Button
            size="xs"
            variant="outline"
            disabled={running}
            onClick={() =>
              void copySidebarRecipeAction(relay, gap.id, () =>
                setCopiedId(gap.id),
              )
            }
          >
            {t("Tarifi kopyala", "Copy recipe")}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={running}
            onClick={() => void dismissSidebarGapAction(relay, gap.id)}
          >
            {t("Kapat", "Dismiss")}
          </Button>
        </span>
      </div>
    </section>
  );
}
