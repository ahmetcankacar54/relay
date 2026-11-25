//! Port of `shared/proxy-url.ts`.

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
        "0.0.0.0" => "127.0.0.1".to_string(),
        "::" | "[::]" => "[::1]".to_string(),
        _ => bracketed(host),
    }
}

/// `http://127.0.0.1:8317`: where the gateway answers.
pub fn gateway_url(host: &str, port: impl std::fmt::Display) -> String {
    format!("http://{}:{port}", client_host(host))
}

/// JS `Number(text)` for one dotted part, as far as an integer check in 0–255 needs it: `None`
/// for anything that is not a finite integer.
fn js_integer(text: &str) -> Option<f64> {
    let t = text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    if t.is_empty() {
        // Number("") and Number("  ") are 0.
        return Some(0.0);
    }
    let value = if let Some(hex) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        u64::from_str_radix(hex, 16).ok()? as f64
    } else if let Some(oct) = t.strip_prefix("0o").or_else(|| t.strip_prefix("0O")) {
        u64::from_str_radix(oct, 8).ok()? as f64
    } else if let Some(bin) = t.strip_prefix("0b").or_else(|| t.strip_prefix("0B")) {
        u64::from_str_radix(bin, 2).ok()? as f64
    } else {
        // Rust also reads "inf"/"nan" spellings JS does not; neither is an integer anyway.
        if !t.bytes().all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'e' | b'E' | b'+' | b'-')) {
            return None;
        }
        t.parse::<f64>().ok()?
    };
    (value.is_finite() && value.fract() == 0.0).then_some(value)
}

/// Whether an IPv4 address is in Tailscale's 100.64.0.0/10 range.
pub fn is_tailscale_ipv4(address: &str) -> bool {
    let parts: Vec<&str> = address.split('.').collect();
    if parts.len() != 4 {
        return false;
    }
    let mut nums = [0f64; 4];
    for (slot, part) in nums.iter_mut().zip(&parts) {
        match js_integer(part) {
            Some(n) if (0.0..=255.0).contains(&n) => *slot = n,
            _ => return false,
        }
    }
    nums[0] == 100.0 && (64.0..=127.0).contains(&nums[1])
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
