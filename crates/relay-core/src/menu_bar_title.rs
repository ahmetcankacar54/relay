//! Port of `electron/core/menu-bar-title.ts`: the items the macOS menu bar title shows, kept in
//! `<userData>/menu-bar.json` outside Relay's registry, so a change never asks the registry for a
//! new layout (an older `relay` CLI would refuse to write one). A missing or unreadable file is
//! the title Relay has always shown, the five-hour percent alone.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::fs_util::{create_private_dir_all, dirname};
use crate::shared::tray::{DEFAULT_MENU_BAR_ITEMS, menu_bar_items};
use crate::shared::types::{MenuBarItem, MenuBarTitleChoice};

#[derive(Debug, Clone)]
pub struct MenuBarTitle {
    /// The choice's file, its folder created when first saved.
    file: PathBuf,
    items: Vec<MenuBarItem>,
}

impl MenuBarTitle {
    pub fn new(file: impl Into<PathBuf>) -> Self {
        let file = file.into();
        let items = Self::read(&file);
        MenuBarTitle { file, items }
    }

    pub fn file(&self) -> &Path {
        &self.file
    }

    fn read(file: &Path) -> Vec<MenuBarItem> {
        fs::read_to_string(file)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .map_or_else(
                || DEFAULT_MENU_BAR_ITEMS.to_vec(),
                |value| menu_bar_items(value.get("items")),
            )
    }

    /// A copy of the choice as kept.
    pub fn current(&self) -> MenuBarTitleChoice {
        MenuBarTitleChoice {
            items: self.items.clone(),
        }
    }

    /// Replaces the items, as `menu_bar_items` keeps them; returns the choice as kept.
    pub fn set(&mut self, choice: &MenuBarTitleChoice) -> io::Result<MenuBarTitleChoice> {
        let given = serde_json::to_value(&choice.items).map_err(io::Error::other)?;
        let items = menu_bar_items(Some(&given));
        create_private_dir_all(dirname(&self.file))?;
        let text = serde_json::json!({ "items": items }).to_string();
        let mut options = OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options.open(&self.file)?.write_all(text.as_bytes())?;
        self.items = items;
        Ok(self.current())
    }
}
