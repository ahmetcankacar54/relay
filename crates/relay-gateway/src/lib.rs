//! The local gateway that spreads Claude and Codex requests over saved accounts: a port of
//! `electron/core/proxy/**` (and the overflow upstream) with the same routes, limits, JSON
//! shapes and routing.
//!
//! The host (the Rust CLI, the Electron sidecar, later the Tauri app) supplies accounts, limits
//! and sign-ins through [`GatewayHooks`]; client binding (`proxy-clients.ts`) stays with it.

pub mod anthropic_upstream;
pub mod client_res;
pub mod codex_upstream;
pub mod credential_cache;
pub mod hub_management;
pub mod js;
pub mod model_prices;
pub mod omp_models;
pub mod overflow;
pub mod overflow_upstream;
pub mod proxy_insights;
pub mod proxy_request_log;
pub mod proxy_router;
pub mod proxy_server;
pub mod proxy_session_cache;
pub mod proxy_stats;
pub mod proxy_status;
pub mod proxy_url;
pub mod ranking;
pub mod sidecar;
pub mod types;
pub mod upstream_common;
pub mod websocket_bridge;

pub use proxy_server::{
    AntigravityRoute, GatewayHooks, NoHooks, ProxyServer, ServerOptions, ServerStatus, StartError,
    Upstreams, alias_codex_path, client_of,
};
pub use types::*;
