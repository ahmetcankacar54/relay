//! The Rust port of `shared/proxy-url.ts`, delegating to `relay_core::shared::proxy_url`.

#![forbid(unsafe_code)]

use relay_core::shared::proxy_url;
use relay_core::shared::types::js::number_string;

/// Port of `clientHost` (`shared/proxy-url.ts:4`).
pub fn client_host(host: String) -> Result<String, String> {
    Ok(proxy_url::client_host(&host))
}

/// Port of `gatewayUrl` (`shared/proxy-url.ts:11`): the port prints as JS `${port}` does.
pub fn gateway_url(host: String, port: f64) -> Result<String, String> {
    Ok(proxy_url::gateway_url(&host, number_string(port)))
}

/// Port of `isTailscaleIPv4` (`shared/proxy-url.ts:14`).
pub fn is_tailscale_i_pv4(address: String) -> Result<bool, String> {
    Ok(proxy_url::is_tailscale_ipv4(&address))
}

/// Port of `gatewayHostAllowed` (`shared/proxy-url.ts:26`).
pub fn gateway_host_allowed(host: String) -> Result<bool, String> {
    Ok(proxy_url::gateway_host_allowed(&host))
}
