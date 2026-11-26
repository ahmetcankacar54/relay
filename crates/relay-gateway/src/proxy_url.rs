//! Where the gateway listens and how clients dial it (`shared/proxy-url.ts`).

fn bracketed(host: &str) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_string()
    }
}

/// The address a client dials: a wildcard bind address is reached through loopback.
pub fn client_host(host: &str) -> String {
    match host {
        "0.0.0.0" => "127.0.0.1".into(),
        "::" | "[::]" => "[::1]".into(),
        _ => bracketed(host),
    }
}

/// `http://127.0.0.1:8317`: where the gateway answers.
pub fn gateway_url(host: &str, port: u16) -> String {
    format!("http://{}:{port}", client_host(host))
}

/// Whether an IPv4 address is in Tailscale's 100.64.0.0/10 range.
pub fn is_tailscale_ipv4(address: &str) -> bool {
    let parts: Vec<&str> = address.split('.').collect();
    if parts.len() != 4 {
        return false;
    }
    let mut octets = [0u32; 4];
    for (slot, part) in octets.iter_mut().zip(&parts) {
        // `Number(part)`: an integer 0–255 (leading zeros and surrounding spaces allowed).
        let value = crate::js::number(part);
        if value.fract() != 0.0 || !(0.0..=255.0).contains(&value) {
            return false;
        }
        *slot = value as u32;
    }
    octets[0] == 100 && (64..=127).contains(&octets[1])
}

/// The loopback names the gateway may listen on and answer to.
pub const LOOPBACK_HOSTS: [&str; 3] = ["127.0.0.1", "localhost", "::1"];

pub fn is_loopback_host(host: &str) -> bool {
    LOOPBACK_HOSTS.contains(&host)
}

pub const GATEWAY_HOST_ERROR: &str = "Use 127.0.0.1, localhost or a Tailscale address.";

/// Where the gateway may listen: this computer only, or this computer's tailnet address.
pub fn gateway_host_allowed(host: &str) -> bool {
    is_loopback_host(host) || is_tailscale_ipv4(host)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tailnet_and_loopback() {
        assert!(is_tailscale_ipv4("100.64.0.1"));
        assert!(is_tailscale_ipv4("100.127.255.255"));
        assert!(!is_tailscale_ipv4("100.128.0.1"));
        assert!(!is_tailscale_ipv4("100.64.0"));
        assert!(gateway_host_allowed("localhost"));
        assert!(!gateway_host_allowed("0.0.0.0"));
        assert_eq!(gateway_url("::1", 8317), "http://[::1]:8317");
        assert_eq!(gateway_url("0.0.0.0", 1), "http://127.0.0.1:1");
    }
}
