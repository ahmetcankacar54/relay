//! The client's side of one request, as Node's `http.ServerResponse` is to the TypeScript
//! gateway: the answer's head goes to hyper once (`writeHead`), its body streams through a
//! channel, and either side can tell when the client has gone.

use bytes::Bytes;
use http::{HeaderValue, Response, StatusCode, header};
use http_body::{Body, Frame, SizeHint};
use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};
use tokio::sync::{mpsc, oneshot};

/// Frames buffered between the upstream reader and hyper; the rest waits (back-pressure).
const CHANNEL_FRAMES: usize = 8;

/// The answer body hyper sends: a whole buffer, or a stream that can be cut.
pub enum ResponseBody {
    Full(Option<Bytes>),
    Stream {
        rx: mpsc::Receiver<Bytes>,
        abort: Option<oneshot::Receiver<()>>,
    },
}

impl ResponseBody {
    pub fn empty() -> Self {
        ResponseBody::Full(None)
    }

    pub fn full(bytes: impl Into<Bytes>) -> Self {
        let bytes = bytes.into();
        ResponseBody::Full((!bytes.is_empty()).then_some(bytes))
    }
}

impl Body for ResponseBody {
    type Data = Bytes;
    type Error = io::Error;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, io::Error>>> {
        match self.get_mut() {
            ResponseBody::Full(bytes) => Poll::Ready(bytes.take().map(|b| Ok(Frame::data(b)))),
            ResponseBody::Stream { rx, abort } => {
                if let Some(signal) = abort.as_mut() {
                    match Pin::new(signal).poll(cx) {
                        // Cut: the client sees a broken answer, not a clean end.
                        Poll::Ready(Ok(())) => {
                            *abort = None;
                            return Poll::Ready(Some(Err(io::Error::new(
                                io::ErrorKind::ConnectionAborted,
                                "the upstream answer was cut",
                            ))));
                        }
                        Poll::Ready(Err(_)) => *abort = None,
                        Poll::Pending => {}
                    }
                }
                rx.poll_recv(cx)
                    .map(|chunk| chunk.map(|b| Ok(Frame::data(b))))
            }
        }
    }

    fn is_end_stream(&self) -> bool {
        matches!(self, ResponseBody::Full(None))
    }

    fn size_hint(&self) -> SizeHint {
        match self {
            ResponseBody::Full(bytes) => {
                SizeHint::with_exact(bytes.as_ref().map_or(0, |b| b.len() as u64))
            }
            ResponseBody::Stream { .. } => SizeHint::default(),
        }
    }
}

enum State {
    /// Nothing sent yet.
    Pending(oneshot::Sender<Response<ResponseBody>>),
    /// The head went out; the body streams.
    Streaming {
        tx: mpsc::Sender<Bytes>,
        abort: oneshot::Sender<()>,
    },
    /// The whole answer was handed over (or the stream was let end).
    Ended,
    /// The client left, or the answer was cut.
    Destroyed,
}

/// One request's answer to its client.
pub struct ClientRes {
    state: State,
}

impl ClientRes {
    /// A response handle and the receiver hyper's service waits on for the head.
    pub fn new() -> (Self, oneshot::Receiver<Response<ResponseBody>>) {
        let (tx, rx) = oneshot::channel();
        (
            ClientRes {
                state: State::Pending(tx),
            },
            rx,
        )
    }

    /// `res.headersSent`.
    pub fn headers_sent(&self) -> bool {
        !matches!(self.state, State::Pending(_))
    }

    /// `res.writableEnded`: the answer was handed over whole (or ended).
    pub fn ended(&self) -> bool {
        matches!(self.state, State::Ended)
    }

    /// `res.destroyed`: the client went away or the answer was cut.
    pub fn destroyed(&mut self) -> bool {
        let gone = match &self.state {
            State::Pending(tx) => tx.is_closed(),
            State::Streaming { tx, .. } => tx.is_closed(),
            State::Ended => false,
            State::Destroyed => true,
        };
        if gone {
            self.state = State::Destroyed;
        }
        gone
    }

