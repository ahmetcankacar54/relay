/**
 * Every page id another window may name. "gecis" and "planlama" were pages of their own and now
 * open their tabs in Settings, so the menu bar panel, links and old hashes keep working.
 */
export const PAGES = [
  "genel",
  "hesaplar",
  "kullanim",
  "tokenlar",
  "rozetler",
  "planlama",
  "gecis",
  "ayarlar",
] as const;
export type PageId = (typeof PAGES)[number];
/** The pages in the sidebar, in order. Usage is three pages: limits, tokens and cost, pins. */
export const NAV_PAGES = ["genel", "hesaplar", "kullanim", "tokenlar", "rozetler", "ayarlar"] as const;
export type NavPage = (typeof NAV_PAGES)[number];
/**
 * Settings' tabs, in order: switching (when, what switches along, near the limit), planning,
 * the Proxy Gateway, general, and one Advanced for everything technical or experimental.
 */
export const SETTINGS_TABS = ["gecis", "planlama", "proxy", "genel", "gelismis"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];
/** Former tabs, so links from older builds, notices and the panel still land on the right one. */
const FORMER_TAB: Record<string, SettingsTab> = {
  otomasyon: "gecis",
  tasinanlar: "gecis",
  bildirimler: "gecis",
  gorunum: "genel",
};
/** A page, or one of Settings' tabs: `ayarlar/gecis`. */
export type Destination = PageId | `ayarlar/${SettingsTab}`;
/** The tab each former page opens. */
const PAGE_TAB: Partial<Record<PageId, SettingsTab>> = {
  gecis: "gecis",
  planlama: "planlama",
};

const parts = (hash: string) => hash.replace(/^#\/?/, "").split("?")[0].split("/");

/** The sidebar page a hash shows; the former pages show Settings. */
export function parseRoute(hash: string): NavPage {
  const id = parts(hash)[0];
  if (id === "gecis" || id === "planlama") return "ayarlar";
  return (NAV_PAGES as readonly string[]).includes(id) ? (id as NavPage) : "genel";
}
/** The Settings tab a hash opens: `#/ayarlar/<tab>`, a former page's or tab's new tab, else the first. */
export function settingsTab(hash: string): SettingsTab {
  const [id, tab] = parts(hash);
  if (PAGE_TAB[id as PageId]) return PAGE_TAB[id as PageId]!;
  if (FORMER_TAB[tab]) return FORMER_TAB[tab];
  return (SETTINGS_TABS as readonly string[]).includes(tab) ? (tab as SettingsTab) : SETTINGS_TABS[0];
}
export const routeHash = (page: Destination) => `#/${page}`;
/**
 * ⌘1–⌘5 open the sidebar's pages in order; ⌘, opens settings. None while a dialog or sheet is
 * open, so a confirmation can’t be navigated away from.
 */
export function shortcutPage(
  e: { key: string; metaKey: boolean; ctrlKey: boolean },
  dialogOpen = false,
): NavPage | undefined {
  if (dialogOpen || (!e.metaKey && !e.ctrlKey)) return;
  if (e.key === ",") return "ayarlar";
  const index = Number(e.key) - 1;
  return Number.isInteger(index) && index >= 0 && index < NAV_PAGES.length - 1
    ? NAV_PAGES[index]
    : undefined;
}
/** The intent after the page id, e.g. `#/hesaplar?ekle` → `"ekle"`. */
export const routeQuery = (hash: string) => hash.split("?")[1] ?? "";
/** Intents another window may ask the main window for: `ekle` opens the add-account dialog. */
export const PAGE_INTENTS = ["ekle"] as const;
export type PageIntent = (typeof PAGE_INTENTS)[number];
/** `#/hesaplar?ekle`: the page and, when given, the intent its page acts on. */
export const intentHash = (page: Destination, intent?: PageIntent) =>
  intent ? `${routeHash(page)}?${intent}` : routeHash(page);
