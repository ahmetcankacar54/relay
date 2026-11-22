// Every catalog, for main, the CLI and tests (the renderer loads only the language in use).
import type { Locale } from "../locales";
import { registerCatalog, type Catalog } from "../translate";
import { en } from "./en";
import tr from "./tr";
import de from "./de";
import fr from "./fr";
import es from "./es";
import ptBR from "./pt-BR";
import it from "./it";
import ja from "./ja";
import ko from "./ko";
import zhHans from "./zh-Hans";
import zhHant from "./zh-Hant";
import ru from "./ru";
import uk from "./uk";
import pl from "./pl";
import nl from "./nl";

export const CATALOGS: Record<Locale, Catalog> = {
  en,
  tr,
  de,
  fr,
  es,
  "pt-BR": ptBR,
  it,
  ja,
  ko,
  "zh-Hans": zhHans,
  "zh-Hant": zhHant,
  ru,
  uk,
  pl,
  nl,
};
for (const [locale, catalog] of Object.entries(CATALOGS)) registerCatalog(locale as Locale, catalog);
