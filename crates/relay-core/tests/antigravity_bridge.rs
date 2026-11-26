//! Port of tests/antigravity-bridge.test.ts. The fake CLIProxyAPI is the same Node script as
//! the TS test's; like there, it needs a Unix shebang (skipped on Windows) and Node on PATH.

#![cfg(unix)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::Arc;

use relay_core::antigravity_bridge::{AntigravityBridge, AntigravityOAuthState};

fn node_available() -> bool {
    std::process::Command::new("node")
        .arg("--version")
        .output()
        .is_ok_and(|o| o.status.success())
}

fn fake_proxy(root: &Path, script: &str) -> std::path::PathBuf {
    let fake = root.join("fake-proxy");
    fs::write(&fake, script).unwrap();
    fs::set_permissions(&fake, fs::Permissions::from_mode(0o700)).unwrap();
    fake
}

fn bridge(root: &Path, fake: std::path::PathBuf) -> AntigravityBridge {
    let bridge = AntigravityBridge::new(
        root.join("profile"),
        root.join("tools"),
        Some(Arc::new(move |_: &Path| Ok(fake.clone()))),
    );
    fs::create_dir_all(&bridge.profile_dir).unwrap();
    bridge
}

const FIRST: &str = r#"#!/usr/bin/env node
const fs = require('node:fs');
const http = require('node:http');
const text = fs.readFileSync(process.argv[3], 'utf8');
const port = Number(/  port: (\d+)/.exec(text)[1]);
const authDir = JSON.parse(/  auth-dir: (.*)/.exec(text)[1]);
let count = 0;
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/v1/models') return res.end('{"data":[]}');
  if (req.url.startsWith('/v8/management/oauth/auth-url'))
    return res.end(JSON.stringify({status:'ok', state:'validstate123', url:'https://accounts.google.com/o/oauth2/v2/auth?state=validstate123'}));
  if (req.url.startsWith('/v8/management/oauth/status')) {
    if (++count === 1) return res.end('{"status":"wait"}');
    fs.writeFileSync(authDir + '/antigravity-tester.json', JSON.stringify({type:'antigravity',email:'tester@example.com',refresh_token:'refresh',project_id:'project'}));
    return res.end('{"status":"ok","auth_id":"antigravity-tester.json"}');
  }
  res.statusCode = 404; res.end('{}');
});
server.listen(port, '127.0.0.1');
"#;

#[test]
fn antigravity_oauth_bridge_starts_isolated_waits_for_google_then_accepts_only_a_saved_oauth_credential()
 {
    if !node_available() {
        eprintln!("skipped: the fake CLIProxyAPI is a Node script");
        return;
    }
    let root = tempfile::Builder::new()
        .prefix("relay-antigravity-bridge-")
        .tempdir()
        .unwrap();
    let bridge = bridge(root.path(), fake_proxy(root.path(), FIRST));
    bridge.start().unwrap();
    assert!(
        bridge
            .endpoint()
            .unwrap()
            .url
            .starts_with("http://127.0.0.1:")
    );
    assert!(!bridge.has_credential());
    let (state, url) = bridge.begin_oauth(true).unwrap();
    assert_eq!(
        url::Url::parse(&url).unwrap().host_str(),
        Some("accounts.google.com")
    );
    assert_eq!(
        bridge.poll_oauth(&state).unwrap(),
        AntigravityOAuthState::Wait
    );
    assert_eq!(
        bridge.poll_oauth(&state).unwrap(),
        AntigravityOAuthState::Ok {
            email: "tester@example.com".into()
        }
    );
    assert!(bridge.has_credential());
    assert_eq!(bridge.project_id().as_deref(), Some("project"));
    let config = fs::metadata(bridge.profile_dir.join("antigravity-proxy.yaml")).unwrap();
    assert_eq!(
        config.permissions().mode() & 0o077,
        0,
        "local management key must not be world-readable"
    );
    bridge.stop();
}

