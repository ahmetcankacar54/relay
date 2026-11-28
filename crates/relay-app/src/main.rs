//! Relay's Tauri shell: windows, tray and the IPC bridge over relay-core.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    relay_app::run();
}
