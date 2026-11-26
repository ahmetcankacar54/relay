//! Port of the `electron/core/remote-notify` cases of `tests/remote-notify.test.ts`. The first
//! case ("only https, or http to this computer, …") is in `shared_remote_notify.rs` (the URL rule)
//! and `store_settings.rs` (the settings schema).
//!
//! The TS cases inject a recording `fetch`; so do these (`RemoteDeps::fetch`). The timeout case
//! and `real_fetch_posts_what_the_recorder_sees` run the default fetch against a localhost server.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use relay_core::limit_notice::LimitWindowKind;
use relay_core::remote_notify::{
    Fetch, FetchError, RemoteDeps, RemoteEventName, RemoteNotice, RemoteNotifier, RemoteTarget,
    ntfy_request, post_remote_notice, webhook_payload,
};
use relay_core::shared::types::js::{date_parse, iso};
use relay_core::shared::types::{
    RemoteNotifyEvents, RemoteNotifyFailure, RemoteNotifyKind, RemoteNotifyResult,
    RemoteNotifySettings,
};

const TOKEN: &str = "sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdef";
const JWT: &str =
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbHRvQGV4YW1wbGUuY29tIn0.c2lnbmF0dXJlLXNpZ25hdHVyZQ";
const EMAIL: &str = "alto@example.com";
const ACCOUNT_ID: &str = "3f2c8a51-7d4e-4b1a-9c6f-0e8d2b7a4c19";
const ORG_ID: &str = "9b1e7c42-5a3d-4f8e-b2c6-1d0a9e8f7b35";

fn now() -> f64 {
    date_parse("2026-10-13T06:00:00Z")
}

fn notice(event: RemoteEventName, title: &str, message: &str) -> RemoteNotice {
    RemoteNotice {
        event,
        account_name: None,
        window: None,
        used_percent: None,
        resets_at: None,
        title: title.into(),
        message: message.into(),
    }
}

/// An event whose every text field carries a planted secret, as a careless caller might pass it.
fn leaky() -> RemoteNotice {
    RemoteNotice {
        account_name: Some(EMAIL.into()),
        window: Some(LimitWindowKind::FiveHour),
        used_percent: Some(91.7),
        resets_at: Some(iso(now() + 3_600_000.0)),
        ..notice(
            RemoteEventName::LimitNear,
            &format!("{EMAIL} is at 91% {TOKEN}"),
            &format!("org {ORG_ID} account {ACCOUNT_ID} bearer {JWT}"),
        )
    }
}

const SECRETS: [&str; 7] = [
    TOKEN,
    JWT,
    EMAIL,
    ACCOUNT_ID,
    ORG_ID,
    "sk-ant",
    "example.com",
];

#[derive(Clone, Debug)]
struct Call {
    url: String,
    headers: Vec<(String, String)>,
    body: String,
}

impl Call {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }
}

#[derive(Clone)]
enum Answer {
    Status(u16),
    Error(String),
}

/// A fetch that records each call and answers from `answers` in turn.
fn recorder(answers: Vec<Answer>) -> (Arc<Mutex<Vec<Call>>>, Fetch) {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let fetch: Fetch = Arc::new({
        let calls = Arc::clone(&calls);
        move |req| {
            let mut calls = calls.lock().unwrap();
            calls.push(Call {
                url: req.url.to_string(),
                headers: req.request.headers.clone(),
                body: req.request.body.clone(),
            });
            match &answers[(calls.len() - 1).min(answers.len() - 1)] {
                Answer::Status(status) => Ok(*status),
                Answer::Error(text) => Err(FetchError::Failed(text.clone())),
            }
        }
    });
    (calls, fetch)
}

fn deps(
    fetch: Option<Fetch>,
    logs: Arc<Mutex<Vec<String>>>,
    sleeps: Arc<Mutex<Vec<u64>>>,
) -> RemoteDeps {
    RemoteDeps {
        fetch,
        now: Some(Arc::new(now)),
        log: Some(Arc::new(move |line| logs.lock().unwrap().push(line.into()))),
        sleep: Some(Arc::new(move |ms| sleeps.lock().unwrap().push(ms))),
        timeout_ms: Some(20),
        retry_ms: Some(1_234),
        ..RemoteDeps::new(|| "0.29.0".into())
    }
}

fn quiet(fetch: Fetch) -> RemoteDeps {
    deps(Some(fetch), Arc::default(), Arc::default())
}

