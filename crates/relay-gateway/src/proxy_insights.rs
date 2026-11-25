//! What the gateway learns from its traffic, in memory (`proxy-insights.ts`): each session's
//! prompt cache, each prompt's request and subagent counts (a loop alarm past a bound), and
//! each account's pace from the windows its answers report.

use crate::js::{Clock, parse_date, round, slice_units, system_clock};
use crate::types::{
    CacheMiss, CacheMissReason, LastMiss, LiveWindow, ProxyLoopAlarm, ProxySessionView,
    TokenTally,
};
use indexmap::{IndexMap, IndexSet};

const HOUR_MS: i64 = 3_600_000;
const FIVE_MINUTES_MS: i64 = 5 * 60_000;
const MAX_SESSIONS: usize = 500;
const MAX_PROMPTS: usize = 300;
/// Claude Code's own rule: a rewrite counts as a miss past 5 % of the prompt and 2,000 tokens.
const MISS_SHARE: f64 = 0.05;
const MISS_TOKENS: f64 = 2_000.0;
/// One prompt with this many requests, or this many subagents, may be going round in circles.
pub const LOOP_REQUESTS: u64 = 500;
pub const LOOP_SUBAGENTS: usize = 40;
/// An alarm stays on show this long after its prompt's last request.
const ALARM_SHOWN_MS: i64 = 30 * 60_000;
/// The pace is read over the last half hour, from at least ten minutes of readings.
const PACE_WINDOW_MS: i64 = 30 * 60_000;
const PACE_MIN_SPAN_MS: i64 = 10 * 60_000;
const MAX_PACE_POINTS: usize = 120;

/// The first characters of an id, enough to tell sessions apart on screen.
fn short_id(value: &str) -> String {
    slice_units(value.strip_prefix("hdr:").unwrap_or(value), 8).to_string()
}

struct SessionState {
    id: String,
    account_id: String,
    model: Option<String>,
    last_at: i64,
    prefix_tokens: f64,
    ttl_ms: i64,
    requests: u64,
    subagents: IndexSet<String>,
    misses: u64,
    last_miss: Option<LastMiss>,
}

struct PromptState {
    id: String,
    session_id: Option<String>,
    account_id: Option<String>,
    since: i64,
    last_at: i64,
    requests: u64,
    agents: IndexSet<String>,
    alarmed: bool,
}

#[derive(Clone, Copy)]
struct PacePoint {
    at: i64,
    percent: f64,
    resets_at: Option<i64>,
}

/// One answer through the gateway, as far as the session's cache and the prompt go.
#[derive(Clone, Debug, Default)]
pub struct AnswerFacts {
    pub at: i64,
    /// The gateway's session key (`hdr:<Claude Code session id>`).
    pub session_key: Option<String>,
    pub account_id: String,
    pub model: Option<String>,
    pub request_class: Option<String>,
    /// Set on a subagent's requests: they do not touch the main conversation's cache.
    pub agent_id: Option<String>,
    /// A compaction, or the first request after one: its prompt is new by design.
    pub compacted: bool,
    pub tokens: Option<TokenTally>,
}

pub struct GatewayInsights {
    sessions: IndexMap<String, SessionState>,
    prompts: IndexMap<String, PromptState>,
    pace: IndexMap<String, Vec<PacePoint>>,
    now: Clock,
}

impl Default for GatewayInsights {
    fn default() -> Self {
        Self::new(system_clock())
    }
}

/// Drops the entries heard from longest ago past `max` (oldest `last_at` first; ties in
/// insertion order, as a stable sort leaves them).
fn trim<T>(map: &mut IndexMap<String, T>, max: usize, last_at: impl Fn(&T) -> i64) {
    if map.len() <= max {
        return;
    }
    let mut order: Vec<(usize, i64)> = map.values().map(&last_at).enumerate().collect();
    order.sort_by_key(|(_, at)| *at);
    let mut drop: Vec<usize> = order[..map.len() - max].iter().map(|(i, _)| *i).collect();
    drop.sort_unstable_by(|a, b| b.cmp(a));
    for index in drop {
        map.shift_remove_index(index);
    }
}

impl GatewayInsights {
    pub fn new(now: Clock) -> Self {
        GatewayInsights {
            sessions: IndexMap::new(),
            prompts: IndexMap::new(),
            pace: IndexMap::new(),
            now,
        }
    }

