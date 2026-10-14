export const PAGES = [
  "genel",
  "hesaplar",
  "kullanim",
  "planlama",
  "gecis",
  "ayarlar",
] as const;
export type PageId = (typeof PAGES)[number];
export function parseRoute(hash: string): PageId {
  const id = hash.replace(/^#\/?/, "").split(/[?/]/)[0];
  return (PAGES as readonly string[]).includes(id) ? (id as PageId) : "genel";
}
export const routeHash = (page: PageId) => `#/${page}`;
/**
 * ⌘1–⌘5 open the pages in sidebar order; ⌘, opens settings. None while a dialog
 * or sheet is open, so a confirmation can’t be navigated away from.
 */
export function shortcutPage(
  e: { key: string; metaKey: boolean; ctrlKey: boolean },
  dialogOpen = false,
): PageId | undefined {
  if (dialogOpen || (!e.metaKey && !e.ctrlKey)) return;
  if (e.key === ",") return "ayarlar";
  const index = Number(e.key) - 1;
  return Number.isInteger(index) && index >= 0 && index < 5
    ? PAGES[index]
    : undefined;
}
/** The intent after the page id, e.g. `#/hesaplar?ekle` → `"ekle"`. */
export const routeQuery = (hash: string) => hash.split("?")[1] ?? "";