    /// Resolves once the client has gone (never, after the answer ended).
    pub async fn closed(&mut self) {
        match &mut self.state {
            State::Pending(tx) => tx.closed().await,
            State::Streaming { tx, .. } => tx.closed().await,
            State::Ended => std::future::pending().await,
            State::Destroyed => {}
        }
    }

    /// Sends a whole answer (`writeHead` + `end`); ignored once anything was sent.
    pub fn send(&mut self, response: Response<ResponseBody>) {
        if !matches!(self.state, State::Pending(_)) {
            return;
        }
        if let State::Pending(tx) = std::mem::replace(&mut self.state, State::Ended) {
            if tx.send(response).is_err() {
                self.state = State::Destroyed;
            }
        }
    }

    /// Sends the head of a streamed answer; false when the client has gone or a head was sent.
    pub fn start(&mut self, head: Response<()>) -> bool {
        if !matches!(self.state, State::Pending(_)) {
            return false;
        }
        let State::Pending(head_tx) = std::mem::replace(&mut self.state, State::Destroyed) else {
            return false;
        };
        let (tx, rx) = mpsc::channel(CHANNEL_FRAMES);
        let (abort_tx, abort_rx) = oneshot::channel();
        let (parts, ()) = head.into_parts();
        let body = ResponseBody::Stream {
            rx,
            abort: Some(abort_rx),
        };
        if head_tx.send(Response::from_parts(parts, body)).is_err() {
            return false;
        }
        self.state = State::Streaming {
            tx,
            abort: abort_tx,
        };
        true
    }

    /// Writes one chunk of a streamed answer; false when the client has gone.
    pub async fn write(&mut self, chunk: Bytes) -> bool {
        let State::Streaming { tx, .. } = &self.state else {
            return false;
        };
        if tx.send(chunk).await.is_err() {
            self.state = State::Destroyed;
            return false;
        }
        true
    }

    /// Lets a streamed answer end cleanly (`res.end()`).
    pub fn end(&mut self) {
        if matches!(self.state, State::Streaming { .. }) {
            self.state = State::Ended;
        }
    }

    /// Cuts the answer (`res.destroy()`): a stream the client sees fail, or no answer at all.
    pub fn destroy(&mut self) {
        if let State::Streaming { abort, .. } = std::mem::replace(&mut self.state, State::Destroyed)
        {
            let _ = abort.send(());
        }
    }
}

/// A JSON error body both Anthropic and OpenAI style clients can read.
pub fn json_error_response(
    status: u16,
    kind: &str,
    message: &str,
    extra: &[(&str, &str)],
) -> Response<ResponseBody> {
    let body =
        serde_json::json!({ "type": "error", "error": { "type": kind, "message": message } })
            .to_string();
    let mut response = Response::new(ResponseBody::Full(None));
    *response.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY);
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(body.len()));
    for (name, value) in extra {
        if let (Ok(name), Ok(value)) = (
            http::HeaderName::from_bytes(name.as_bytes()),
            HeaderValue::from_str(value),
        ) {
            headers.insert(name, value);
        }
    }
    *response.body_mut() = ResponseBody::full(body);
    response
}

/// `sendJsonError`: ignored once the answer began, ended, or the client left.
pub fn send_json_error(
    res: &mut ClientRes,
    status: u16,
    kind: &str,
    message: &str,
    extra: &[(&str, &str)],
) {
    if res.headers_sent() || res.destroyed() || res.ended() {
        return;
    }
    res.send(json_error_response(status, kind, message, extra));
}

/// A JSON answer (`res.writeHead(status, {"Content-Type": "application/json"}); res.end(body)`);
/// a HEAD request gets the head only.
pub fn json_response(status: u16, body: Option<String>) -> Response<ResponseBody> {
    let mut response = Response::new(match body {
        Some(text) => ResponseBody::full(text),
        None => ResponseBody::empty(),
    });
    *response.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::OK);
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    response
}
