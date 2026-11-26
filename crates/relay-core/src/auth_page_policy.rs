//! Where Relay's sign-in windows may go: Anthropic's sites, the sign-in providers claude.ai
//! offers, and the CLI's own localhost callback.

use url::Url;

/// Sites the Claude sign-in passes through: Anthropic's, and the identity providers claude.ai offers.
const SIGN_IN_HOSTS: [&str; 3] = ["claude.ai", "claude.com", "anthropic.com"];
const PROVIDER_HOSTS: [&str; 2] = ["accounts.google.com", "appleid.apple.com"];

/// The CLI's localhost callback named by a sign-in page's `redirect_uri`; `None` when it is not one.
pub fn local_callback(page_url: &str) -> Option<Url> {
    let page = Url::parse(page_url).ok()?;
    let redirect = page
        .query_pairs()
        .find(|(key, _)| key == "redirect_uri")
        .map(|(_, value)| value.into_owned())
        .unwrap_or_default();
    let redirect = Url::parse(&redirect).ok()?;
    (redirect.scheme() == "http" && matches!(redirect.host_str(), Some("localhost" | "127.0.0.1")))
        .then_some(redirect)
}

/// `URL.host`: the hostname plus a non-default port.
pub fn url_host(url: &Url) -> String {
    let host = url.host_str().unwrap_or("");
    match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_owned(),
    }
}

/// Whether Relay's sign-in window may go to `url`: https on Anthropic's sites (and their
/// subdomains) or a sign-in provider's, or the exact localhost callback the CLI listens on.
/// Anything else opens in the system browser instead.
pub fn sign_in_navigation_allowed(url: &str, callback: Option<&Url>) -> bool {
    let Ok(target) = Url::parse(url) else {
        return false;
    };
    if !target.username().is_empty() || target.password().is_some_and(|p| !p.is_empty()) {
        return false;
    }
    let hostname = target.host_str().unwrap_or("");
    if target.scheme() == "https" {
        return SIGN_IN_HOSTS
            .iter()
            .any(|h| hostname == *h || hostname.ends_with(&format!(".{h}")))
            || PROVIDER_HOSTS.contains(&hostname);
    }
    callback.is_some_and(|callback| {
        target.scheme() == "http"
            && url_host(&target) == url_host(callback)
            && target.path() == callback.path()
    })
}

/// The session partition of an account's sign-in window; kept so a renewal needs one click.
pub fn sign_in_partition(account_id: &str) -> String {
    format!("persist:relay-auth-{account_id}")
}

/// Whether `target` is an https: address: the only kind a sign-in pop-up visits or hands on.
pub fn is_https(target: &str) -> bool {
    Url::parse(target).is_ok_and(|url| url.scheme() == "https")
}
