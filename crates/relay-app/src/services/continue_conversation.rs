//! The fleet's one conversation: reopened on the new account, checked, and sent the continuation
//! once (port of electron/main/continue-conversation.ts).

use std::sync::Arc;
use std::time::Duration;

use relay_core::continuation::{CONTINUATION_TEXT, DeliveryStatus};
use relay_core::desktop_continuation_evidence::{NativeDesktopContinuationEvidence, QuotaStop};
use relay_core::desktop_continuation_host::{
    DesktopAutomation, DesktopAutomationSnapshot, DesktopContinuationEvidence, DesktopHostError,
    automation_guard,
};
use relay_core::fleet_continuation::{BeforeSend, FleetResult};
use relay_core::fleet_show::{ShowDeps, ShowResult, wait_for_conversation};
use relay_core::shared::types::Account;
use serde_json::{Map, Value, json};

use crate::services::logs::{claude_page_booted, log_fleet_event};
use crate::state::STATE;

fn sleep(ms: u64) {
    std::thread::sleep(Duration::from_millis(ms));
}

/// What `waitForConversation` reads: Claude's screen, its links and the stopped transcript.
struct Show<'a> {
    automation: &'a dyn DesktopAutomation,
    evidence: &'a NativeDesktopContinuationEvidence,
    stop: &'a QuotaStop,
}

impl ShowDeps for Show<'_> {
    fn inspect(&self) -> Result<DesktopAutomationSnapshot, DesktopHostError> {
        self.automation.inspect()
    }
    fn open(&self, local_session_id: &str) -> Result<(), DesktopHostError> {
        self.automation.open_session(local_session_id, None)
    }
    fn booted(&self) -> Result<Option<bool>, DesktopHostError> {
        Ok(claude_page_booted())
    }
    fn unchanged(&self) -> bool {
        self.evidence.unchanged(self.stop)
    }
    fn now(&self) -> f64 {
        relay_core::clock::now_ms() as f64
    }
    fn sleep(&self, ms: u64) {
        sleep(ms);
    }
}

/// One event of the fleet's log with its fields in the TS order.
fn log(event: &str, fields: Vec<(&str, Value)>) {
    let fields: Map<String, Value> = fields
        .into_iter()
        .map(|(key, value)| (key.to_owned(), value))
        .collect();
    log_fleet_event(event, Some(&fields));
}

fn host_message(error: DesktopHostError) -> String {
    error.message()
}

/// `makeContinueConversation`: reopen one stopped conversation on the target, verify it and send
/// once.
pub fn make_continue_conversation(
    evidence: Arc<NativeDesktopContinuationEvidence>,
) -> impl Fn(&QuotaStop, &Account, &str, &mut BeforeSend<'_>) -> Result<FleetResult, String>
+ Send
+ Sync
+ 'static {
    move |stop, target, request_id, before_send| {
        continue_conversation(&evidence, stop, target, request_id, before_send)
    }
}

