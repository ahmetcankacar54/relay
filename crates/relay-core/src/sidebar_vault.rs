//! Port of `electron/core/sidebar-vault.ts`: the one sidebar gap Relay offers.

use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;

use crate::desktop_files::{DesktopFileError, is_uuid, json_bytes, read_object, write_bytes};
use crate::fs_util::{iso_timestamp, parse_iso_ms};
use crate::sidebar_layout::{GapSection, SidebarGap};

/// Inside the vault. Plain JSON: section names and aliases, no conversation text.
const FILE: &str = "sidebar/pending.json";
/// An entry older than this is not offered any more.
const MAX_AGE_MS: i64 = 14 * 24 * 60 * 60_000;

/// What the last account-changing switch found the account switched to lacks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SidebarGapRecord {
    pub id: String,
    /// The Desktop account switched to.
    pub to: String,
    pub at: String,
    pub gap: SidebarGap,
}

fn strings(value: &Value) -> Option<Vec<String>> {
    value
        .as_array()?
        .iter()
        .map(|v| v.as_str().map(str::to_owned))
        .collect()
}

/// `Number.isInteger`.
fn integer(value: Option<&Value>) -> Option<i64> {
    let n = value?.as_f64()?;
    (n.is_finite() && n.fract() == 0.0).then_some(n as i64)
}

/// A clean copy of `value` when it is an entry this vault wrote, else None.
fn parse_record(value: &Value) -> Option<SidebarGapRecord> {
    let record = value.as_object()?;
    let id = record.get("id")?.as_str().filter(|v| is_uuid(v))?;
    let to = record.get("to")?.as_str().filter(|v| is_uuid(v))?;
    let at = record.get("at")?.as_str()?;
    parse_iso_ms(at)?;
    let gap = record.get("gap")?.as_object()?;
    let sections = gap
        .get("sections")?
        .as_array()?
        .iter()
        .map(|s| {
            let s = s.as_object()?;
            let name = s.get("name")?.as_str().filter(|n| !n.is_empty())?;
            let ids = strings(s.get("ids")?)?;
            ids.iter().all(|alias| is_uuid(alias)).then(|| GapSection {
                name: name.to_owned(),
                ids,
            })
        })
        .collect::<Option<Vec<_>>>()?;
    Some(SidebarGapRecord {
        id: id.to_owned(),
        to: to.to_owned(),
        at: at.to_owned(),
        gap: SidebarGap {
            sections,
            missing_sections: integer(gap.get("missingSections"))?,
            sessions: integer(gap.get("sessions"))?,
            from: strings(gap.get("from")?)?,
        },
    })
}

/// The one sidebar gap Relay offers, in `<vault>/sidebar/pending.json`: what the account switched
/// to at the last account-changing switch lacks of its sources' sidebar organization. Each such
/// switch replaces or clears it; the user can dismiss it. An entry that cannot be read, or is over
/// 14 days old, reads as none.
pub struct SidebarGapVault {
    vault: PathBuf,
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
}

impl SidebarGapVault {
    pub fn new(vault: impl Into<PathBuf>) -> SidebarGapVault {
        SidebarGapVault::with_clock(vault, Arc::new(crate::clock::now_ms))
    }

    pub fn with_clock(
        vault: impl Into<PathBuf>,
        now: Arc<dyn Fn() -> i64 + Send + Sync>,
    ) -> SidebarGapVault {
        SidebarGapVault {
            vault: vault.into(),
            now,
        }
    }

    /// Replaces the entry with a new one for `to`, and returns it.
    pub fn put(&self, to: &str, gap: SidebarGap) -> Result<SidebarGapRecord, DesktopFileError> {
        let record = SidebarGapRecord {
            id: uuid::Uuid::new_v4().to_string(),
            to: to.to_owned(),
            at: iso_timestamp((self.now)()),
            gap,
        };
        write_bytes(&self.vault, FILE, Some(&json_bytes(&record)))?;
        Ok(record)
    }

    pub fn clear(&self) -> Result<(), DesktopFileError> {
        write_bytes(&self.vault, FILE, None)
    }

    pub fn get(&self) -> Option<SidebarGapRecord> {
        let object = read_object(&self.vault, FILE).ok()??;
        let record = parse_record(&Value::Object(object))?;
        let at = parse_iso_ms(&record.at)?;
        ((self.now)() - at <= MAX_AGE_MS).then_some(record)
    }

    /// Removes the entry when it is still `id`; a newer one stays.
    pub fn remove(&self, id: &str) -> Result<(), DesktopFileError> {
        if self.get().is_some_and(|record| record.id == id) {
            self.clear()?;
        }
        Ok(())
    }
}
