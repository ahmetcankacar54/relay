import { IntlMessageFormat } from "intl-messageformat";
import { en, type Catalog, type MessageId } from "./catalogs/en";
import { FORMAT_LOCALE, type Locale } from "./locales";

export type { Catalog, MessageId };
/** Values for a message's `{placeholders}`. */
export type Params = Record<string, string | number | Date | undefined>;
/** Relay's translator: a message id and its values, in one language. */
export type T = (id: MessageId, params?: Params) => string;

const catalogs = new Map<Locale, Catalog>([["en", en]]);
const formats = new Map<string, IntlMessageFormat>();
let pseudo = false;

/** Makes a loaded catalog available to `tFor`. */
export function registerCatalog(locale: Locale, catalog: Catalog) {
  catalogs.set(locale, catalog);
  for (const key of formats.keys()) if (key.startsWith(`${locale}\u0000`)) formats.delete(key);
}

/** Development only (the browser preview's `?pseudo=1`): every message longer and accented, to find cut-off text. */
export function setPseudo(enabled: boolean) {
  pseudo = enabled;
}

const ACCENTS: Record<string, string> = { a: "á", e: "é", i: "í", o: "ö", u: "ü", A: "Å", E: "É", I: "Í", O: "Ö", U: "Ü" };
const pseudoOf = (text: string) => `⟦${text.replace(/[aeiouAEIOU]/g, (c) => ACCENTS[c])}${"·".repeat(Math.ceil(text.length * 0.4))}⟧`;

function format(locale: Locale, id: MessageId, rich: boolean): IntlMessageFormat {
  const key = `${locale}\u0000${id}\u0000${rich}`;
  let message = formats.get(key);
  if (!message) {
    const source = catalogs.get(locale)?.[id] ?? en[id] ?? id;
    try {
      message = new IntlMessageFormat(source, FORMAT_LOCALE[locale], undefined, { ignoreTag: !rich });
    } catch {
      // A broken translation must never break a screen: the English message stands in.
      message = new IntlMessageFormat(en[id] ?? id, FORMAT_LOCALE.en, undefined, { ignoreTag: !rich });
    }
    formats.set(key, message);
  }
  return message;
}

const clean = (params: Params | undefined) => {
  if (!params) return undefined;
  const out: Record<string, string | number | Date> = {};
  for (const [k, v] of Object.entries(params)) out[k] = v ?? "";
  return out;
};

/** The translator for `locale`; ids missing from its catalog read in English. */
export function tFor(locale: Locale): T {
  return (id, params) => {
    let text: string;
    try {
      text = String(format(locale, id, false).format(clean(params)));
    } catch {
      text = String(format("en", id, false).format(clean(params)));
    }
    return pseudo ? pseudoOf(text) : text;
  };
}

/** A message whose `<tag>…</tag>` parts are rendered by `values[tag]` (React's `<Trans>`); English when the translation fails. */
export function formatRich(locale: Locale, id: MessageId, values: Record<string, unknown>): unknown[] {
  let out: unknown;
  try {
    out = format(locale, id, true).format(values as never);
  } catch {
    out = format("en", id, true).format(values as never);
  }
  return Array.isArray(out) ? out : [out];
}

const LOADERS: Record<Exclude<Locale, "en">, () => Promise<{ default: Catalog }>> = {
  tr: () => import("./catalogs/tr"),
  de: () => import("./catalogs/de"),
  fr: () => import("./catalogs/fr"),
  es: () => import("./catalogs/es"),
  "pt-BR": () => import("./catalogs/pt-BR"),
  it: () => import("./catalogs/it"),
  ja: () => import("./catalogs/ja"),
  ko: () => import("./catalogs/ko"),
  "zh-Hans": () => import("./catalogs/zh-Hans"),
  "zh-Hant": () => import("./catalogs/zh-Hant"),
  ru: () => import("./catalogs/ru"),
  uk: () => import("./catalogs/uk"),
  pl: () => import("./catalogs/pl"),
  nl: () => import("./catalogs/nl"),
};

/** Loads and registers `locale`'s catalog (the renderer loads only the language in use). */
export async function loadCatalog(locale: Locale) {
  if (catalogs.has(locale)) return;
  if (locale === "en") return;
  registerCatalog(locale, (await LOADERS[locale]()).default);
}
