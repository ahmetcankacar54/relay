//! Port of the `antigravity-bridge` case of tests/provider-sign-in-guards.test.ts. Skipped:
//! "Google sends the browser back to 51121…" (a source-text check of antigravity-bridge.ts; the
//! bridge test asserts the `is_webui=true` request itself), and the UsageManager, banner and
//! sign-in source cases (other slices).

use relay_core::antigravity_bridge::antigravity_callback_url;

#[test]
fn a_pasted_callback_address_goes_on_only_when_it_is_this_sign_ins_loopback_callback() {
    let state = "da84eef2f0b8303bfbb0253824586afa";
    let ok = format!("http://localhost:51121/oauth-callback?state={state}&code=4/abc&scope=email");
    assert_eq!(
        antigravity_callback_url(&format!("  {ok} "), state).unwrap(),
        ok
    );
    let local = ok.replace("localhost", "127.0.0.1");
    assert_eq!(antigravity_callback_url(&local, state).unwrap(), local);
    let error =
        |address: &str, state: &str| antigravity_callback_url(address, state).unwrap_err().0;
    assert!(error(&ok, "another-state-123").contains("another sign-in"));
    assert!(error(&ok.replace("localhost", "evil.example"), state).contains("Not the Antigravity"));
    assert!(error(&ok.replace("/oauth-callback", "/other"), state).contains("Not the Antigravity"));
    assert!(error(&ok.replace("http:", "https:"), state).contains("Not the Antigravity"));
    assert!(
        error(
            &format!("http://localhost:51121/oauth-callback?state={state}"),
            state
        )
        .contains("no sign-in code")
    );
    assert!(error("not a url", state).contains("Not a sign-in address"));
}
