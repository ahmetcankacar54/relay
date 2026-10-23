import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import {
  copySidebarRecipeAction,
  dismissSidebarGapAction,
  sidebarActionKeys,
  sidebarGapLine,
  sidebarRecipeHint,
} from "@/lib/sidebar-recipe";
import { panelCard, panelEyebrow } from "./PanelActiveCard";

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
  const running = sidebarActionKeys(gap.id).includes(relay.busy);
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
            {sidebarRecipeHint(gap, copiedId === gap.id, t)}
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
            {t("Talimatı kopyala", "Copy recipe")}
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
