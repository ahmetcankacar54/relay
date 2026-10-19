import { z } from "zod";
import type { SidebarGapSummary } from "../../shared/types";
import { logDraft, shortId, type DraftLog } from "./draft-diagnostics";

/** The panel's view of the sidebar offer; none when it cannot be read. */
export function sidebarSummary(source: {
  sidebarGap(): Promise<SidebarGapSummary | undefined>;
}): Promise<SidebarGapSummary | undefined> {
  return source.sidebarGap().catch(() => undefined);
}

const GONE = "This sidebar offer is no longer there.";

/**
 * The panel's Copy recipe and Dismiss, by offer id. Copy writes the recipe to the clipboard
 * here, in main, and keeps the offer, so it can be copied again; Dismiss removes it. An offer
 * that is gone, or made for another account than Desktop's current one, rejects. Neither ever
 * resolves with anything, so the sessions never travel to a renderer. Either way the renderers
 * are told to read again.
 */
export function sidebarActions(deps: {
  gaps: {
    sidebarRecipe(id: string): Promise<string | undefined>;
    dismissSidebarGap(id: string): Promise<void>;
  };
  writeClipboard(text: string): void;
  changed(): void;
  /** A diagnosis log: the offer's id cut to 8 characters and how the action ended. */
  log?: DraftLog;
}) {
  const gapId = z.uuid();
  return {
    async copy(raw: unknown): Promise<void> {
      const id = gapId.parse(raw);
      try {
        const recipe = await deps.gaps.sidebarRecipe(id);
        if (recipe === undefined) throw new Error(GONE);
        deps.writeClipboard(recipe);
        logDraft(deps.log, "sidebar-copy", { id: shortId(id), ok: true });
      } catch (error) {
        logDraft(deps.log, "sidebar-copy", {
          id: shortId(id),
          ok: false,
          reason:
            error instanceof Error && error.message === GONE ? GONE : "failed",
        });
        throw error;
      } finally {
        deps.changed();
      }
    },
    async dismiss(raw: unknown): Promise<void> {
      const id = gapId.parse(raw);
      try {
        await deps.gaps.dismissSidebarGap(id);
        logDraft(deps.log, "sidebar-dismiss", { id: shortId(id), ok: true });
      } finally {
        deps.changed();
      }
    },
  };
}
