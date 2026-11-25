//! The gateway's requests on disk, one JSON line each (`gateway-requests.jsonl`, from
//! `proxy-request-log.ts`): which account served each one, how it went and the tokens it
//! reported, never what was asked or answered. It also answers which account served a
//! provider request id.

use crate::js::{now_ms, round, slice_units};
use crate::types::{
    CacheMiss, CacheMissReason, OverflowCost, ProxyClassShare, ProxyMoveReason, ProxyPick,
    ProxyPickReason, ProxyRequestLog, TokenTally,
};
use chrono::{Local, TimeZone};
use indexmap::IndexMap;
use serde_json::Value;
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};

/// How long the gateway's requests are kept: past the token table's own rescans of recent days.
pub const REQUEST_LOG_KEEP_DAYS: i64 = 35;
const DAY_MS: i64 = 86_400_000;
/// At most this many requests are kept, the newest.
const MAX_ENTRIES: usize = 50_000;
/// Past this size the file is compacted at the next append.
const MAX_FILE_BYTES: u64 = 40 * 1024 * 1024;
/// A file larger than this is not read at all (not one this log wrote).
const MAX_READ_BYTES: u64 = 64 * 1024 * 1024;
/// Overflow answers' costs are kept this long: any time zone's current day fits inside it.
const SPEND_KEEP_MS: i64 = 2 * 86_400_000;

fn text(value: Option<&Value>, max: usize) -> Option<String> {
    match value? {
        Value::String(s) if !s.is_empty() => Some(slice_units(s, max).to_string()),
        _ => None,
    }
}

fn count(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite() && *v >= 0.0)
        .map(round)
}

/// Account ids, at most ten.
fn ids(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_str)
            .filter(|id| !id.is_empty() && crate::js::units(id) <= 64)
            .take(10)
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

fn enum_of<T: serde::de::DeserializeOwned>(value: Option<&Value>) -> Option<T> {
    match value? {
        Value::String(_) => serde_json::from_value(value?.clone()).ok(),
        _ => None,
    }
}

/// A request's pick read back, or nothing when its reason is unknown.
fn clean_pick(raw: Option<&Value>) -> Option<ProxyPick> {
    let row = raw.filter(|v| v.is_object())?;
    let reason: ProxyPickReason = enum_of(row.get("reason"))?;
    let nearly_full = ids(row.get("nearlyFull"));
    let no_sign_in = ids(row.get("noSignIn"));
    let moved: Option<ProxyMoveReason> = enum_of(row.get("moved"));
    let from = text(row.get("from"), 64);
    Some(ProxyPick {
        reason,
        nearly_full: (!nearly_full.is_empty()).then_some(nearly_full),
        no_sign_in: (!no_sign_in.is_empty()).then_some(no_sign_in),
        after: text(row.get("after"), 64),
        overflow: (row.get("overflow") == Some(&Value::Bool(true))).then_some(true),
        bound_waiting: text(row.get("boundWaiting"), 64),
        from: moved.and(from),
        moved,
    })
}

/// One line read back: only the known fields, each in shape and capped, or nothing.
pub fn clean_entry(raw: &Value) -> Option<ProxyRequestLog> {
    if !raw.is_object() {
        return None;
    }
    let at = count(raw.get("at"))?;
    let status = count(raw.get("status"))?;
    if status > 999.0 {
        return None;
    }
    let tokens = raw.get("tokens").filter(|t| t.is_object()).and_then(|t| {
        let take = |key: &str| count(t.get(key)).filter(|v| *v != 0.0);
        let tally = TokenTally {
            input: take("input"),
            output: take("output"),
            cache_read: take("cacheRead"),
            cache_write: take("cacheWrite"),
            cache_write_1h: take("cacheWrite1h"),
        };
        (tally != TokenTally::default()).then_some(tally)
    });
    let miss = raw.get("miss").filter(|m| m.is_object()).and_then(|m| {
        let reason: CacheMissReason = enum_of(m.get("reason"))?;
        Some(CacheMiss {
            reason,
            tokens: count(m.get("tokens")).unwrap_or(0.0),
        })
    });
    Some(ProxyRequestLog {
        at: at as i64,
        status: status as u16,
        account_id: text(raw.get("accountId"), 64),
        provider: text(raw.get("provider"), 20),
        model: text(raw.get("model"), 80),
        note: text(raw.get("note"), 40),
        request_id: text(raw.get("requestId"), 128),
        client: text(raw.get("client"), 40),
        request_class: text(raw.get("requestClass"), 40),
        agent_type: text(raw.get("agentType"), 40),
        error: text(raw.get("error"), 160),
        upstream: text(raw.get("upstream"), 40),
        failover: (raw.get("failover") == Some(&Value::Bool(true))).then_some(true),
        cost: raw
            .get("cost")
            .and_then(Value::as_f64)
            .filter(|c| c.is_finite() && *c >= 0.0)
            .map(|c| round(c * 1e6) / 1e6),
        miss,
        affinity: (raw.get("affinity") == Some(&Value::Bool(true))).then_some(true),
        pick: clean_pick(raw.get("pick")),
        ms: count(raw.get("ms")).map(|ms| ms as i64),
        tokens,
    })
}