    /// One request arrived for a prompt. Answers the alarm when this request takes the prompt
    /// past a bound for the first time.
    pub fn count_prompt(
        &mut self,
        prompt_id: Option<&str>,
        session_key: Option<&str>,
        agent_id: Option<&str>,
    ) -> Option<ProxyLoopAlarm> {
        let prompt_id = prompt_id?;
        let now = (self.now)();
        if !self.prompts.contains_key(prompt_id) {
            self.prompts.insert(
                prompt_id.to_string(),
                PromptState {
                    id: short_id(prompt_id),
                    session_id: session_key.map(short_id),
                    account_id: None,
                    since: now,
                    last_at: now,
                    requests: 0,
                    agents: IndexSet::new(),
                    alarmed: false,
                },
            );
            trim(&mut self.prompts, MAX_PROMPTS, |p| p.last_at);
        }
        let prompt = self.prompts.get_mut(prompt_id)?;
        prompt.requests += 1;
        prompt.last_at = now;
        if let Some(agent) = agent_id {
            if prompt.agents.len() < LOOP_SUBAGENTS * 4 {
                prompt.agents.insert(agent.to_string());
            }
        }
        if prompt.alarmed
            || (prompt.requests < LOOP_REQUESTS && prompt.agents.len() < LOOP_SUBAGENTS)
        {
            return None;
        }
        prompt.alarmed = true;
        Some(alarm_of(prompt))
    }

    /// The account that served a prompt's latest request, for its alarm.
    pub fn prompt_served_by(&mut self, prompt_id: Option<&str>, account_id: &str) {
        if let Some(prompt) = prompt_id.and_then(|id| self.prompts.get_mut(id)) {
            prompt.account_id = Some(account_id.to_string());
        }
    }

    /// One answer with its tokens. A main-conversation answer that wrote again what the last
    /// one left in the cache is a miss; answers the miss.
    pub fn observe_answer(&mut self, facts: &AnswerFacts) -> Option<CacheMiss> {
        let key = facts.session_key.as_deref()?;
        let tokens = facts.tokens?;
        if !self.sessions.contains_key(key) {
            self.sessions.insert(
                key.to_string(),
                SessionState {
                    id: short_id(key),
                    account_id: facts.account_id.clone(),
                    model: None,
                    last_at: facts.at,
                    prefix_tokens: 0.0,
                    ttl_ms: FIVE_MINUTES_MS,
                    requests: 0,
                    subagents: IndexSet::new(),
                    misses: 0,
                    last_miss: None,
                },
            );
            trim(&mut self.sessions, MAX_SESSIONS, |s| s.last_at);
        }
        let session = self.sessions.get_mut(key)?;
        session.requests += 1;
        if let Some(agent) = facts.agent_id.as_deref() {
            if session.subagents.len() < 1_000 {
                session.subagents.insert(agent.to_string());
            }
            session.last_at = session.last_at.max(facts.at);
            return None;
        }
        // Titles, classifiers and other background requests carry the session's id with a
        // short prompt of their own: they say nothing about the conversation's cache.
        if let Some(class) = facts.request_class.as_deref() {
            if class != "main" && class != "compaction" {
                session.last_at = session.last_at.max(facts.at);
                return None;
            }
        }
        let read = tokens.cache_read.unwrap_or(0.0);
        let write = tokens.cache_write.unwrap_or(0.0);
        let prompt = read + write + tokens.input.unwrap_or(0.0);
        let mut miss = None;
        let lost = session.prefix_tokens - read;
        if session.prefix_tokens > 0.0
            && !facts.compacted
            && facts.request_class.as_deref() != Some("compaction")
            && write > 0.0
            // A prompt that shrank was shortened on purpose; a miss is a prompt as long as
            // before that was not read.
            && prompt >= session.prefix_tokens * 0.9
            && lost > MISS_TOKENS.max(session.prefix_tokens * MISS_SHARE)
        {
            // An expired cache is written again wherever the session goes.
            let reason = if facts.at - session.last_at > session.ttl_ms {
                CacheMissReason::Expired
            } else if session.account_id != facts.account_id {
                CacheMissReason::Account
            } else if matches!((&session.model, &facts.model), (Some(a), Some(b)) if !a.is_empty() && !b.is_empty() && a != b)
            {
                CacheMissReason::Model
            } else {
                CacheMissReason::Unknown
            };
            let found = CacheMiss {
                reason,
                tokens: lost.min(write),
            };
            session.misses += 1;
            session.last_miss = Some(LastMiss {
                at: facts.at,
                reason,
                tokens: found.tokens,
            });
            miss = Some(found);
        }
        session.prefix_tokens = prompt;
        session.account_id = facts.account_id.clone();
        if let Some(model) = facts.model.as_deref().filter(|m| !m.is_empty()) {
            session.model = Some(model.to_string());
        }
        session.last_at = facts.at;
        // A write sets how long the cache lives; a read alone keeps (and refreshes) it.
        if tokens.cache_write_1h.unwrap_or(0.0) > 0.0 {
            session.ttl_ms = HOUR_MS;
        } else if write > 0.0 {
            session.ttl_ms = FIVE_MINUTES_MS;
        }
        miss
    }