fn continue_conversation(
    evidence: &NativeDesktopContinuationEvidence,
    stop: &QuotaStop,
    target: &Account,
    request_id: &str,
    before_send: &mut BeforeSend<'_>,
) -> Result<FleetResult, String> {
    let automation: &dyn DesktopAutomation = &**STATE.automation();
    let conversation: String = stop
        .local_session_id
        .strip_prefix("local_")
        .unwrap_or(&stop.local_session_id)
        .chars()
        .take(8)
        .collect();
    // Leaves the conversation as it is, and says why in the fleet's log.
    let skip = |why: &str, fields: Vec<(&str, Value)>| {
        let mut all = vec![("conversation", json!(conversation)), ("why", json!(why))];
        all.extend(fields);
        log("continue-skip", all);
        Ok(FleetResult::Skipped)
    };
    let shown = wait_for_conversation(
        &stop.local_session_id,
        &Show {
            automation,
            evidence,
            stop,
        },
    );
    let mut snapshot = match shown {
        ShowResult::Shown { shown } => shown,
        ShowResult::Skipped {
            skipped,
            last,
            issue,
            opened,
        } => {
            let last = last.as_ref();
            return skip(
                skipped.as_str(),
                vec![
                    (
                        "shown",
                        json!(
                            last.and_then(|l| l.local_session_id.as_deref())
                                == Some(stop.local_session_id.as_str())
                        ),
                    ),
                    (
                        "permissionMode",
                        json!(last.is_some_and(|l| {
                            l.permission_mode.as_deref().is_some_and(|m| !m.is_empty())
                        })),
                    ),
                    ("screen", json!(last.and_then(|l| l.screen.clone()))),
                    ("panes", json!(last.and_then(|l| l.panes))),
                    ("opened", json!(opened)),
                    ("issue", json!(issue)),
                ],
            );
        }
    };
    let state = evidence.read(&snapshot).map_err(host_message)?;
    if state.state.identity.profile_id != target.id {
        return skip("account", Vec::new());
    }
    if state.state.session.id != stop.cli_session_id {
        return skip("session", Vec::new());
    }
    if snapshot.status != relay_core::continuation::SessionStatus::Stopped {
        return skip("status", vec![("status", json!(snapshot.status))]);
    }
    if !evidence.unchanged(stop) {
        return skip("moved-on", Vec::new());
    }
    if let Some(mode) = stop.permission_mode.as_deref().filter(|m| !m.is_empty())
        && snapshot.permission_mode.as_deref() != Some(mode)
    {
        let guard = automation_guard(&snapshot).map_err(|e| e.to_string())?;
        snapshot = automation
            .set_permission(&guard, mode)
            .map_err(host_message)?;
        if snapshot.permission_mode.as_deref() != Some(mode) {
            return skip("permission-mode", Vec::new());
        }
    }
    // Claude's own "continue when limits reset" would send a second prompt.
    if snapshot.quota_auto_resume == Some(true) && automation.supports_cancel_quota_resume() {
        // The banner may be gone on the new account; nothing to cancel.
        if let Ok(guard) = automation_guard(&snapshot)
            && let Ok(changed) = automation.cancel_quota_resume(&guard)
        {
            snapshot = changed;
        }
    }
    if snapshot.status != relay_core::continuation::SessionStatus::Stopped {
        return skip("status", vec![("status", json!(snapshot.status))]);
    }
    if !snapshot.composer_empty {
        return skip(
            "composer-not-empty",
            vec![("composerChars", json!(snapshot.composer_chars))],
        );
    }
    let before = evidence
        .delivery_after(stop, request_id)
        .map_err(host_message)?;
    if before != DeliveryStatus::Absent {
        log(
            "continue-unsent",
            vec![
                ("conversation", json!(conversation)),
                ("delivery", json!(before)),
            ],
        );
        return Ok(FleetResult::Unknown);
    }
    before_send()?;
    let sent = automation_guard(&snapshot)
        .map_err(DesktopHostError::from)
        .and_then(|guard| automation.send(&guard, request_id, CONTINUATION_TEXT));
    match sent {
        Ok(sent) => {
            // Send was pressed: how the text went in and what the screen showed next.
            let mut fields = vec![
                ("conversation", json!(conversation)),
                ("acceptedVisible", json!(sent.accepted_visible)),
                ("written", json!(sent.written)),
                ("submitted", json!(sent.submitted)),
            ];
            let after = sent
                .after
                .as_ref()
                .and_then(|after| serde_json::to_value(after).ok());
            let mut map: Map<String, Value> = fields
                .drain(..)
                .map(|(key, value)| (key.to_owned(), value))
                .collect();
            if let Some(Value::Object(after)) = after {
                map.extend(after);
            }
            log_fleet_event("continue-sent", Some(&map));
        }
        Err(error) => {
            // Past the guard a failed send may have typed or sent: never sent again, but said
            // why.
            let (issue, step) = match error.automation() {
                Some(automation) => (
                    json!(automation.issue),
                    automation
                        .step
                        .map_or_else(|| json!("guard"), |step| json!(step)),
                ),
                None => (json!("failed"), Value::Null),
            };
            log(
                "continue-send-failed",
                vec![
                    ("conversation", json!(conversation)),
                    ("issue", issue),
                    ("step", step),
                ],
            );
            return Err(error.message());
        }
    }
    // The transcript, not the screen, says whether the turn arrived.
    let delivered = |delivery: DeliveryStatus, polls: u32| {
        log(
            "continue-delivery",
            vec![
                ("conversation", json!(conversation)),
                ("delivery", json!(delivery)),
                ("polls", json!(polls)),
            ],
        );
        delivery
    };
    for attempt in 0..110u32 {
        let delivery = evidence
            .delivery_after(stop, request_id)
            .map_err(host_message)?;
        match delivery {
            DeliveryStatus::Started => {
                delivered(delivery, attempt + 1);
                return Ok(FleetResult::Started);
            }
            DeliveryStatus::Unknown => {
                delivered(delivery, attempt + 1);
                return Ok(FleetResult::Unknown);
            }
            _ => sleep(if attempt < 10 { 500 } else { 2_000 }),
        }
    }
    let last = evidence
        .delivery_after(stop, request_id)
        .map_err(host_message)?;
    Ok(match delivered(last, 111) {
        DeliveryStatus::Started => FleetResult::Started,
        DeliveryStatus::Accepted => FleetResult::Accepted,
        _ => FleetResult::Unknown,
    })
}