#[derive(Default)]
pub struct RequestLogOptions {
    pub now: Option<crate::js::Clock>,
    pub feed_size: Option<usize>,
}

/// The gateway's request log file.
pub struct GatewayRequestLog {
    file: PathBuf,
    options: RequestLogOptions,
    by_request_id: HashMap<String, String>,
    latest: Vec<ProxyRequestLog>,
    /// Today's answered requests by class, for the local day in `day`.
    today_day: String,
    today: IndexMap<String, ProxyClassShare>,
    /// Overflow answers of the last two days that cost something, for the daily cap.
    spend: Vec<OverflowCost>,
}

impl GatewayRequestLog {
    pub fn new(file: impl Into<PathBuf>, options: RequestLogOptions) -> Self {
        GatewayRequestLog {
            file: file.into(),
            options,
            by_request_id: HashMap::new(),
            latest: Vec::new(),
            today_day: String::new(),
            today: IndexMap::new(),
            spend: Vec::new(),
        }
    }

    pub fn file(&self) -> &Path {
        &self.file
    }

    fn now(&self) -> i64 {
        self.options.now.as_ref().map_or_else(now_ms, |now| now())
    }

    fn feed_size(&self) -> usize {
        self.options.feed_size.unwrap_or(40)
    }

    /// Reads what is kept, drops what is too old (rewriting the file when it dropped any), and
    /// indexes the request ids. Answers the newest entries, newest last.
    pub fn load(&mut self) -> Vec<ProxyRequestLog> {
        let entries = self.read();
        self.by_request_id.clear();
        for entry in &entries {
            if let (Some(id), Some(account)) = (&entry.request_id, &entry.account_id) {
                self.by_request_id.insert(id.clone(), account.clone());
            }
        }
        let skip = entries.len().saturating_sub(self.feed_size());
        self.latest = entries[skip..].to_vec();
        self.today_day = day_of(self.now());
        self.today.clear();
        self.spend.clear();
        for entry in &entries {
            self.count(entry);
        }
        self.latest.clone()
    }

