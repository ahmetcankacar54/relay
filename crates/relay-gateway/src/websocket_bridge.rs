//! Bridges a client's WebSocket upgrade to the Codex Responses WebSocket
//! (`websocket-bridge.ts`): the upgrade request goes upstream as raw HTTP with the account's
//! credential, the upstream's answer comes back, and after a 101 the two sockets are piped.

use crate::client_res::ResponseBody;
use crate::upstream_common::{parse_request_url, tls_config};
use bytes::{Bytes, BytesMut};
use http::{HeaderMap, HeaderName, HeaderValue, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use reqwest::Url;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::task::AbortHandle;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const IDLE_TIMEOUT: Duration = Duration::from_secs(60);
/// The upstream's answer head is small; anything longer is not an HTTP answer.
const MAX_HEAD: usize = 64 * 1024;
/// A refused upgrade's body is kept up to this size.
const MAX_REFUSAL_BODY: usize = 1024 * 1024;

pub struct WebSocketBridgeOptions {
    pub upstream_url: String,
    pub token: Option<String>,
    /// The ChatGPT account a Codex sign-in belongs to; its backend expects it with the token.
    pub chatgpt_account_id: Option<String>,
}

/// An upgrade answered with a plain HTTP error; the connection closes after it.
pub fn reject_upgrade(status: u16, _text: &str) -> Response<ResponseBody> {
    let mut response = Response::new(ResponseBody::empty());
    *response.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY);
    response
        .headers_mut()
        .insert(http::header::CONNECTION, HeaderValue::from_static("close"));
    response
        .headers_mut()
        .insert(http::header::CONTENT_LENGTH, HeaderValue::from_static("0"));
    response
}

trait Stream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Stream for T {}

#[derive(Default)]
pub struct WebSocketBridge {
    bridges: Arc<Mutex<HashMap<u64, AbortHandle>>>,
    next: AtomicU64,
}

impl WebSocketBridge {
    pub fn new() -> Self {
        Self::default()
    }

    /// Open bridges (both sides of each).
    pub fn open_sockets(&self) -> usize {
        self.bridges.lock().unwrap().len() * 2
    }

    /// Drops every bridged connection, e.g. when the gateway stops.
    pub fn close_all(&self) {
        for (_, handle) in self.bridges.lock().unwrap().drain() {
            handle.abort();
        }
    }

    /// Opens the upstream side of an upgrade and answers the client with what the upstream
    /// said; after a 101 the sockets are piped. `None`: the upstream hung up before answering,
    /// and the client's connection is dropped as well.
    pub async fn handle_upgrade<B: Send + 'static>(
        &self,
        mut request: Request<B>,
        options: WebSocketBridgeOptions,
    ) -> Option<Response<ResponseBody>> {
        let Ok(client) = parse_request_url(request.uri().path_and_query().map(|p| p.as_str()))
        else {
            return Some(reject_upgrade(400, "Bad Request"));
        };
        let Ok(target) = Url::parse(&options.upstream_url) else {
            return Some(reject_upgrade(502, "Bad Gateway"));
        };
        let tls = matches!(target.scheme(), "wss" | "https");
        let port = target.port().unwrap_or(if tls { 443 } else { 80 });
        let hostname = target
            .host_str()
            .unwrap_or("")
            .trim_start_matches('[')
            .trim_end_matches(']')
            .to_string();
        let host_header = match target.port() {
            Some(port) => format!("{}:{port}", target.host_str().unwrap_or("")),
            None => target.host_str().unwrap_or("").to_string(),
        };

        let mut headers = request.headers().clone();
        // The client's credential and Relay's own headers never reach the provider.
        for name in [
            "x-api-key",
            "authorization",
            "x-relay-key",
            "x-relay-provider",
            "chatgpt-account-id",
        ] {
            headers.remove(name);
        }
        if let Ok(value) = HeaderValue::from_str(&host_header) {
            headers.insert(http::header::HOST, value);
        }
        if let Some(Ok(value)) = options.chatgpt_account_id.as_deref().map(HeaderValue::from_str) {
            headers.insert("chatgpt-account-id", value);
        }
        if let Some(Ok(value)) = options
            .token
            .as_deref()
            .map(|t| HeaderValue::from_str(&format!("Bearer {t}")))
        {
            headers.insert(http::header::AUTHORIZATION, value);
        }

        let mut upstream = match tokio::time::timeout(CONNECT_TIMEOUT, connect(&hostname, port, tls)).await {
            Ok(Ok(stream)) => stream,
            // Before the upstream answers, the client is owed an HTTP error.
            _ => return Some(reject_upgrade(502, "Bad Gateway")),
        };

        let mut raw = format!(
            "{} {}{} HTTP/1.1\r\n",
            request.method(),
            target.path(),
            client.search
        )
        .into_bytes();
        for (name, value) in &headers {
            raw.extend_from_slice(name.as_str().as_bytes());
            raw.extend_from_slice(b": ");
            raw.extend_from_slice(value.as_bytes());
            raw.extend_from_slice(b"\r\n");
        }
        raw.extend_from_slice(b"\r\n");
        if upstream.write_all(&raw).await.is_err() {
            return None;
        }

        let (status, answer_headers, rest) = read_head(&mut upstream).await?;
        if status != 101 {
            return Some(refusal(status, answer_headers, rest, upstream).await);
        }

        let on_upgrade = hyper::upgrade::on(&mut request);
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let bridges = self.bridges.clone();
        let mut list = self.bridges.lock().unwrap();
        let task = tokio::spawn(async move {
            if let Ok(upgraded) = on_upgrade.await {
                let mut client = TokioIo::new(upgraded);
                if rest.is_empty() || client.write_all(&rest).await.is_ok() {
                    pipe(&mut client, &mut upstream).await;
                }
            }
            bridges.lock().unwrap().remove(&id);
        });
        list.insert(id, task.abort_handle());
        drop(list);

        let mut response = Response::new(ResponseBody::empty());
        *response.status_mut() = StatusCode::SWITCHING_PROTOCOLS;
        *response.headers_mut() = answer_headers;
        Some(response)
    }
}

