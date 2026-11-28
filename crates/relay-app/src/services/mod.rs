//! Ports of electron/main/*.ts modules that are not windows: each keeps its TS module's name
//! and exports (`electron/main/<a-b>.ts` → `crate::services::<a_b>`).

pub mod antigravity;
pub mod backup;
pub mod continue_conversation;
pub mod data_reset;
pub mod desktop_lock;
pub mod desktop_support;
pub mod desktop_usage;
pub mod diagnostics;
pub mod errors;
pub mod gateway;
pub mod links;
pub mod login_item;
pub mod logs;
pub mod notifications;
pub mod sign_in_renewal;
pub mod statusline;
pub mod tokens_widget;
pub mod tray_actions;
pub mod tray_setup;
pub mod updates;
