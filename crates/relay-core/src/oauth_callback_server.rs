//! Relay's own answer on an OAuth redirect port (Antigravity's Google client returns to
//! localhost:51121/oauth-callback). Listening here instead of CLIProxyAPI keeps the browser out
//! of the helper's "Authentication successful!" page: Relay hands the address on, shows a short
//! page of its own and comes to the front. Loopback only; one sign-in at a time.

use std::io::{ErrorKind, Read, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CallbackPage {
    pub title: String,
    pub body: String,
}

fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

/// A plain page in the system font that follows the light or dark appearance.
pub fn callback_html(page: &CallbackPage) -> String {
    let title = escape(&page.title);
    let body = escape(&page.body);
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>{title}</title><style>:root{{color-scheme:light dark}}body{{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 -apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;background:Canvas;color:CanvasText}}main{{max-width:26rem;padding:2rem;text-align:center}}h1{{font-size:1.25rem;font-weight:600;margin:0 0 .5rem}}p{{margin:0;opacity:.7}}</style></head><body><main><h1>{title}</h1><p>{body}</p></main><script>setTimeout(function(){{window.close()}},1500)</script></body></html>"
    )
}

/// Gets the full callback address; answers the page the browser shows.
pub type HandleCallback = dyn Fn(&str) -> Result<CallbackPage, String> + Send + Sync;

pub struct CallbackOptions {
    pub port: u16,
    pub path: String,
    /// The pending sign-in's state; `None` while none is pending.
    pub state: Box<dyn Fn() -> Option<String> + Send + Sync>,
    /// Gets the full address; its page answers the browser. An error shows a bare Relay page.
    pub handle: Box<HandleCallback>,
    pub timeout_ms: u64,
}

/// A listening callback server; it stops by itself after a handled callback or its timeout.
pub struct CallbackServer {
    port: u16,
    closing: Arc<AtomicBool>,
}

impl CallbackServer {
    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn close(&self) {
        self.closing.store(true, Ordering::SeqCst);
    }
}

/// How often the accept loop looks for a connection or a close.
const ACCEPT_POLL: Duration = Duration::from_millis(20);
/// How long after a handled callback the server stops: the answer goes out first.
const CLOSE_AFTER: Duration = Duration::from_millis(500);
const MAX_HEAD: usize = 16 * 1024;

/// Listens on 127.0.0.1:<port> for <path>. `None` when the port is taken, so the caller can fall
/// back to another way back. Only a callback whose `state` is the pending sign-in's is handled;
/// any other gets 400 and the server keeps waiting. It closes itself after a handled callback
/// and after `timeout_ms`.
pub fn listen_oauth_callback(options: CallbackOptions) -> Option<CallbackServer> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, options.port)).ok()?;
    listener.set_nonblocking(true).ok()?;
    let port = options.port;
    let closing = Arc::new(AtomicBool::new(false));
    let handled = Arc::new(AtomicBool::new(false));
    let options = Arc::new(options);
    let deadline = Instant::now() + Duration::from_millis(options.timeout_ms);
    {
        let closing = closing.clone();
        thread::spawn(move || {
            while !closing.load(Ordering::SeqCst) && Instant::now() < deadline {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let (options, handled, closing) =
                            (options.clone(), handled.clone(), closing.clone());
                        thread::spawn(move || serve(stream, &options, &handled, &closing));
                    }
                    Err(error) if error.kind() == ErrorKind::WouldBlock => {
                        thread::sleep(ACCEPT_POLL)
                    }
                    Err(_) => thread::sleep(ACCEPT_POLL),
                }
            }
        });
    }
    Some(CallbackServer { port, closing })
}

/// The request line's method and target; `None` for anything that is not HTTP.
fn read_request(stream: &mut TcpStream) -> Option<(String, String)> {
    stream.set_nonblocking(false).ok()?;
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .ok()?;
    let mut head = Vec::new();
    let mut chunk = [0u8; 2048];
    while !head.windows(4).any(|w| w == b"\r\n\r\n") {
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 || head.len() > MAX_HEAD {
            return None;
        }
        head.extend_from_slice(&chunk[..n]);
    }
    let text = String::from_utf8_lossy(&head);
    let mut line = text.lines().next()?.split(' ');
    Some((line.next()?.to_owned(), line.next()?.to_owned()))
}

fn respond(stream: &mut TcpStream, status: &str, headers: &[(&str, &str)], body: &str) {
    let mut out = format!("HTTP/1.1 {status}\r\n");
    for (name, value) in headers {
        out.push_str(&format!("{name}: {value}\r\n"));
    }
    out.push_str(&format!(
        "content-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    ));
    let _ = stream.write_all(out.as_bytes());
    let _ = stream.flush();
}

fn serve(
    mut stream: TcpStream,
    options: &CallbackOptions,
    handled: &AtomicBool,
    closing: &Arc<AtomicBool>,
) {
    let Some((method, target)) = read_request(&mut stream) else {
        return;
    };
    let url = url::Url::parse(&format!("http://localhost:{}", options.port))
        .and_then(|base| base.join(&target))
        .ok();
    let Some(url) = url.filter(|url| {
        method == "GET" && url.path() == options.path && !handled.load(Ordering::SeqCst)
    }) else {
        respond(
            &mut stream,
            "404 Not Found",
            &[("content-type", "text/plain")],
            "Not found",
        );
        return;
    };
    let given = url
        .query_pairs()
        .find(|(key, _)| key == "state")
        .map(|(_, value)| value.into_owned());
    match (options.state)() {
        Some(expected) if given.as_deref() == Some(expected.as_str()) => {}
        _ => {
            respond(
                &mut stream,
                "400 Bad Request",
                &[("content-type", "text/plain")],
                "Not this sign-in",
            );
            return;
        }
    }
    if handled.swap(true, Ordering::SeqCst) {
        respond(
            &mut stream,
            "404 Not Found",
            &[("content-type", "text/plain")],
            "Not found",
        );
        return;
    }
    let page = (options.handle)(url.as_str()).unwrap_or_else(|_| CallbackPage {
        title: "Relay".into(),
        body: String::new(),
    });
    respond(
        &mut stream,
        "200 OK",
        &[
            ("content-type", "text/html; charset=utf-8"),
            ("cache-control", "no-store"),
            ("referrer-policy", "no-referrer"),
        ],
        &callback_html(&page),
    );
    thread::sleep(CLOSE_AFTER);
    closing.store(true, Ordering::SeqCst);
}
