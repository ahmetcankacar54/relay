import type { T } from "@/data/i18n";
import type { Relay } from "@/data/relay-context";
import type { SidebarGapSummary } from "../../shared/types";

/**
 * The Code sidebar sections the account switched to lacks, shared by the menu bar panel and the
 * Switching page: the one-line summary, the line under it, and Copy recipe / Dismiss.
 */

/** What the account lacks, in one line: "Alto hesabında 9 bölüm eksik, 157 oturum bir bölümde değil". */
export function sidebarGapLine(gap: SidebarGapSummary, t: T): string {
  const { missingSections: n, sessions: m } = gap;
  const tr = [
    ...(n > 0 ? [`${n} bölüm eksik`] : []),
    ...(m > 0 ? [`${m} oturum bir bölümde değil`] : []),
  ].join(", ");
  const en = [
    ...(n > 0 ? [`${n} ${n === 1 ? "section" : "sections"} missing`] : []),
    ...(m > 0 ? [`${m} ${m === 1 ? "session" : "sessions"} unfiled`] : []),
  ].join(", ");
  return t(`${gap.to} hesabında ${tr}`, `On ${gap.to}: ${en}`);
}

/** Where the sections come from and what the recipe does, or where to paste it once copied. */
export function sidebarRecipeHint(gap: SidebarGapSummary, copied: boolean, t: T): string {
  const from = gap.from.join(", ");
  return copied
    ? t(
        `Kopyalandı. ${gap.to} hesabında bir Code oturumuna yapıştır. Claude her taşımadan önce sorar.`,
        `Copied. Paste it into a Code session on ${gap.to}. Claude asks before each move.`,
      )
    : t(
        `${from ? `Kaynak: ${from}. ` : ""}Claude bölümleri bir Code oturumunda talimatla kurar.`,
        `${from ? `From ${from}. ` : ""}Claude rebuilds the sections from the recipe in a Code session.`,
      );
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