    /// Whether a session's cache has lived out its time since its last request.
    pub fn is_cold(&self, session_key: &str) -> bool {
        self.sessions.get(session_key).is_some_and(|s| {
            s.prefix_tokens > 0.0 && (self.now)() - s.last_at > s.ttl_ms
        })
    }

    /// The sessions heard from most recently, newest first.
    pub fn session_views(&self, limit: usize) -> Vec<ProxySessionView> {
        let mut sessions: Vec<&SessionState> = self
            .sessions
            .values()
            .filter(|s| s.prefix_tokens > 0.0)
            .collect();
        sessions.sort_by_key(|s| std::cmp::Reverse(s.last_at));
        sessions
            .into_iter()
            .take(limit)
            .map(|s| ProxySessionView {
                id: s.id.clone(),
                account_id: s.account_id.clone(),
                model: s.model.clone(),
                last_at: s.last_at,
                prefix_tokens: s.prefix_tokens,
                ttl_ms: s.ttl_ms,
                requests: s.requests,
                subagents: s.subagents.len() as u64,
                misses: s.misses,
                last_miss: s.last_miss,
                move_cost: None,
            })
            .collect()
    }

    /// Prompts past a bound whose last request was within the last half hour.
    pub fn alarms(&self) -> Vec<ProxyLoopAlarm> {
        let now = (self.now)();
        let mut prompts: Vec<&PromptState> = self
            .prompts
            .values()
            .filter(|p| p.alarmed && now - p.last_at <= ALARM_SHOWN_MS)
            .collect();
        prompts.sort_by_key(|p| std::cmp::Reverse(p.last_at));
        prompts.into_iter().map(alarm_of).collect()
    }

    /// An account's 5-hour window as an answer reported it.
    pub fn observe_limits(&mut self, account_id: &str, five_hour: Option<&LiveWindow>) {
        let Some(five_hour) = five_hour else { return };
        let at = (self.now)();
        let point = PacePoint {
            at,
            percent: five_hour.used_percent,
            resets_at: five_hour.resets_at.as_deref().and_then(parse_date),
        };
        let mut points = self.pace.shift_remove(account_id).unwrap_or_default();
        if let Some(last) = points.last() {
            // A new window began: the old readings say nothing about its pace.
            let new_window = point.percent < last.percent
                || matches!((last.resets_at, point.resets_at), (Some(a), Some(b)) if b - a >= HOUR_MS);
            if new_window {
                points.clear();
            }
        }
        points.push(point);
        points.retain(|p| at - p.at <= PACE_WINDOW_MS);
        if points.len() > MAX_PACE_POINTS {
            points.drain(..points.len() - MAX_PACE_POINTS);
        }
        self.pace.insert(account_id.to_string(), points);
    }

    /// When the account's 5-hour window fills at the pace of the last half hour: only when
    /// that is before the window resets, and from at least ten minutes of readings that rose.
    pub fn full_at(&self, account_id: &str) -> Option<i64> {
        let now = (self.now)();
        let points: Vec<&PacePoint> = self
            .pace
            .get(account_id)?
            .iter()
            .filter(|p| now - p.at <= PACE_WINDOW_MS)
            .collect();
        if points.len() < 2 {
            return None;
        }
        let first = points[0];
        let last = points[points.len() - 1];
        let span = (last.at - first.at) as f64;
        let rise = last.percent - first.percent;
        if span < PACE_MIN_SPAN_MS as f64 || rise < 1.0 || last.percent >= 100.0 {
            return None;
        }
        let at = round(last.at as f64 + (100.0 - last.percent) * span / rise) as i64;
        match last.resets_at {
            Some(reset) if at >= reset => None,
            _ => Some(at),
        }
    }
}

fn alarm_of(prompt: &PromptState) -> ProxyLoopAlarm {
    ProxyLoopAlarm {
        id: prompt.id.clone(),
        session_id: prompt.session_id.clone(),
        account_id: prompt.account_id.clone(),
        since: prompt.since,
        last_at: prompt.last_at,
        requests: prompt.requests,
        subagents: prompt.agents.len() as u64,
    }
}
