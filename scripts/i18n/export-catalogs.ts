// Writes crates/relay-i18n/catalogs/<locale>.json from shared/i18n/catalogs (sorted keys, 2-space
// JSON) for the Rust crate to embed, and crates/relay-i18n/tests/golden/formatted.json: every
// message in every language formatted by the real shared/i18n/translate.ts, which the Rust
// formatter must reproduce byte for byte.
// Run: node --import tsx scripts/i18n/export-catalogs.ts [--check]
// --check compares the catalogs only: the golden depends on the Node build's ICU data.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { IntlMessageFormat } from "intl-messageformat";
import { CATALOGS } from "../../shared/i18n/catalogs/all";
import { FORMAT_LOCALE, LOCALES, type Locale } from "../../shared/i18n/locales";
import { tFor, type MessageId, type Params } from "../../shared/i18n/translate";

const ROOT = path.resolve(import.meta.dirname, "../..");
const CRATE = path.join(ROOT, "crates/relay-i18n");
const catalogFile = (locale: Locale) =>
  path.join(CRATE, "catalogs", `${locale}.json`);
const GOLDEN = path.join(CRATE, "tests/golden/formatted.json");

const catalogText = (locale: Locale) => {
  const catalog = CATALOGS[locale] as Record<string, string>;
  const entries = Object.keys(catalog)
    .sort()
    .map((id) => [id, catalog[id]]);
  return `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`;
};

if (process.argv.includes("--check")) {
  const stale = LOCALES.filter((locale) => {
    try {
      return readFileSync(catalogFile(locale), "utf8") !== catalogText(locale);
    } catch {
      return true;
    }
  });
  if (stale.length) {
    console.error(
      `crates/relay-i18n/catalogs is out of date (${stale.join(", ")}): run node --import tsx scripts/i18n/export-catalogs.ts`,
    );
    process.exit(1);
  }
  process.exit(0);
}

mkdirSync(path.dirname(catalogFile("en")), { recursive: true });
for (const locale of LOCALES)
  writeFileSync(catalogFile(locale), catalogText(locale));

// Numbers that reach every plural form of the 15 languages, a fraction and grouping.
const NUMBERS = [0, 1, 2, 5, 21, 1.5, 1234567.891];
type Element = {
  type: number;
  value?: string;
  options?: Record<string, { value: Element[] }>;
};
type Kind = { numeric: boolean; keys: Set<string> };

/** Every argument an id's messages use in any language, and whether it is a count or a select. */
function argumentKinds(id: MessageId) {
  const kinds = new Map<string, Kind>();
  const walk = (elements: Element[]) => {
    for (const element of elements) {
      if (
        element.value !== undefined &&
        [1, 2, 3, 4, 5, 6].includes(element.type)
      ) {
        const kind = kinds.get(element.value) ?? {
          numeric: false,
          keys: new Set<string>(),
        };
        if (element.type === 2 || element.type === 6) kind.numeric = true;
        if (element.type === 5)
          for (const key of Object.keys(element.options ?? {}))
            kind.keys.add(key);
        kinds.set(element.value, kind);
      }
      for (const option of Object.values(element.options ?? {}))
        walk(option.value);
    }
  };
  for (const locale of LOCALES) {
    const message = new IntlMessageFormat(
      CATALOGS[locale][id],
      FORMAT_LOCALE[locale],
      undefined,
      { ignoreTag: true },
    );
    walk(message.getAst() as Element[]);
  }
  return kinds;
}

/** Argument sets for an id: one when it only has text, else enough to hit every branch. */
function casesFor(id: MessageId): Params[] {
  const kinds = [...argumentKinds(id)];
  const branching = kinds.some(([, k]) => k.numeric || k.keys.size);
  const selectKeys = kinds.map(([, k]) =>
    [...k.keys].filter((key) => key !== "other").concat("zzz"),
  );
  const count = branching
    ? Math.max(NUMBERS.length, ...selectKeys.map((keys) => keys.length))
    : 1;
  return Array.from({ length: count }, (_, i) =>
    Object.fromEntries(
      kinds.map(([name, kind], j) => [
        name,
        kind.numeric
          ? NUMBERS[(i + j) % NUMBERS.length]
          : kind.keys.size
            ? selectKeys[j][i % selectKeys[j].length]
            : `[${name}]`,
      ]),
    ),
  );
}