#[test]
fn google_sign_in_as_cliproxyapi_8_0_61_finishes_it_is_webui_an_ok_without_auth_id_no_project() {
    if !node_available() {
        eprintln!("skipped: the fake CLIProxyAPI is a Node script");
        return;
    }
    let root = tempfile::Builder::new()
        .prefix("relay-antigravity-builtin-")
        .tempdir()
        .unwrap();
    let log = root.path().join("requests.log");
    // As the real built-in flow: the callback route saves antigravity-<email>.json and
    // completes the session without naming the file, and the project may be missing.
    let script = format!(
        r#"#!/usr/bin/env node
const fs = require('node:fs');
const http = require('node:http');
const text = fs.readFileSync(process.argv[3], 'utf8');
const port = Number(/  port: (\d+)/.exec(text)[1]);
const authDir = JSON.parse(/  auth-dir: (.*)/.exec(text)[1]);
const log = {log};
let done = false;
const server = http.createServer((req, res) => {{
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {{
    fs.appendFileSync(log, req.method + ' ' + req.url + ' ' + body + '\n');
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/models') return res.end('{{"data":[]}}');
    if (req.url.startsWith('/v8/management/oauth/auth-url'))
      return res.end(JSON.stringify({{status:'ok', state:'builtinstate1', url:'https://accounts.google.com/o/oauth2/v2/auth?state=builtinstate1'}}));
    if (req.url === '/v8/management/oauth/callback' && req.method === 'POST') {{
      fs.writeFileSync(authDir + '/antigravity-user@example.com.json', JSON.stringify({{type:'antigravity',email:'user@example.com',refresh_token:'refresh',access_token:'a'}}));
      done = true;
      return res.end('{{"status":"ok"}}');
    }}
    if (req.url.startsWith('/v8/management/oauth/status')) return res.end(done ? '{{"status":"ok"}}' : '{{"status":"wait"}}');
    res.statusCode = 404; res.end('{{}}');
  }});
}});
server.listen(port, '127.0.0.1');
"#,
        log = serde_json::to_string(&log.to_string_lossy()).unwrap()
    );
    let bridge = bridge(root.path(), fake_proxy(root.path(), &script));
    let (state, _) = bridge.begin_oauth(true).unwrap();
    assert_eq!(
        bridge.poll_oauth(&state).unwrap(),
        AntigravityOAuthState::Wait
    );
    // The browser stopped on the callback page: its address is pasted and passed on.
    let address =
        format!("http://localhost:51121/oauth-callback?state={state}&code=4/xyz&scope=email");
    bridge.submit_callback(&state, &address).unwrap();
    assert_eq!(
        bridge.poll_oauth(&state).unwrap(),
        AntigravityOAuthState::Ok {
            email: "user@example.com".into()
        }
    );
    assert!(bridge.has_credential());
    assert_eq!(bridge.project_id(), None);
    let requests = fs::read_to_string(&log).unwrap();
    // Without is_webui nothing listens on 51121 and Google's redirect is lost.
    assert!(
        requests.contains("GET /v8/management/oauth/auth-url?provider=antigravity&is_webui=true")
    );
    assert!(
        requests.contains(r#"POST /v8/management/oauth/callback {"provider":"antigravity","redirect_url":"http://localhost:51121/oauth-callback?state=builtinstate1&code=4%2Fxyz&scope=email"}"#)
            || requests.contains(r#"POST /v8/management/oauth/callback {"provider":"antigravity","redirect_url":"http://localhost:51121/oauth-callback?state=builtinstate1&code=4/xyz&scope=email"}"#),
        "{requests}"
    );
    // Another sign-in's address never leaves Relay.
    let error = bridge
        .submit_callback(&state, &address.replace("builtinstate1", "otherstate99"))
        .unwrap_err();
    assert!(error.0.contains("another sign-in"));
    bridge.stop();
}
