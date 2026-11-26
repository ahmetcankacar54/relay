//! Port of `shared/cli-version.ts`.

/// The oldest Claude Code CLI Relay works with (`supportsDesktop` gates on it).
pub const MIN_CLI_VERSION: &str = "2.1.285";

/// The oldest Claude Code CLI Relay can read usage limits with.
pub const USAGE_CLI_VERSION: &str = "2.1.296";

/// `version.match(/(\d+)\.(\d+)\.(\d+)/)` as numbers: the first `a.b.c` run of ASCII digits.
fn parts(version: &str) -> Option<[f64; 3]> {
    let bytes = version.as_bytes();
    // Read the digits from `at`; `None` when there are none.
    let digits = |at: usize| {
        let end = bytes[at..]
            .iter()
            .position(|b| !b.is_ascii_digit())
            .map_or(bytes.len(), |n| at + n);
        (end > at).then_some(end)
    };
    for start in 0..bytes.len() {
        // A match never starts in the middle of a digit run it could have started earlier in.
        let Some(e1) = digits(start) else { continue };
        if bytes.get(e1) != Some(&b'.') {
            continue;
        }
        let Some(e2) = digits(e1 + 1) else { continue };
        if bytes.get(e2) != Some(&b'.') {
            continue;
        }
        let Some(e3) = digits(e2 + 1) else { continue };
        let num = |a: usize, b: usize| version[a..b].parse::<f64>().unwrap_or(f64::INFINITY);
        return Some([num(start, e1), num(e1 + 1, e2), num(e2 + 1, e3)]);
    }
    None
}

/// Whether a `claude --version` output is `min` or later.
fn at_least(version: &str, min: &str) -> bool {
    let Some(found) = parts(version) else {
        return false;
    };
    let Some(floor) = parts(min) else {
        return false;
    };
    for i in 0..3 {
        if found[i] != floor[i] {
            return found[i] > floor[i];
        }
    }
    true
}

/// Whether a `claude --version` output is MIN_CLI_VERSION or later.
pub fn meets_cli_minimum(version: &str) -> bool {
    at_least(version, MIN_CLI_VERSION)
}

/// Whether a `claude --version` output is USAGE_CLI_VERSION or later: it can read limits.
pub fn reads_usage(version: &str) -> bool {
    at_least(version, USAGE_CLI_VERSION)
}