fn target(url: &str, kind: RemoteNotifyKind) -> RemoteTarget<'_> {
    RemoteTarget {
        url: Some(url),
        kind,
    }
}

fn failed(status: Option<f64>, error: Option<&str>) -> RemoteNotifyResult {
    RemoteNotifyResult::Failed {
        ok: false,
        reason: RemoteNotifyFailure::Failed,
        status,
        error: error.map(String::from),
    }
}

fn ok(status: f64) -> RemoteNotifyResult {
    RemoteNotifyResult::Ok { ok: true, status }
}

#[test]
fn neither_the_webhook_json_nor_the_ntfy_post_carries_a_token_an_email_or_an_id() {
    let payload = webhook_payload(&leaky(), now(), "0.29.0");
    let json = serde_json::to_value(&payload).unwrap();
    let mut keys: Vec<&String> = json.as_object().unwrap().keys().collect();
    keys.sort();
    assert_eq!(
        keys,
        [
            "account",
            "at",
            "event",
            "relayVersion",
            "resetsAt",
            "usedPercent",
            "window"
        ]
    );
    assert_eq!(json["account"], serde_json::json!({ "name": "[email]" }));
    assert_eq!(payload.used_percent, Some(91.0));
    assert_eq!(json["usedPercent"], serde_json::json!(91));
    assert_eq!(json["window"], "five_hour");
    assert_eq!(payload.at, iso(now()));
    let ntfy = ntfy_request(&leaky());
    for text in [
        serde_json::to_string(&payload).unwrap(),
        ntfy.body.clone(),
        format!("{:?}", ntfy.headers),
    ] {
        for secret in SECRETS {
            assert!(!text.contains(secret), "{secret} in {text}");
        }
    }
    // A plain account name passes as it is.
    let plain = RemoteNotice {
        account_name: Some("Alto".into()),
        ..leaky()
    };
    assert_eq!(
        serde_json::to_value(webhook_payload(&plain, now(), "0.29.0").account).unwrap(),
        serde_json::json!({ "name": "Alto" })
    );
}

#[test]
fn ntfy_gets_the_text_as_its_body_and_title_tags_and_priority_as_headers() {
    let plain = ntfy_request(&RemoteNotice {
        account_name: Some("Alto".into()),
        ..notice(
            RemoteEventName::LimitReady,
            "Alto is ready again",
            "The 5-hour limit reset.",
        )
    });
    assert_eq!(plain.body, "The 5-hour limit reset.");
    assert_eq!(plain.header("Title"), Some("Alto is ready again"));
    assert_eq!(plain.header("Tags"), Some("white_check_mark,relay"));
    assert_eq!(
        plain.header("Content-Type"),
        Some("text/plain; charset=utf-8")
    );
    assert_eq!(plain.header("Priority"), None);
    assert_eq!(ntfy_request(&leaky()).header("Priority"), Some("high"));
    // A title outside ASCII is RFC 2047 encoded, which fetch accepts and ntfy decodes.
    let turkish = ntfy_request(&notice(RemoteEventName::AutoSwitch, "Otomatik geçiş", ""));
    let title = turkish.header("Title").unwrap();
    let encoded = title
        .strip_prefix("=?UTF-8?B?")
        .and_then(|t| t.strip_suffix("?="))
        .unwrap();
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .unwrap();
    assert_eq!(String::from_utf8(decoded).unwrap(), "Otomatik geçiş");
    assert_eq!(turkish.body, "Otomatik geçiş");
    for (name, value) in &turkish.headers {
        assert!(reqwest::header::HeaderName::from_bytes(name.as_bytes()).is_ok());
        assert!(reqwest::header::HeaderValue::from_str(value).is_ok());
    }
}

