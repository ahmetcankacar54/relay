//! Port of `tests/proxy-cli.test.ts`. macOS only, as the TS skips elsewhere.
#![cfg(target_os = "macos")]

mod common;

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};

use common::{Options, cli_fixture};
use relay_cli::args::{FlagValue, parse_command};
use relay_core::shared::proxy_types::ProxyConfig;
use serde_json::{Value, json};

fn args(list: &[&str]) -> Vec<String> {
    list.iter().map(|a| (*a).to_owned()).collect()
}

/// The last x-relay-key the server saw.
type SeenKey = Arc<Mutex<Option<String>>>;

/// A local server answering every request with `body`, with 200 when `want` (if any) is the
/// request's x-relay-key and 401 otherwise; remembers the last key it saw.
fn server(body: Value, want: Option<&'static str>) -> (u16, SeenKey, Arc<Mutex<bool>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = Arc::new(Mutex::new(None));
    let closed = Arc::new(Mutex::new(false));
    let (seen_in, closed_in) = (seen.clone(), closed.clone());
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            if *closed_in.lock().unwrap() {
                // Closed: drop the connection unanswered, as a stopped server's port would refuse.
                continue;
            }
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut key = None;
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                    break;
                }
                if let Some((name, value)) = line.split_once(':')
                    && name.eq_ignore_ascii_case("x-relay-key")
                {
                    key = Some(value.trim().to_owned());
                }
            }
            let ok = want.is_none_or(|w| key.as_deref() == Some(w));
            *seen_in.lock().unwrap() = key;
            let text = body.to_string();
            let _ = write!(
                stream,
                "HTTP/1.1 {}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{text}",
                if ok { "200 OK" } else { "401 Unauthorized" },
                text.len()
            );
        }
    });
    (port, seen, closed)
}

#[test]
fn relay_proxy_takes_port_and_host_and_rejects_bad_values() {
    let parsed =
        parse_command(&args(&["proxy", "env", "--port", "9000", "--host", "::1"])).unwrap();
    assert_eq!(
        parsed.flags.get("port"),
        Some(&FlagValue::Str("9000".into()))
    );
    let error = parse_command(&args(&["list", "--port", "1"])).unwrap_err();
    assert!(error.message.contains("does not take --port") || error.message.contains("list"));

    let f = cli_fixture(Options::default());
    assert_eq!(f.run(&["proxy", "env", "--port", "9000"]), 0);
    // Plain lines: usable with eval.
    assert_eq!(
        f.out(),
        [
            "export ANTHROPIC_BASE_URL=\"http://127.0.0.1:9000\"",
            "export ANTHROPIC_AUTH_TOKEN=\"<relay-key>\"",
            "export CLAUDE_CODE_PROMPT_CACHE_TTL=\"1h\"",
            "export OPENAI_BASE_URL=\"http://127.0.0.1:9000/v1\"",
            "export OPENAI_API_KEY=\"<relay-key>\"",
        ]
        .join("\n")
    );
    f.clear();
    assert_eq!(f.run(&["proxy", "env", "--host", "::1"]), 0);
    assert!(f.out().contains("http://[::1]:8317"));
    f.clear();
    assert_eq!(f.run(&["proxy", "env", "--host", "100.101.12.34"]), 0);
    assert!(f.out().contains("http://100.101.12.34:8317"));
    // Only this computer or its tailnet: a whole-network or foreign address is refused.
    for host in ["0.0.0.0", "::", "192.168.1.5", "example.com", "x/y", ""] {
        f.clear();
        assert_eq!(f.run(&["proxy", "env", "--host", host]), 2, "{host}");
        assert!(
            f.err()
                .contains("Use 127.0.0.1, localhost or a Tailscale address."),
            "{host}"
        );
    }
    for port in ["0", "70000", "abc", "-1"] {
        assert_eq!(f.run(&["proxy", "env", "--port", port]), 2, "{port}");
    }
    assert_eq!(f.run(&["proxy", "frobnicate"]), 2);
}

#[test]
fn relay_proxy_status_reports_a_running_and_a_stopped_gateway() {
    let body = json!({
        "ok": true,
        "state": { "status": "running", "activeSessionsCount": 2 },
        "metrics": { "totalRequests": 5, "cacheHitRatio": 0.5 },
    });
    let (port, _, closed) = server(body, None);
    let port = port.to_string();
    let f = cli_fixture(Options::default());
    assert_eq!(f.run(&["proxy", "status", "--port", &port]), 0);
    assert!(f.out().contains("is running"));
    assert!(f.out().contains("Total Requests: 5"));
    assert!(f.out().contains("Cache Hit Ratio: 50.0%"));
    f.clear();
    assert_eq!(f.run(&["proxy", "status", "--json", "--port", &port]), 0);
    assert_eq!(
        serde_json::from_str::<Value>(&f.out()).unwrap()["running"],
        true
    );
    *closed.lock().unwrap() = true;
    f.clear();
    assert_eq!(f.run(&["proxy", "status", "--json", "--port", &port]), 0);
    assert_eq!(
        serde_json::from_str::<Value>(&f.out()).unwrap()["running"],
        false
    );
}

#[test]
fn relay_proxy_env_and_status_use_the_client_key_relay_app_saved() {
    const KEY: &str = "relay-sec-cli-test-key";
    let body =
        json!({ "ok": true, "state": { "status": "running" }, "metrics": { "totalRequests": 1 } });
    let (port, seen, _) = server(body, Some(KEY));
    let f = cli_fixture(Options::default());
    f.store()
        .update(|s| {
            s.settings.proxy = Some(
                serde_json::from_value::<ProxyConfig>(json!({
                    "enabled": true, "port": port, "host": "127.0.0.1", "affinityTtlSeconds": 300,
                    "routingStrategy": "soonest-reset", "apiKey": KEY,
                }))
                .unwrap(),
            );
        })
        .unwrap();
    assert_eq!(f.run(&["proxy", "env"]), 0);
    assert!(f.out().contains(&format!("ANTHROPIC_AUTH_TOKEN=\"{KEY}\"")));
    assert!(f.out().contains(&format!("OPENAI_API_KEY=\"{KEY}\"")));
    f.clear();
    assert_eq!(
        f.run(&["proxy", "status", "--json", "--port", &port.to_string()]),
        0
    );
    assert_eq!(
        serde_json::from_str::<Value>(&f.out()).unwrap()["running"],
        true
    );
    assert_eq!(seen.lock().unwrap().as_deref(), Some(KEY));
}
