import type { T } from "@/data/i18n";
import type { Relay } from "@/data/relay-context";
import type { SidebarGapSummary } from "../../shared/types";

/**
 * The Code sidebar sections the account switched to lacks, shared by the menu bar panel and the
 * Switching page: the one-line summary, the line under it, and Copy recipe / Dismiss.
 */

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

/** Where the sections come from and what the recipe does, or where to paste it once copied. */
export function sidebarRecipeHint(gap: SidebarGapSummary, copied: boolean, t: T): string {
  const from = gap.from.join(", ");
  return copied
    ? t(
        `Kopyalandı. ${gap.to} hesabında bir Code oturumuna yapıştır; Claude bölümleri kurar ve her taşımayı sorar.`,
        `Copied. Paste it into a Code session on ${gap.to}; Claude rebuilds the sections and asks before each move.`,
      )
    : t(
        `${from ? `Kaynak: ${from}. ` : ""}Tarifi bir Code oturumuna yapıştırınca Claude bölümleri kurar.`,
        `${from ? `From ${from}. ` : ""}Paste the recipe into a Code session and Claude rebuilds the sections.`,
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
