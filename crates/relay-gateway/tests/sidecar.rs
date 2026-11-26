//! The `relay __gateway` protocol (Phase 3.1), in process over pipes and once as a process.

mod common;

use common::*;
use relay_gateway::sidecar::run_sidecar;
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, Lines};

/// A sidecar on in-memory pipes, as the parent sees it.
struct Child {
    input: Option<DuplexStream>,
    output: Lines<BufReader<DuplexStream>>,
    /// Messages read while waiting for another kind.
    seen: VecDeque<Value>,
    task: tokio::task::JoinHandle<i32>,
}

impl Child {
    fn spawn() -> Child {
        let (parent_in, child_in) = tokio::io::duplex(1 << 16);
        let (child_out, parent_out) = tokio::io::duplex(1 << 16);
        let task = tokio::spawn(run_sidecar(BufReader::new(child_in), child_out));
        Child {
            input: Some(parent_in),
            output: BufReader::new(parent_out).lines(),
            seen: VecDeque::new(),
            task,
        }
    }

    async fn send(&mut self, message: Value) {
        let input = self.input.as_mut().unwrap();
        input
            .write_all(format!("{message}\n").as_bytes())
            .await
            .unwrap();
    }

    /// The next message of a kind (others are kept for later).
    async fn next(&mut self, kind: &str) -> Value {
        self.next_matching(kind, |_| true).await
    }

    async fn next_matching(&mut self, kind: &str, accept: impl Fn(&Value) -> bool) -> Value {
        if let Some(at) = self.seen.iter().position(|m| m["t"] == kind && accept(m)) {
            return self.seen.remove(at).unwrap();
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            let line = tokio::time::timeout_at(deadline, self.output.next_line())
                .await
                .unwrap_or_else(|_| panic!("no {kind} message; seen {:?}", self.seen))
                .unwrap()
                .unwrap_or_else(|| panic!("the sidecar closed its output waiting for {kind}"));
            let message: Value = serde_json::from_str(&line).unwrap();
            if message["t"] == kind && accept(&message) {
                return message;
            }
            self.seen.push_back(message);
        }
    }

    /// Closes stdin and waits for the exit code.
    async fn close(mut self) -> i32 {
        self.input.take();
        tokio::time::timeout(Duration::from_secs(5), self.task)
            .await
            .expect("the sidecar exits when stdin closes")
            .unwrap()
    }
}

fn configured(upstream: &str, extra: Value) -> Value {
    let mut config = json!({
        "port": 0,
        "host": "127.0.0.1",
        "enabled": true,
        "upstreams": { "anthropicUrl": upstream },
    });
    for (key, value) in extra.as_object().unwrap() {
        config[key] = value.clone();
    }
    json!({ "t": "config", "config": config })
}

