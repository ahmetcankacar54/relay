//! Test helpers of the platform slice: a local HTTP server standing in for remote hosts.
#![allow(dead_code)]

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;

/// One request the server saw.
#[derive(Debug, Clone, Default)]
pub struct Seen {
    pub method: String,
    pub url: String,
    /// Lower-cased names.
    pub headers: HashMap<String, String>,
    pub body: String,
}

/// What the server answers: a status, extra headers and a body.
pub struct Reply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Reply {
    pub fn json(status: u16, body: impl Into<String>) -> Reply {
        Reply {
            status,
            headers: vec![("content-type".into(), "application/json".into())],
            body: body.into().into_bytes(),
        }
    }
    pub fn bytes(status: u16, body: impl Into<Vec<u8>>) -> Reply {
        Reply {
            status,
            headers: Vec::new(),
            body: body.into(),
        }
    }
}

pub type Handler = Arc<dyn Fn(&Seen) -> Reply + Send + Sync>;

/// A server on 127.0.0.1 that answers by `handler` and records every request.
pub struct TestServer {
    pub port: u16,
    pub seen: Arc<Mutex<Vec<Seen>>>,
}

impl TestServer {
    pub fn start(handler: impl Fn(&Seen) -> Reply + Send + Sync + 'static) -> TestServer {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let handler: Handler = Arc::new(handler);
        let log = seen.clone();
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { break };
                let handler = handler.clone();
                let log = log.clone();
                thread::spawn(move || serve(stream, &handler, &log));
            }
        });
        TestServer { port, seen }
    }

    pub fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }

    pub fn seen(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }
}

fn serve(stream: TcpStream, handler: &Handler, log: &Mutex<Vec<Seen>>) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut line = String::new();
    if reader.read_line(&mut line).unwrap_or(0) == 0 {
        return;
    }
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("").to_owned();
    let url = parts.next().unwrap_or("").to_owned();
    let mut headers = HashMap::new();
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header).unwrap_or(0) == 0 {
            break;
        }
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            headers.insert(name.trim().to_lowercase(), value.trim().to_owned());
        }
    }
    let length: usize = headers
        .get("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let mut body = vec![0u8; length];
    let _ = reader.read_exact(&mut body);
    let request = Seen {
        method,
        url,
        headers,
        body: String::from_utf8_lossy(&body).into_owned(),
    };
    log.lock().unwrap().push(request.clone());
    let reply = handler(&request);
    let mut out = stream;
    let mut head = format!(
        "HTTP/1.1 {} X\r\nContent-Length: {}\r\nConnection: close\r\n",
        reply.status,
        reply.body.len()
    );
    for (name, value) in &reply.headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    let _ = out.write_all(head.as_bytes());
    let _ = out.write_all(&reply.body);
    let _ = out.flush();
}

/// A temporary folder, removed when dropped; its real path (macOS's /var is a link).
pub fn temp(prefix: &str) -> tempfile::TempDir {
    tempfile::Builder::new().prefix(prefix).tempdir().unwrap()
}

pub fn real(dir: &tempfile::TempDir) -> std::path::PathBuf {
    std::fs::canonicalize(dir.path()).unwrap()
}
