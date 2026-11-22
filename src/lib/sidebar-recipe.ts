import type { T } from "@/data/i18n";
import type { Relay } from "@/data/relay-context";
import type { SidebarGapSummary } from "../../shared/types";

/**
 * The Code sidebar sections the account switched to lacks, shared by the menu bar panel and the
 * Switching page: the one-line summary, the line under it, and Copy recipe / Dismiss.
 */

/** What the account lacks, in one line: "Alto hesabında 9 bölüm eksik, 157 oturum bir bölümde değil". */
export function sidebarGapLine(gap: SidebarGapSummary, t: T): string {
  const { missingSections: sections, sessions } = gap;
  if (sections > 0 && sessions > 0) return t("sidebarRecipe.gapSectionsAndSessions", { gapTo: gap.to, sections, sessions });
  return sections > 0
    ? t("sidebarRecipe.gapSections", { gapTo: gap.to, sections })
    : t("sidebarRecipe.gapSessions", { gapTo: gap.to, sessions });
}

/** Where the sections come from and what the recipe does, or where to paste it once copied. */
export function sidebarRecipeHint(gap: SidebarGapSummary, copied: boolean, t: T): string {
  const from = gap.from.join(", ");
  return copied
    ? t("sidebarRecipe.copiedPasteItIntoACode", { gapTo: gap.to })
    : from
      ? t("sidebarRecipe.fromClaudeRebuildsTheSections", { from })
      : t("sidebarRecipe.claudeRebuildsTheSectionsFromThe");
}

/** The busy keys of an offer's two actions; either one running disables both buttons. */
export const sidebarActionKeys = (id: string) => [`sidebar-copy:${id}`, `sidebar-dismiss:${id}`];

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
