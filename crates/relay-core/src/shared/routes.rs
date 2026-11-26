//! Port of `src/app/routes.ts`'s types: the pages, Settings tabs and intents another window may
//! name over IPC (`openPage`, `relay:navigate`).

use serde::{Deserialize, Serialize};

use super::types::literal_enum;

literal_enum!(
    /// Every page id another window may name (`PAGES`).
    PageId {
        Genel = "genel",
        Hesaplar = "hesaplar",
        Proxy = "proxy",
        Kullanim = "kullanim",
        Tokenlar = "tokenlar",
        Rozetler = "rozetler",
        Planlama = "planlama",
        Gecis = "gecis",
        Ayarlar = "ayarlar",
    }
);

literal_enum!(
    /// Settings' tabs, in order (`SETTINGS_TABS`).
    SettingsTab { Genel = "genel", Gelismis = "gelismis" }
);

literal_enum!(
    /// Intents another window may ask the main window for (`PAGE_INTENTS`).
    PageIntent { Ekle = "ekle" }
);

/// `PAGES`, in their order.
pub const PAGES: [PageId; 9] = [
    PageId::Genel,
    PageId::Hesaplar,
    PageId::Proxy,
    PageId::Kullanim,
    PageId::Tokenlar,
    PageId::Rozetler,
    PageId::Planlama,
    PageId::Gecis,
    PageId::Ayarlar,
];

/// `SETTINGS_TABS`, in their order.
pub const SETTINGS_TABS: [SettingsTab; 2] = [SettingsTab::Genel, SettingsTab::Gelismis];

/// A page, or one of Settings' tabs: `ayarlar/gelismis`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Destination {
    Page(PageId),
    Settings(SettingsTab),
}

impl Destination {
    /// The destination as the UI spells it.
    pub fn as_string(self) -> String {
        match self {
            Destination::Page(page) => page.as_str().to_string(),
            Destination::Settings(tab) => format!("ayarlar/{}", tab.as_str()),
        }
    }

    /// Reads `genel` or `ayarlar/gelismis`; `None` for anything else.
    pub fn parse(text: &str) -> Option<Destination> {
        if let Some(tab) = text.strip_prefix("ayarlar/") {
            return SETTINGS_TABS
                .into_iter()
                .find(|t| t.as_str() == tab)
                .map(Destination::Settings);
        }
        PAGES
            .into_iter()
            .find(|p| p.as_str() == text)
            .map(Destination::Page)
    }
}

impl Serialize for Destination {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.as_string())
    }
}

impl<'de> Deserialize<'de> for Destination {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        Destination::parse(&text)
            .ok_or_else(|| serde::de::Error::custom(format!("unknown destination: {text}")))
    }
}

/// `routeHash(page)`: `#/<page>`.
pub fn route_hash(page: Destination) -> String {
    format!("#/{}", page.as_string())
}

/// `intentHash(page, intent)`: `#/hesaplar?ekle`.
pub fn intent_hash(page: Destination, intent: Option<PageIntent>) -> String {
    match intent {
        Some(intent) => format!("{}?{}", route_hash(page), intent.as_str()),
        None => route_hash(page),
    }
}
