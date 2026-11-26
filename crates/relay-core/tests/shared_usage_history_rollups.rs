//! The `shared/usage-statistics` case of tests/usage-history-rollups.test.ts. Every other case
//! exercises the Electron UsageHistory (files, symlinks, write failures, restarts).

use relay_core::shared::usage_statistics::{MAX_USAGE_SAMPLES, USAGE_HISTORY_DAYS};

#[test]
fn raw_retention_is_14_days_and_at_most_50000_samples() {
    assert_eq!(USAGE_HISTORY_DAYS, 14.0);
    assert_eq!(MAX_USAGE_SAMPLES, 50_000);
}
