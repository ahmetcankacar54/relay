//! Port of `tests/redact.test.ts`.

use relay_core::redact::{MAX, UNKNOWN_ERROR, redact, redact_error};

#[test]
fn redact_removes_token_like_text_and_keeps_one_short_line() {
    let error = std::io::Error::other(
        "fail sk-ant-oat01-AAAAAAAAAAAAAAAAAAAAAAAAAAAA\nsecond line eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl",
    );
    let out = redact_error(&error, MAX);
    assert!(!out.contains("sk-ant-"));
    assert!(!out.contains('\n'));
    assert_eq!(out, "fail [redacted]");
    assert!(!redact("x eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl", MAX).contains("eyJ"));
    assert!(redact(&format!("x {}", "a".repeat(40)), MAX).contains("x [redacted]"));
    assert!(redact(&"y ".repeat(1000), MAX).encode_utf16().count() <= 300);
    // `redact({ weird: true })`: Rust callers pass text or an error; anything else is this.
    assert_eq!(UNKNOWN_ERROR, "Unknown error");
    assert_eq!(
        redact("Claude Desktop did not close.", MAX),
        "Claude Desktop did not close."
    );
}

#[test]
fn ordinary_paths_and_uuids_stay_readable() {
    let id = "0b7b2d6e-3c1f-4f8e-9a51-2a8d1c4b5e6f";
    assert_eq!(
        redact(&format!("Missing {id}"), MAX),
        format!("Missing {id}")
    );
    assert_eq!(
        redact("/Users/x/Library/Application Support/Relay", MAX),
        "/Users/x/Library/Application Support/Relay"
    );
}

#[test]
fn a_json_parse_error_never_shows_the_bytes_it_choked_on() {
    let error = serde_json::from_str::<serde_json::Value>("FIXTURE-SECRET-broken {").unwrap_err();
    let out = redact_error(&error, MAX);
    assert!(!out.contains("FIXTURE"));
    assert!(out.to_lowercase().contains("invalid json"));
    // V8's own message, passed on as text, is caught too.
    let v8 = "Unexpected token 'F', \"FIXTURE-SE\"... is not valid JSON";
    assert!(!redact(v8, MAX).contains("FIXTURE"));
}

// The JS regexes' edges: a JWT needs three dotted runs of 8 or more, the long-run rule keeps
// runs that start with `/`, and the cut counts UTF-16 units.
#[test]
fn redaction_follows_the_js_patterns_at_their_edges() {
    assert_eq!(redact("a.bbbbbbbb.cccccccc.dddddddd", MAX), "a.[redacted]");
    assert_eq!(
        redact("short.bbbbbbbb.cccccccc", MAX),
        "short.bbbbbbbb.cccccccc"
    );
    assert_eq!(
        redact(&format!("/{}", "p".repeat(40)), MAX),
        format!("/{}", "p".repeat(40))
    );
    assert_eq!(redact("sk-ant- x", MAX), "sk-ant- x");
    assert_eq!(redact("  padded\r\nnext", MAX), "padded");
    assert_eq!(redact("abcdef", 4), "abc…");
    assert_eq!(redact("a😀bcd", 4), "a😀…");
    // JS would keep half of the pair ("ab\ud83d…"); a Rust string cannot, so the pair goes.
    assert_eq!(redact("ab😀cd", 4), "ab…");
}
