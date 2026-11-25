//! Relay's message catalogs and the ICU MessageFormat subset they use: a port of
//! `shared/i18n/translate.ts` (`tFor`) and `shared/i18n/locales.ts`.
//!
//! The catalogs are `crates/relay-i18n/catalogs/<locale>.json`, exported from
//! `shared/i18n/catalogs` by `scripts/i18n/export-catalogs.ts`, embedded and parsed on first use.