#[test]
fn a_webhook_post_is_json_refuses_redirects_and_reports_its_status() {
    let (calls, fetch) = recorder(vec![Answer::Status(204)]);
    let result = post_remote_notice(
        target("https://example.com/hooks/relay", RemoteNotifyKind::Webhook),
        &RemoteNotice {
            event: RemoteEventName::Test,
            ..leaky()
        },
        &quiet(fetch),
    );
    assert_eq!(result, ok(204.0));
    let calls = calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].url, "https://example.com/hooks/relay");
    assert_eq!(calls[0].header("Content-Type"), Some("application/json"));
    let body: serde_json::Value = serde_json::from_str(&calls[0].body).unwrap();
    assert_eq!(body["event"], "test");
    assert_eq!(body["relayVersion"], "0.29.0");
    // POST and no redirect: what the real fetch sends, against a server on this computer.
    let server = Server::start(vec![Reply::Status(302)]);
    let result = post_remote_notice(
        target(&server.url("/hooks/relay"), RemoteNotifyKind::Webhook),
        &RemoteNotice {
            event: RemoteEventName::Test,
            ..leaky()
        },
        // A real connection: 20 ms is too tight for a busy Windows runner's first request.
        &RemoteDeps {
            timeout_ms: Some(2_000),
            ..deps(None, Arc::default(), Arc::default())
        },
    );
    assert_eq!(result, failed(None, Some("fetch failed")));
    let seen = server.requests();
    assert_eq!(seen.len(), 2);
    assert!(seen[0].head.starts_with("POST /hooks/relay HTTP/1.1"));
    assert!(
        seen[0]
            .head
            .to_ascii_lowercase()
            .contains("content-type: application/json")
    );
    let body: serde_json::Value = serde_json::from_str(&seen[0].body).unwrap();
    assert_eq!(body["event"], "test");
}

#[test]
fn a_timeout_is_tried_once_more_after_the_backoff_then_reported_never_thrown() {
    let logs = Arc::new(Mutex::new(Vec::new()));
    let sleeps = Arc::new(Mutex::new(Vec::new()));
    let server = Server::start(vec![Reply::Hang]);
    let url = server.url("/relay-private-topic");
    let result = post_remote_notice(
        target(&url, RemoteNotifyKind::Ntfy),
        &leaky(),
        // Long enough for a busy runner to deliver each request before its try times out.
        &RemoteDeps {
            timeout_ms: Some(500),
            ..deps(None, Arc::clone(&logs), Arc::clone(&sleeps))
        },
    );
    assert_eq!(result, failed(None, Some("timeout")));
    assert_eq!(server.requests().len(), 2);
    assert_eq!(*sleeps.lock().unwrap(), [1_234]);
    let logs = logs.lock().unwrap();
    assert_eq!(logs.len(), 1);
    assert!(
        !logs[0].contains("relay-private-topic") && !logs[0].contains("127.0.0.1"),
        "{}",
        logs[0]
    );
}

#[test]
fn a_5xx_or_a_network_failure_is_retried_once_a_4xx_is_final_and_errors_never_name_the_url() {
    let (calls, fetch) = recorder(vec![Answer::Status(503), Answer::Status(200)]);
    assert_eq!(
        post_remote_notice(
            target("https://ntfy.sh/relay", RemoteNotifyKind::Ntfy),
            &leaky(),
            &quiet(fetch)
        ),
        ok(200.0)
    );
    assert_eq!(calls.lock().unwrap().len(), 2);
    let (refused, fetch) = recorder(vec![Answer::Status(403)]);
    assert_eq!(
        post_remote_notice(
            target("https://ntfy.sh/relay", RemoteNotifyKind::Ntfy),
            &leaky(),
            &quiet(fetch)
        ),
        failed(Some(403.0), Some("HTTP 403"))
    );
    assert_eq!(refused.lock().unwrap().len(), 1);
    let url = "https://hooks.example.com/secret-path";
    let (down, fetch) = recorder(vec![Answer::Error(format!("fetch failed for {url}"))]);
    let result = post_remote_notice(
        target(url, RemoteNotifyKind::Webhook),
        &leaky(),
        &quiet(fetch),
    );
    assert_eq!(down.lock().unwrap().len(), 2);
    assert!(matches!(result, RemoteNotifyResult::Failed { .. }));
    let text = serde_json::to_string(&result).unwrap();
    assert!(!text.contains("secret-path") && !text.contains("hooks.example.com"));
    // Without a URL nothing is sent; a refused URL never reaches fetch.
    let (idle, fetch) = recorder(vec![Answer::Status(200)]);
    let off = RemoteTarget {
        url: None,
        kind: RemoteNotifyKind::Ntfy,
    };
    assert_eq!(
        post_remote_notice(off, &leaky(), &quiet(Arc::clone(&fetch))),
        RemoteNotifyResult::Failed {
            ok: false,
            reason: RemoteNotifyFailure::Off,
            status: None,
            error: None
        }
    );
    assert_eq!(
        post_remote_notice(
            target("http://example.com/x", RemoteNotifyKind::Ntfy),
            &leaky(),
            &quiet(fetch)
        ),
        RemoteNotifyResult::Failed {
            ok: false,
            reason: RemoteNotifyFailure::InvalidUrl,
            status: None,
            error: None
        }
    );
    assert_eq!(idle.lock().unwrap().len(), 0);
}

