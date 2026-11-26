//! The wall clock every ported module reads (`Date.now()`).
//!
//! Parity runs pin it: in debug builds or with the `parity` feature, `RELAY_PARITY_NOW` (an ISO
//! 8601 instant) makes the clock start at that instant on its first read and advance in real
//! time from there.

use std::time::SystemTime;

/// Milliseconds since the Unix epoch, `Date.now()`.
pub fn now_ms() -> i64 {
    #[cfg(any(debug_assertions, feature = "parity"))]
    if let Some(ms) = pinned() {
        return ms;
    }
    real_now_ms()
}

fn real_now_ms() -> i64 {
    crate::fs_util::system_time_ms(SystemTime::now()) as i64
}

/// The pinned clock: the instant in `RELAY_PARITY_NOW` plus the time since the first read.
#[cfg(any(debug_assertions, feature = "parity"))]
fn pinned() -> Option<i64> {
    use std::sync::LazyLock;
    use std::time::Instant;
    static START: LazyLock<Option<(i64, Instant)>> = LazyLock::new(|| {
        let text = std::env::var("RELAY_PARITY_NOW").ok()?;
        let base = crate::fs_util::parse_iso_ms(text.trim())?;
        Some((base, Instant::now()))
    });
    let (base, since) = (*START)?;
    Some(base + i64::try_from(since.elapsed().as_millis()).unwrap_or(i64::MAX - base))
}