    /// Today's answered requests by Claude Code's request class, the costliest first.
    pub fn today_by_class(&mut self) -> Vec<ProxyClassShare> {
        let day = day_of(self.now());
        if self.today_day != day {
            self.today_day = day;
            self.today.clear();
        }
        let mut shares: Vec<ProxyClassShare> = self.today.values().cloned().collect();
        shares.sort_by(|a, b| {
            b.cost
                .partial_cmp(&a.cost)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| {
                    b.tokens
                        .partial_cmp(&a.tokens)
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
        });
        shares
    }

    /// The times and costs of the overflow answers of the last two days, oldest first.
    pub fn overflow_costs(&mut self) -> Vec<OverflowCost> {
        let oldest = self.now() - SPEND_KEEP_MS;
        self.spend.retain(|row| row.at >= oldest);
        self.spend.clone()
    }

    /// Adds an answered request to today's shares, when it is today's, and an overflow cost
    /// to the spend.
    fn count(&mut self, entry: &ProxyRequestLog) {
        if let (Some(_), Some(cost)) = (&entry.upstream, entry.cost) {
            if cost != 0.0 && entry.at >= self.now() - SPEND_KEEP_MS {
                self.spend.push(OverflowCost { at: entry.at, cost });
            }
        }
        let Some(t) = entry.tokens.filter(|_| entry.status < 400) else {
            return;
        };
        let day = day_of(entry.at);
        if day != self.today_day {
            if day < self.today_day {
                return;
            }
            self.today_day = day;
            self.today.clear();
        }
        let key = entry.request_class.clone().unwrap_or_else(|| "other".into());
        let share = self
            .today
            .entry(key.clone())
            .or_insert_with(|| ProxyClassShare {
                request_class: key,
                requests: 0,
                tokens: 0.0,
                cost: 0.0,
            });
        share.requests += 1;
        share.tokens += t.input.unwrap_or(0.0)
            + t.output.unwrap_or(0.0)
            + t.cache_read.unwrap_or(0.0)
            + t.cache_write.unwrap_or(0.0);
        share.cost = round((share.cost + entry.cost.unwrap_or(0.0)) * 1e6) / 1e6;
    }

    /// The newest entries, newest last.
    pub fn recent(&self) -> Vec<ProxyRequestLog> {
        self.latest.clone()
    }

    /// The account that served a request id, while the log keeps it.
    pub fn account_for(&self, request_id: &str) -> Option<&str> {
        self.by_request_id.get(request_id).map(String::as_str)
    }

    /// Known as soon as the answer's headers arrive, before the request is done and recorded.
    pub fn bind(&mut self, request_id: &str, account_id: &str) {
        self.by_request_id
            .insert(request_id.to_string(), account_id.to_string());
    }

    /// Adds one request. A failed write leaves the log as it was; the gateway goes on.
    pub fn record(&mut self, entry: &ProxyRequestLog) {
        let Some(clean) = serde_json::to_value(entry).ok().and_then(|v| clean_entry(&v)) else {
            return;
        };
        if let (Some(id), Some(account)) = (&clean.request_id, &clean.account_id) {
            self.by_request_id.insert(id.clone(), account.clone());
        }
        self.count(&clean);
        self.latest.push(clean.clone());
        let size = self.feed_size();
        if self.latest.len() > size {
            let excess = self.latest.len() - size;
            self.latest.drain(..excess);
        }
        if let Ok(line) = serde_json::to_string(&clean) {
            // Not saved; the request was served all the same.
            let _ = self.append(&format!("{line}\n"));
        }
    }

    fn read(&mut self) -> Vec<ProxyRequestLog> {
        let raw = match std::fs::symlink_metadata(&self.file) {
            Ok(meta) if meta.is_file() && meta.len() <= MAX_READ_BYTES => {
                match std::fs::read(&self.file) {
                    Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
                    Err(_) => return Vec::new(),
                }
            }
            _ => return Vec::new(),
        };
        let oldest = self.now() - REQUEST_LOG_KEEP_DAYS * DAY_MS;
        let lines: Vec<&str> = raw.split('\n').filter(|l| !l.is_empty()).collect();
        let mut entries: Vec<ProxyRequestLog> = lines
            .iter()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter_map(|value| clean_entry(&value))
            .filter(|entry| entry.at >= oldest)
            .collect();
        entries.sort_by_key(|entry| entry.at);
        let skip = entries.len().saturating_sub(MAX_ENTRIES);
        let kept = entries.split_off(skip);
        if kept.len() != lines.len() {
            // Kept as it was; the next start tries again.
            let _ = self.rewrite(&kept);
        }
        kept
    }

    fn append(&mut self, line: &str) -> std::io::Result<()> {
        if let Some(dir) = self.file.parent() {
            crate::overflow_upstream::create_private_dir(dir)?;
        }
        match std::fs::symlink_metadata(&self.file) {
            Ok(meta) => {
                if !meta.is_file() {
                    return Ok(());
                }
                if meta.len() > MAX_FILE_BYTES {
                    self.read();
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        let mut options = std::fs::OpenOptions::new();
        options.append(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            // A symlink planted where the log lives is not written through.
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let mut file = options.open(&self.file)?;
        file.write_all(line.as_bytes())
    }

    fn rewrite(&self, entries: &[ProxyRequestLog]) -> std::io::Result<()> {
        let mut temporary = self.file.as_os_str().to_owned();
        temporary.push(format!(".{}.tmp", std::process::id()));
        let temporary = PathBuf::from(temporary);
        {
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create(true).truncate(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&temporary)?;
            let mut text = String::new();
            for entry in entries {
                text.push_str(&serde_json::to_string(entry).unwrap_or_default());
                text.push('\n');
            }
            file.write_all(text.as_bytes())?;
            file.sync_all()?;
        }
        std::fs::rename(&temporary, &self.file)
    }
}

/// The local calendar day a time falls on.
fn day_of(at: i64) -> String {
    Local
        .timestamp_millis_opt(at)
        .single()
        .map(|d| d.format("%Y-%m-%d").to_string())
        .unwrap_or_default()
}