// Arrays follow `ids`; `null` stands for a single text-only case that reads exactly as the catalog.
const ids = (Object.keys(CATALOGS.en) as MessageId[]).sort();
const cases = ids.map(casesFor);
const formatted = Object.fromEntries(
  LOCALES.map((locale) => {
    const t = tFor(locale);
    const catalog = CATALOGS[locale] as Record<string, string>;
    return [
      locale,
      ids.map((id, i) => {
        const out = cases[i].map((params) => t(id, params));
        return out.length === 1 && out[0] === catalog[id] ? null : out;
      }),
    ];
  }),
);

// Features and edge cases the catalogs do not use yet, formatted by intl-messageformat itself.
const PROBES: { message: string; args: Params[] }[] = [
  {
    message: "{n, number}",
    args: [
      0, 7, 1234, 12345, -1234567.891, 0.0005, 1.0005, 2.5, -2.5, 1e21,
      123456.78949,
    ].map((n) => ({ n })),
  },
  {
    message: "{n, number, percent}",
    args: [0, 0.34, -0.34, 0.07, 12.345, 0.0049].map((n) => ({ n })),
  },
  {
    message: "{n, number, ::percent}",
    args: [0.5, 1, 123.4].map((n) => ({ n })),
  },
  {
    message:
      "{n, number, ::integer-width/*00}:{m, number, ::integer-width/*00}",
    args: [
      { n: 5, m: 0 },
      { n: 123, m: 7.25 },
    ],
  },
  {
    message:
      "{n, number, integer} {n, number, ::.00} {n, number, ::.0#} {n, number, ::group-off}",
    args: [1234.5678, 0.5, 2, 99999.995].map((n) => ({ n })),
  },
  {
    message:
      "{n, number, ::scale/100} {n, number, ::%x100} {n, number, ::precision-integer}",
    args: [0.125, 3].map((n) => ({ n })),
  },
  {
    message: "{n, number}",
    args: ["42", "", "1e3", " 7 ", "abc"].map((n) => ({ n })),
  },
  {
    message: "{n} {s}",
    args: [1e21, 1e-7, 0.1 + 0.2, 123.456, 100, 1.5e300, 0.000001].map((n) => ({
      n,
      s: "x",
    })),
  },
  {
    message:
      "{n, plural, offset:1 =0 {none} =1 {only #} one {# and one} other {# others}}",
    args: [0, 1, 2, 3, 22, 1.5].map((n) => ({ n })),
  },
  {
    message:
      "{n, plural, =0 {zero} one {one #} two {two #} few {few #} many {many #} other {other #}}",
    args: [
      0,
      1,
      2,
      3,
      4,
      5,
      11,
      21,
      22,
      25,
      101,
      1.5,
      0.1,
      1000000,
      "1",
      "3",
      "",
      "x",
    ].map((n) => ({ n })),
  },
  {
    message:
      "{n, selectordinal, one {#st} two {#nd} few {#rd} many {#mth} other {#th}}",
    args: [1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 8].map((n) => ({ n })),
  },
  {
    message:
      "It''s '{name}' and '#' {n, plural, other {'#' is # ''#'' x'y}} '<b>' a<b>c</b> ' {name}",
    args: [{ name: "Ada", n: 3 }],
  },
  {
    message:
      "{g, select, a {{n, plural, one {# a} other {# as}}} b {b # {n}} other {x #}} {n, plural, other {{g, select, a {#} other {in}}}}",
    args: [
      { g: "a", n: 1 },
      { g: "a", n: 4 },
      { g: "b", n: 2 },
      { g: "c", n: 1 },
    ],
  },
  {
    message:
      "{ name } {n,plural,one{#}other{#!}} {n , select , 1 {one} other {not}}",
    args: [
      { name: "x", n: 1 },
      { name: "y", n: 2 },
    ],
  },
  { message: "trailing } brace and lone ' quote", args: [{}] },
  { message: "{missing} here", args: [{}] },
  { message: "{broken", args: [{}] },
  { message: "{n, plural, one {no other}}", args: [{ n: 1 }] },
  // The catalogs format no dates or currencies; a currency style without a code throws.
  { message: "{n, number, currency}", args: [{ n: 1 }] },
];
const probes = PROBES.map(({ message, args }) => ({
  message,
  args,
  out: Object.fromEntries(
    LOCALES.map((locale) => [
      locale,
      args.map((values) => {
        try {
          return String(
            new IntlMessageFormat(message, FORMAT_LOCALE[locale], undefined, {
              ignoreTag: true,
            }).format(values as never),
          );
        } catch {
          return null;
        }
      }),
    ]),
  ),
}));

mkdirSync(path.dirname(GOLDEN), { recursive: true });
writeFileSync(
  GOLDEN,
  `${JSON.stringify({ node: process.version, icu: process.versions.icu, ids, cases, formatted, probes })}\n`,
);