fn pool() -> Value {
    json!({ "t": "usage", "accounts": [{ "id": "a", "name": "Alto", "kind": "personal", "group": "default", "color": "#000", "createdAt": "2026-11-01T00:00:00.000Z" }], "usage": {} })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_sidecar_starts_asks_for_a_sign_in_serves_with_it_and_reports_status_sessions_and_evictions()
 {
    let upstream = FakeUpstream::sync(|_| ok_reply()).await;
    let mut child = Child::spawn();
    child
        .send(configured(
            &upstream.url,
            json!({ "sessionsIntervalMs": 50 }),
        ))
        .await;
    child.send(pool()).await;
    let ready = child.next("ready").await;
    let port = ready["port"].as_u64().unwrap() as u16;
    assert!(port > 0);

    let answer = tokio::spawn(async move {
        request(
            port,
            "POST",
            "/v1/messages",
            &[("x-claude-code-session-id", "s-1")],
            "{}",
        )
        .await
    });
    let need = child.next("need-credential").await;
    assert_eq!(need["accountId"], "a");
    child
        .send(json!({ "t": "credential", "id": need["id"], "value": { "accessToken": "tok-a" } }))
        .await;
    assert_eq!(answer.await.unwrap().status, 200);
    assert_eq!(upstream.tokens(), ["tok-a"]);
    let logged = child.next("request-log").await;
    assert_eq!(logged["entry"]["accountId"], "a");
    assert_eq!(logged["entry"]["status"], 200);

    child.send(json!({ "t": "status", "id": 7 })).await;
    let reply = child.next("status-reply").await;
    assert_eq!(reply["id"], 7);
    let status = &reply["status"];
    assert_eq!(status["ok"], true);
    assert_eq!(status["state"]["status"], "running");
    assert_eq!(status["state"]["port"], port);
    assert_eq!(status["metrics"]["totalRequests"], 1);
    assert_eq!(status["recent"][0]["accountId"], "a");
    assert_eq!(status["nextPick"]["claude"]["accountId"], "a");

    // The session cache comes every interval; evicting the account empties it.
    let bound = child
        .next_matching("sessions", |m| {
            m["list"].as_array().is_some_and(|l| !l.is_empty())
        })
        .await;
    assert_eq!(bound["list"][0]["sessionKey"], "hdr:s-1");
    assert_eq!(bound["list"][0]["accountId"], "a");
    child.send(json!({ "t": "evict", "accountId": "a" })).await;
    child
        .next_matching("sessions", |m| {
            m["list"].as_array().is_some_and(|l| l.is_empty())
        })
        .await;

    assert_eq!(child.close().await, 0);
    // The gateway went with it.
    assert!(
        tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_err()
    );
    upstream.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_sign_in_the_parent_never_answers_counts_as_none() {
    let upstream = FakeUpstream::sync(|_| ok_reply()).await;
    let mut child = Child::spawn();
    child
        .send(configured(&upstream.url, json!({ "replyTimeoutMs": 100 })))
        .await;
    child.send(pool()).await;
    let port = child.next("ready").await["port"].as_u64().unwrap() as u16;
    let answer = request(port, "POST", "/v1/messages", &[], "{}").await;
    assert_eq!(answer.status, 401);
    assert!(answer.body.contains("Relay cannot use the sign-in of Alto"));
    assert_eq!(child.next("credential-missing").await["accountId"], "a");
    assert_eq!(upstream.count(), 0);
    assert_eq!(child.close().await, 0);
    upstream.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_taken_port_is_reported_as_eaddrinuse_and_a_new_config_can_start_it_elsewhere() {
    let taken = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let port = taken.local_addr().unwrap().port();
    let mut child = Child::spawn();
    child
        .send(configured("http://127.0.0.1:9", json!({ "port": port })))
        .await;
    let error = child.next("error").await;
    assert_eq!(error["code"], "EADDRINUSE");
    assert!(error["message"].as_str().unwrap().contains("EADDRINUSE"));
    child.send(json!({ "t": "status", "id": 1 })).await;
    assert_eq!(child.next("status-reply").await["status"], Value::Null);
    child
        .send(configured("http://127.0.0.1:9", json!({})))
        .await;
    assert!(child.next("ready").await["port"].as_u64().unwrap() > 0);
    child.send(json!({ "t": "stop" })).await;
    assert_eq!(child.close().await, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn closing_stdin_ends_the_sidecar_with_code_0() {
    let child = Child::spawn();
    assert_eq!(child.close().await, 0);
}

/// The example binary, built next to the test binaries by `cargo test`.
fn example_binary() -> std::path::PathBuf {
    let test = std::env::current_exe().unwrap();
    let profile = test.parent().unwrap().parent().unwrap();
    profile
        .join("examples")
        .join(format!("sidecar{}", std::env::consts::EXE_SUFFIX))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_sidecar_runs_as_a_process_on_stdin_and_stdout() {
    let binary = example_binary();
    if !binary.exists() {
        // A filtered run (`--test sidecar`) does not build examples; `cargo test` does.
        let built = std::process::Command::new(env!("CARGO"))
            .args(["build", "-p", "relay-gateway", "--example", "sidecar"])
            .status()
            .unwrap();
        assert!(built.success());
    }
    assert!(binary.exists(), "the example is at {}", binary.display());
    let mut process = tokio::process::Command::new(&binary)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut stdin = process.stdin.take().unwrap();
    let mut stdout = BufReader::new(process.stdout.take().unwrap()).lines();
    stdin
        .write_all(format!("{}\n", configured("http://127.0.0.1:9", json!({}))).as_bytes())
        .await
        .unwrap();
    let line = tokio::time::timeout(Duration::from_secs(10), stdout.next_line())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let ready: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(ready["t"], "ready");
    let port = ready["port"].as_u64().unwrap() as u16;
    assert_eq!(request(port, "GET", "/health", &[], "").await.status, 200);
    drop(stdin);
    let status = tokio::time::timeout(Duration::from_secs(10), process.wait())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(status.code(), Some(0));
}
