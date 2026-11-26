//! Port of `electron/core/active-account-timeline.ts`: which Claude Desktop account was open
//! when, kept in `active-account-timeline.json` (version 1) so the tokens Claude Code logs can be
//! told apart by account.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::continuation_journal::{MAX_BYTES, read_private_json, write_private_json};
use crate::shared::types::js::{date_parse, iso};

/// One stretch of time in which one account was open in Claude Desktop. Ids and times only.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveSegment {
    pub account_uuid: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub org_id: Option<String>,
    /// ISO time the account opened.
    pub from: String,
    /// ISO time it closed; missing while it is still open.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
}

/// The timeline keeps this many of the newest segments.
pub const ACTIVE_TIMELINE_MAX_SEGMENTS: usize = 5_000;
/// A segment that ended longer ago than this is dropped.
pub const ACTIVE_TIMELINE_RETENTION_MS: f64 = 120.0 * 24.0 * 60.0 * 60_000.0;
/// Observations further apart than this mean Relay may have been closed in between.
pub const ACTIVE_TIMELINE_GAP_MS: f64 = 10.0 * 60_000.0;
/// A segment cut off by a gap or a restart ends this long after the last observation.
pub const ACTIVE_TIMELINE_GRACE_MS: f64 = 60_000.0;
/// While a segment stays open the last observation is saved at most this often, as Desktop is
/// read every few seconds and every save is a synchronous, flushed write. It equals the grace, so
/// a segment cut off after a restart ends no earlier than the last real observation.
const HEARTBEAT_MS: f64 = ACTIVE_TIMELINE_GRACE_MS;

/// What Desktop shows now, as `observe` takes it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ActiveObservation {
    pub running: bool,
    pub current_account_uuid: Option<String>,
    pub organizations: Option<Vec<String>>,
}

/// The account open at a time; `exact` is always true.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveAccount {
    pub account_uuid: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub org_id: Option<String>,
    pub exact: bool,
}

fn iso_time(value: Option<&Value>) -> Option<f64> {
    let time = date_parse(value?.as_str()?);
    time.is_finite().then_some(time)
}

fn segment_end(segment: &ActiveSegment) -> f64 {
    match &segment.to {
        None => f64::INFINITY,
        Some(to) => date_parse(to),
    }
}

/// The segments and the last observation in `file`; any trouble reading it gives an empty timeline.
fn load(file: &std::path::Path) -> (Vec<ActiveSegment>, Option<f64>) {
    // Missing, unreadable or corrupt: start a new timeline rather than guess.
    let Ok(value) = read_private_json(file, MAX_BYTES) else {
        return (Vec::new(), None);
    };
    let Some(object) = value.as_object() else {
        return (Vec::new(), None);
    };
    let version_one = object.get("version").and_then(Value::as_f64) == Some(1.0);
    let Some(list) = object
        .get("segments")
        .and_then(Value::as_array)
        .filter(|_| version_one)
    else {
        return (Vec::new(), None);
    };
    let mut segments = Vec::new();
    for entry in list {
        let Some(item) = entry.as_object() else {
            continue;
        };
        let Some(account_uuid) = item.get("accountUuid").and_then(Value::as_str) else {
            continue;
        };
        if account_uuid.is_empty() {
            continue;
        }
        let org_id = match item.get("orgId") {
            None => None,
            Some(Value::String(org)) => Some(org.clone()),
            Some(_) => continue,
        };
        if iso_time(item.get("from")).is_none() {
            continue;
        }
        let to = match item.get("to") {
            None => None,
            Some(to) if iso_time(Some(to)).is_some() => to.as_str().map(str::to_owned),
            Some(_) => continue,
        };
        segments.push(ActiveSegment {
            account_uuid: account_uuid.to_owned(),
            org_id,
            from: item["from"].as_str().unwrap_or_default().to_owned(),
            to,
        });
    }
    // Saved in order; sorted anyway, by start then end, so lookups can search them.
    segments.sort_by(|a, b| {
        let order = date_parse(&a.from) - date_parse(&b.from);
        let order = if order == 0.0 {
            segment_end(a) - segment_end(b)
        } else {
            order
        };
        order.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal)
    });
    // Only the newest segment can still be open: an older one ended when the next began.
    for index in 0..segments.len().saturating_sub(1) {
        if segments[index].to.is_none() {
            segments[index].to = Some(segments[index + 1].from.clone());
        }
    }
    (segments, iso_time(object.get("lastObservedAt")))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TimelineFile<'a> {
    version: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_observed_at: Option<String>,
    segments: &'a [ActiveSegment],
}