async fn connect(hostname: &str, port: u16, tls: bool) -> std::io::Result<Box<dyn Stream>> {
    let tcp = TcpStream::connect((hostname, port)).await?;
    if !tls {
        return Ok(Box::new(tcp));
    }
    let name = rustls::pki_types::ServerName::try_from(hostname.to_string())
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidInput, e))?;
    let connector = tokio_rustls::TlsConnector::from(Arc::new(tls_config()));
    Ok(Box::new(connector.connect(name, tcp).await?))
}

/// The upstream's answer head: status, headers, and whatever bytes came after it.
async fn read_head(upstream: &mut Box<dyn Stream>) -> Option<(u16, HeaderMap, Bytes)> {
    let mut buffer = BytesMut::with_capacity(4096);
    loop {
        let read = tokio::time::timeout(IDLE_TIMEOUT, upstream.read_buf(&mut buffer))
            .await
            .ok()?
            .ok()?;
        if read == 0 {
            return None;
        }
        let mut slots = [httparse::EMPTY_HEADER; 128];
        let mut answer = httparse::Response::new(&mut slots);
        match answer.parse(&buffer) {
            Ok(httparse::Status::Complete(length)) => {
                let status = answer.code?;
                let mut headers = HeaderMap::new();
                for h in answer.headers.iter() {
                    if let (Ok(name), Ok(value)) = (
                        HeaderName::from_bytes(h.name.as_bytes()),
                        HeaderValue::from_bytes(h.value),
                    ) {
                        headers.append(name, value);
                    }
                }
                return Some((status, headers, buffer.split_off(length).freeze()));
            }
            Ok(httparse::Status::Partial) if buffer.len() < MAX_HEAD => {}
            _ => return None,
        }
    }
}

/// A refused upgrade: the upstream's status, headers and body, then the connection closes.
async fn refusal(
    status: u16,
    mut headers: HeaderMap,
    rest: Bytes,
    mut upstream: Box<dyn Stream>,
) -> Response<ResponseBody> {
    let mut body = BytesMut::from(&rest[..]);
    let length = headers
        .get(http::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<usize>().ok());
    let chunked = headers
        .get(http::header::TRANSFER_ENCODING)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.to_ascii_lowercase().contains("chunked"));
    loop {
        if length.is_some_and(|n| body.len() >= n)
            || (chunked && chunked_complete(&body))
            || body.len() >= MAX_REFUSAL_BODY
        {
            break;
        }
        match tokio::time::timeout(IDLE_TIMEOUT, upstream.read_buf(&mut body)).await {
            Ok(Ok(n)) if n > 0 => {}
            _ => break,
        }
    }
    let mut body = body.freeze();
    if let Some(n) = length {
        body.truncate(n);
    } else if chunked {
        body = dechunk(&body);
    }
    for name in [
        http::header::TRANSFER_ENCODING,
        http::header::CONNECTION,
        http::header::CONTENT_LENGTH,
    ] {
        headers.remove(name);
    }
    headers.insert(http::header::CONNECTION, HeaderValue::from_static("close"));
    let mut response = Response::new(ResponseBody::full(body));
    *response.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY);
    *response.headers_mut() = headers;
    response
}

/// Walks a chunked body: `Some(decoded)` once its last chunk arrived.
fn walk_chunks(raw: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut at = 0;
    loop {
        let line_end = raw[at..].windows(2).position(|w| w == b"\r\n")? + at;
        let size_text = std::str::from_utf8(&raw[at..line_end]).ok()?;
        let size = usize::from_str_radix(size_text.split(';').next()?.trim(), 16).ok()?;
        at = line_end + 2;
        if size == 0 {
            return Some(out);
        }
        if raw.len() < at + size + 2 {
            return None;
        }
        out.extend_from_slice(&raw[at..at + size]);
        at += size + 2;
    }
}

fn chunked_complete(raw: &[u8]) -> bool {
    walk_chunks(raw).is_some()
}

fn dechunk(raw: &[u8]) -> Bytes {
    walk_chunks(raw).map(Bytes::from).unwrap_or_default()
}

/// Copies both ways until either side closes or nothing moves for a minute.
async fn pipe<C: AsyncRead + AsyncWrite + Unpin>(client: &mut C, upstream: &mut Box<dyn Stream>) {
    let mut from_client = vec![0u8; 16 * 1024];
    let mut from_upstream = vec![0u8; 16 * 1024];
    loop {
        tokio::select! {
            read = client.read(&mut from_client) => match read {
                Ok(n) if n > 0 => {
                    if upstream.write_all(&from_client[..n]).await.is_err() {
                        break;
                    }
                }
                _ => break,
            },
            read = upstream.read(&mut from_upstream) => match read {
                Ok(n) if n > 0 => {
                    if client.write_all(&from_upstream[..n]).await.is_err() {
                        break;
                    }
                }
                _ => break,
            },
            () = tokio::time::sleep(IDLE_TIMEOUT) => break,
        }
    }
    let _ = upstream.shutdown().await;
    let _ = client.shutdown().await;
}
