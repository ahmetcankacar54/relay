/** Every page id another window may name. */
export const PAGES = [
  "genel",
  "hesaplar",
  "proxy",
  "kullanim",
  "tokenlar",
  "rozetler",
  "planlama",
  "gecis",
  "ayarlar",
] as const;
export type PageId = (typeof PAGES)[number];
/** The pages in the sidebar, in order. Usage is three pages: limits, tokens and cost, pins. */
export const NAV_PAGES = [
  "genel",
  "hesaplar",
  "gecis",
  "planlama",
  "kullanim",
  "tokenlar",
  "rozetler",
  "proxy",
  "ayarlar",
] as const;
export type NavPage = (typeof NAV_PAGES)[number];
/**
 * Settings' tabs, in order: general, and one Advanced for everything technical or experimental.
 * Switching, Planning and the Proxy Gateway have their own pages.
 */
export const SETTINGS_TABS = ["genel", "gelismis"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];
/** Former Settings tabs that are pages now, so links from older builds and notices still land. */
const FORMER_TAB_PAGE: Record<string, NavPage> = {
  gecis: "gecis",
  otomasyon: "gecis",
  tasinanlar: "gecis",
  bildirimler: "gecis",
  planlama: "planlama",
};
/** Former Settings tabs folded into another tab. */
const FORMER_TAB: Record<string, SettingsTab> = { gorunum: "genel" };
/** A page, or one of Settings' tabs: `ayarlar/gelismis`. */
export type Destination = PageId | `ayarlar/${SettingsTab}`;

const parts = (hash: string) => hash.replace(/^#\/?/, "").split("?")[0].split("/");

/** The sidebar page a hash shows; a former Settings tab shows its own page. */
export function parseRoute(hash: string): NavPage {
  const [id, tab] = parts(hash);
  // The gateway was a Settings tab: `#/ayarlar/proxy` from older builds and notices lands on its page.
  if (id === "ayarlar" && tab === "proxy") return "proxy";
  if (id === "ayarlar" && FORMER_TAB_PAGE[tab]) return FORMER_TAB_PAGE[tab];
  return (NAV_PAGES as readonly string[]).includes(id) ? (id as NavPage) : "genel";
}
/** The Settings tab a hash opens: `#/ayarlar/<tab>`, a former tab's new tab, else the first. */
export function settingsTab(hash: string): SettingsTab {
  const tab = parts(hash)[1];
  if (FORMER_TAB[tab]) return FORMER_TAB[tab];
  return (SETTINGS_TABS as readonly string[]).includes(tab) ? (tab as SettingsTab) : SETTINGS_TABS[0];
}
export const routeHash = (page: Destination) => `#/${page}`;
/**
 * ⌘1–⌘8 open the sidebar's pages in order; ⌘, opens settings. None while a dialog or sheet is
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
/** The providers the add dialog can open on directly. */
export const ADD_PROVIDERS = ["claude", "codex", "antigravity"] as const;
export type AddProvider = (typeof ADD_PROVIDERS)[number];
/** `#/hesaplar?ekle=codex`: the add dialog, opened on that provider's own way in. */
export const addAccountHash = (provider?: AddProvider) =>
  provider ? `${intentHash("hesaplar", "ekle")}=${provider}` : intentHash("hesaplar", "ekle");
/** The intent and its value: `ekle=codex` → `["ekle", "codex"]`. */
export function parseIntent(query: string): [string, AddProvider | undefined] {
  const [intent, value] = query.split("=");
  return [intent, (ADD_PROVIDERS as readonly string[]).includes(value) ? (value as AddProvider) : undefined];
}