/// Which Claude Desktop account was open when, kept in a private file so the tokens Claude Code
/// logs can be told apart by account. A segment opens when Claude runs with a known account and
/// closes when the account changes, Claude stops or the account is unknown. Only ids and times
/// are stored. A failed save is swallowed: the timeline keeps working in memory and must never
/// disturb Desktop readings.
pub struct ActiveAccountTimeline {
    file: PathBuf,
    now: Box<dyn Fn() -> f64 + Send + Sync>,
    /// Chronological, and by construction never overlapping.
    segments: Vec<ActiveSegment>,
    /// Each segment's start in epoch ms, in step with `segments`, for binary search.
    from_ms: Vec<f64>,
    /// Each segment's end in epoch ms; infinity while it is open.
    to_ms: Vec<f64>,
    last_observed_at: Option<f64>,
    /// The last observation the file holds.
    saved_observed_at: Option<f64>,
}

impl ActiveAccountTimeline {
    /// A timeline on `file` reading the wall clock.
    pub fn new(file: impl Into<PathBuf>) -> Self {
        Self::with_clock(file, || crate::clock::now_ms() as f64)
    }

    pub fn with_clock(
        file: impl Into<PathBuf>,
        now: impl Fn() -> f64 + Send + Sync + 'static,
    ) -> Self {
        let file = file.into();
        let (segments, last_observed_at) = load(&file);
        let mut timeline = ActiveAccountTimeline {
            file,
            now: Box::new(now),
            segments: Vec::new(),
            from_ms: Vec::new(),
            to_ms: Vec::new(),
            last_observed_at,
            saved_observed_at: last_observed_at,
        };
        for segment in segments {
            timeline.push(segment);
        }
        let current = (timeline.now)();
        let mut changed = false;
        // A segment the last run left open ended with that run, a little after its last
        // observation, and never later than now.
        if timeline.open().is_some() {
            let last = timeline
                .last_observed_at
                .unwrap_or_else(|| *timeline.from_ms.last().unwrap_or(&f64::NAN));
            timeline.close_open((last + ACTIVE_TIMELINE_GRACE_MS).min(current));
            changed = true;
        }
        if timeline.prune(current) {
            changed = true;
        }
        if changed {
            timeline.save();
        }
        timeline
    }

    /// Records what Desktop shows now; call it with every freshly read Desktop state.
    pub fn observe(&mut self, state: &ActiveObservation) {
        // Never earlier than the last observation, so a clock that stepped back cannot reorder time.
        let now = (self.now)().max(self.last_observed_at.unwrap_or(0.0));
        let mut changed = false;
        let mut open = self.open().map(|segment| segment.account_uuid.clone());
        if let (Some(_), Some(last)) = (&open, self.last_observed_at)
            && now - last > ACTIVE_TIMELINE_GAP_MS
        {
            // Relay may have been closed in between: the account is not known to have stayed open.
            self.close_open(last + ACTIVE_TIMELINE_GRACE_MS);
            open = None;
            changed = true;
        }
        let account = if state.running {
            state
                .current_account_uuid
                .as_deref()
                .filter(|id| !id.is_empty())
        } else {
            None
        };
        match account {
            None => {
                if open.is_some() {
                    self.close_open(now);
                    changed = true;
                }
            }
            Some(account) if open.as_deref() != Some(account) => {
                if open.is_some() {
                    self.close_open(now);
                }
                let org_id = match state.organizations.as_deref() {
                    Some([only]) => Some(only.clone()),
                    _ => None,
                };
                self.push(ActiveSegment {
                    account_uuid: account.to_owned(),
                    org_id,
                    from: iso(now),
                    to: None,
                });
                changed = true;
            }
            Some(_) => {}
        }
        self.last_observed_at = Some(now);
        if changed {
            self.prune(now);
            self.save();
        } else if self.open().is_some()
            && now - self.saved_observed_at.unwrap_or(0.0) >= HEARTBEAT_MS
        {
            self.save();
        }
    }