#[test]
fn the_notifier_posts_only_the_events_that_are_on_and_only_with_a_url() {
    let (calls, fetch) = recorder(vec![Answer::Status(200)]);
    let remote_notify: Arc<Mutex<Option<RemoteNotifySettings>>> = Arc::default();
    let notifier = RemoteNotifier::new(quiet(fetch), {
        let remote_notify = Arc::clone(&remote_notify);
        move || remote_notify.lock().unwrap().clone()
    });
    // Each post is waited for before the next, as `settle()` does in the TS.
    let settle = |handle: Option<std::thread::JoinHandle<()>>| {
        if let Some(handle) = handle {
            handle.join().unwrap();
        }
    };
    settle(notifier.notify(leaky()));
    assert_eq!(calls.lock().unwrap().len(), 0);
    *remote_notify.lock().unwrap() = Some(RemoteNotifySettings {
        url: Some("https://ntfy.sh/relay".into()),
        kind: RemoteNotifyKind::Ntfy,
        events: RemoteNotifyEvents {
            limit: false,
            reset: true,
            auto_switch: true,
            sign_in: true,
        },
    });
    settle(notifier.notify(leaky()));
    settle(notifier.notify(notice(RemoteEventName::Test, "x", "")));
    assert_eq!(calls.lock().unwrap().len(), 0);
    settle(notifier.notify(RemoteNotice {
        account_name: Some("Alto".into()),
        window: Some(LimitWindowKind::SevenDay),
        ..notice(RemoteEventName::LimitReady, "Alto is ready again", "")
    }));
    settle(notifier.notify(RemoteNotice {
        account_name: Some("Vertex".into()),
        ..notice(RemoteEventName::AutoSwitch, "Automatic switch", "")
    }));
    settle(notifier.notify(RemoteNotice {
        account_name: Some("Cirrus".into()),
        ..notice(RemoteEventName::SignInEnded, "Sign-in ended", "")
    }));
    assert_eq!(
        calls
            .lock()
            .unwrap()
            .iter()
            .map(|c| c.header("Tags").unwrap().to_string())
            .collect::<Vec<_>>(),
        [
            "white_check_mark,relay",
            "twisted_rightwards_arrows,relay",
            "key,relay"
        ]
    );
    // The test button posts whatever the events say.
    assert_eq!(
        notifier.test("https://ntfy.sh/relay", RemoteNotifyKind::Ntfy, &leaky()),
        ok(200.0)
    );
}

// A one-route HTTP server on 127.0.0.1 for the default fetch.

#[derive(Clone, Copy)]
enum Reply {
    Status(u16),
    /// Reads the request and never answers.
    Hang,
}

#[derive(Clone, Debug)]
struct Seen {
    head: String,
    body: String,
}

struct Server {
    port: u16,
    seen: Arc<Mutex<Vec<Seen>>>,
}

impl Server {
    fn start(replies: Vec<Reply>) -> Server {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&seen);
        std::thread::spawn(move || {
            let mut held: Vec<TcpStream> = Vec::new();
            for (n, stream) in listener.incoming().enumerate() {
                let Ok(mut stream) = stream else { break };
                let Some(request) = read_request(&stream) else {
                    continue;
                };
                log.lock().unwrap().push(request);
                match replies[n.min(replies.len() - 1)] {
                    Reply::Status(status) => {
                        let _ = write!(
                            stream,
                            "HTTP/1.1 {status} X\r\nlocation: http://127.0.0.1:1/\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
                        );
                    }
                    Reply::Hang => held.push(stream),
                }
            }
        });
        Server { port, seen }
    }

    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }

    fn requests(&self) -> Vec<Seen> {
        // The last request may still be in flight on the server's thread.
        std::thread::sleep(Duration::from_millis(50));
        self.seen.lock().unwrap().clone()
    }
}

fn read_request(stream: &TcpStream) -> Option<Seen> {
    let mut reader = BufReader::new(stream);
    let mut head = String::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).ok()? == 0 {
            return None;
        }
        if line == "\r\n" {
            break;
        }
        head.push_str(&line);
    }
    let length = head
        .lines()
        .find_map(|l| {
            let (name, value) = l.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().ok())?
        })
        .unwrap_or(0);
    let mut body = vec![0; length];
    reader.read_exact(&mut body).ok()?;
    Some(Seen {
        head,
        body: String::from_utf8_lossy(&body).into_owned(),
    })
}
