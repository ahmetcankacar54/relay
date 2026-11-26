//! Port of `tests/oauth-callback-server.test.ts`. Skipped: "main listens on Google's port before
//! it asks for the sign-in address…" (main-process and antigravity-bridge source text).

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use relay_core::oauth_callback_server::{
    CallbackOptions, CallbackPage, callback_html, listen_oauth_callback,
};

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

struct Response {
    status: u16,
    head: String,
    body: String,
}

impl Response {
    fn header(&self, name: &str) -> Option<String> {
        self.head.lines().find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.eq_ignore_ascii_case(name)
                .then(|| value.trim().to_owned())
        })
    }
}

fn fetch(port: u16, path: &str) -> std::io::Result<Response> {
    let mut stream = TcpStream::connect(("127.0.0.1", port))?;
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    write!(
        stream,
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    )?;
    let mut text = String::new();
    stream.read_to_string(&mut text)?;
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
    let status = head
        .split(' ')
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    Ok(Response {
        status,
        head: head.to_owned(),
        body: body.to_owned(),
    })
}

#[test]
fn relay_answers_the_redirect_itself_hands_the_address_on_shows_its_own_page_then_stops_listening()
{
    let port = free_port();
    let seen = Arc::new(Mutex::new(Vec::<String>::new()));
    let server = listen_oauth_callback(CallbackOptions {
        port,
        path: "/oauth-callback".into(),
        timeout_ms: 60_000,
        state: Box::new(|| Some("abc12345".into())),
        handle: Box::new({
            let seen = seen.clone();
            move |address| {
                seen.lock().unwrap().push(address.to_owned());
                Ok(CallbackPage {
                    title: "Giriş alındı".into(),
                    body: "Relay’e dönebilirsin <script>".into(),
                })
            }
        }),
    })
    .expect("listening");
    // Anything but the callback path is not answered.
    assert_eq!(fetch(port, "/favicon.ico").unwrap().status, 404);
    let response = fetch(port, "/oauth-callback?state=abc12345&code=4/x").unwrap();
    assert_eq!(response.status, 200);
    assert_eq!(
        response.header("cache-control").as_deref(),
        Some("no-store")
    );
    assert!(response.body.contains("<h1>Giriş alındı</h1>"));
    // Text is escaped, never markup.
    assert!(
        response
            .body
            .contains("Relay’e dönebilirsin &lt;script&gt;")
    );
    assert!(!response.body.contains("Authentication successful"));
    assert_eq!(
        *seen.lock().unwrap(),
        [format!(
            "http://localhost:{port}/oauth-callback?state=abc12345&code=4/x"
        )]
    );
    // One sign-in, one callback: the port is free again shortly after.
    std::thread::sleep(Duration::from_millis(700));
    assert!(fetch(port, "/oauth-callback?state=again").is_err());
    server.close();
}

#[test]
fn a_taken_port_is_left_alone_so_the_helper_s_own_forwarder_can_take_the_redirect() {
    let blocker = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = blocker.local_addr().unwrap().port();
    let server = listen_oauth_callback(CallbackOptions {
        port,
        path: "/oauth-callback".into(),
        timeout_ms: 1_000,
        state: Box::new(|| Some("s".into())),
        handle: Box::new(|_| Ok(CallbackPage::default())),
    });
    assert!(server.is_none());
    drop(blocker);
}

#[test]
fn a_failed_hand_off_still_answers_the_browser_with_relay_s_page() {
    let port = free_port();
    let server = listen_oauth_callback(CallbackOptions {
        port,
        path: "/oauth-callback".into(),
        timeout_ms: 60_000,
        state: Box::new(|| Some("x".into())),
        handle: Box::new(|_| Err("boom".into())),
    });
    let response = fetch(port, "/oauth-callback?state=x").unwrap();
    assert_eq!(response.status, 200);
    assert!(!response.body.contains("boom"));
    if let Some(server) = server {
        server.close();
    }
}

#[test]
fn a_redirect_with_another_sign_in_s_state_or_none_pending_gets_400_and_the_real_one_is_still_taken()
 {
    let port = free_port();
    let pending = Arc::new(Mutex::new(None::<String>));
    let seen = Arc::new(Mutex::new(Vec::<String>::new()));
    let server = listen_oauth_callback(CallbackOptions {
        port,
        path: "/oauth-callback".into(),
        timeout_ms: 60_000,
        state: Box::new({
            let pending = pending.clone();
            move || pending.lock().unwrap().clone()
        }),
        handle: Box::new({
            let seen = seen.clone();
            move |address| {
                seen.lock().unwrap().push(address.to_owned());
                Ok(CallbackPage {
                    title: "Signed in".into(),
                    body: String::new(),
                })
            }
        }),
    })
    .expect("listening");
    // Before the helper named the sign-in, nothing is taken.
    assert_eq!(
        fetch(port, "/oauth-callback?state=good1234&code=c")
            .unwrap()
            .status,
        400
    );
    *pending.lock().unwrap() = Some("good1234".into());
    assert_eq!(
        fetch(port, "/oauth-callback?state=evil1234&code=c")
            .unwrap()
            .status,
        400
    );
    assert_eq!(fetch(port, "/oauth-callback?code=c").unwrap().status, 400);
    assert!(seen.lock().unwrap().is_empty());
    let response = fetch(port, "/oauth-callback?state=good1234&code=c").unwrap();
    assert_eq!(response.status, 200);
    assert_eq!(
        *seen.lock().unwrap(),
        [format!(
            "http://localhost:{port}/oauth-callback?state=good1234&code=c"
        )]
    );
    server.close();
}

#[test]
fn the_page_follows_the_system_appearance_and_closes_itself() {
    let html = callback_html(&CallbackPage {
        title: "Signed in".into(),
        body: "You can go back to Relay.".into(),
    });
    assert!(html.contains("color-scheme:light dark"));
    assert!(html.contains("window.close()"));
}