    /// The account open at `time` (epoch ms), if the timeline saw one then.
    pub fn account_at(&self, time: f64) -> Option<ActiveAccount> {
        let since = self.exact_since()?;
        // A NaN `time` is never known.
        if time.is_nan() || time < since {
            return None;
        }
        // The last segment that began at or before `time`; as segments do not overlap, only it
        // can hold it.
        let index = self.from_ms.partition_point(|from| *from <= time) - 1;
        if time >= self.to_ms[index] {
            return None;
        }
        let segment = &self.segments[index];
        Some(ActiveAccount {
            account_uuid: segment.account_uuid.clone(),
            org_id: segment.org_id.clone(),
            exact: true,
        })
    }

    /// A copy of the segments, oldest first.
    pub fn list(&self) -> Vec<ActiveSegment> {
        self.segments.clone()
    }

    /// When the timeline began to know, the start of its first segment; before it nothing is known.
    pub fn exact_since(&self) -> Option<f64> {
        self.from_ms.first().copied()
    }

    fn open(&self) -> Option<&ActiveSegment> {
        self.segments.last().filter(|segment| segment.to.is_none())
    }

    /// Appends a segment and its times, read from its own ISO strings so they match a reload.
    fn push(&mut self, segment: ActiveSegment) {
        self.from_ms.push(date_parse(&segment.from));
        self.to_ms.push(segment_end(&segment));
        self.segments.push(segment);
    }

    /// Ends the open segment, the newest, at `at`, never before it began.
    fn close_open(&mut self, at: f64) {
        let index = self.segments.len() - 1;
        let to = iso(at.max(self.from_ms[index]));
        self.to_ms[index] = date_parse(&to);
        self.segments[index].to = Some(to);
    }

    /// Drops segments that ended long ago and any beyond the newest few thousand; whether any went.
    fn prune(&mut self, now: f64) -> bool {
        let cutoff = now - ACTIVE_TIMELINE_RETENTION_MS;
        let mut kept: Vec<usize> = (0..self.segments.len())
            .filter(|&index| self.to_ms[index] >= cutoff)
            .collect();
        if kept.len() > ACTIVE_TIMELINE_MAX_SEGMENTS {
            kept.drain(..kept.len() - ACTIVE_TIMELINE_MAX_SEGMENTS);
        }
        if kept.len() == self.segments.len() {
            return false;
        }
        self.segments = kept
            .iter()
            .map(|&index| self.segments[index].clone())
            .collect();
        self.from_ms = kept.iter().map(|&index| self.from_ms[index]).collect();
        self.to_ms = kept.iter().map(|&index| self.to_ms[index]).collect();
        true
    }

    fn save(&mut self) {
        let body = TimelineFile {
            version: 1,
            last_observed_at: self.last_observed_at.map(iso),
            segments: &self.segments,
        };
        // The timeline is an aid to attribution; a failed save loses history, not Desktop readings.
        if write_private_json(&self.file, &body, MAX_BYTES).is_ok() {
            self.saved_observed_at = self.last_observed_at;
        }
    }
}

/// What token attribution reads: the account open at a time.
impl crate::token_attribution::AccountTimeline for ActiveAccountTimeline {
    fn account_at(&self, time: f64) -> Option<crate::token_attribution::TimelineAccount> {
        ActiveAccountTimeline::account_at(self, time).map(|account| {
            crate::token_attribution::TimelineAccount {
                account_uuid: account.account_uuid,
                org_id: account.org_id,
            }
        })
    }
}
