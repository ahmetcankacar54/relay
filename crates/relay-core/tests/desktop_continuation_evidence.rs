//! Port of tests/desktop-continuation-evidence.test.ts. "the periodic CPU sample is read
//! asynchronously; only the switch-time guards read synchronously" keeps its first half (a
//! `quiet_except` with an injected CPU reading); its second half reads the TS source's text.

#[path = "common/fleet_evidence.rs"]
mod helpers;

use std::collections::HashSet;
use std::fs;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use helpers::{
    ASSISTANT_ID, NEXT_ASSISTANT, ORG, USER_ID, UUID, app, append, fixture, issue_of, line, lock,
    process, recent_fixture, roster, rows, source_engine, spread, terminal, without,
};
use indexmap::IndexMap;
use relay_core::continuation::{
    ContinuationCheckpointInput, ContinuationIdentity, ContinuationQuiescence,
    ContinuationSwitchInput, DeliveryStatus, QuiescenceCoverage,
};
use relay_core::desktop_continuation_evidence::{
    BackgroundStopResult, DesktopProcess, EngineCommand, NativeDesktopContinuationEvidence,
    QuiescenceInputs, Signal, TurnState, combine_desktop_processes, continuation_turn,
    desktop_process_quiescence, engine_commands, is_desktop_claude_engine, latest_quota_ended_turn,
    moved_on, parse_cpu_times, parse_desktop_transcript, parse_listening_ports,
    transcript_turn_state,
};
use relay_core::desktop_continuation_host::DesktopContinuationEvidence;
use relay_core::fs_util::set_times;
use relay_core::shared::types::js::date_parse;
use relay_core::transcript_scan::Row;
use serde_json::{Value, json};

fn quiescence(raw: &str, selected_stopped: bool) -> ContinuationQuiescence {
    desktop_process_quiescence(
        raw,
        456,
        UUID,
        selected_stopped,
        &mut QuiescenceInputs::default(),
    )
}

fn with(raw: &str, selected_stopped: bool, mut inputs: QuiescenceInputs) -> ContinuationQuiescence {
    desktop_process_quiescence(raw, 456, UUID, selected_stopped, &mut inputs)
}

fn idle_inputs(busy: f64) -> QuiescenceInputs {
    QuiescenceInputs {
        busy_transcripts: Some(busy),
        active_pids: Some(HashSet::new()),
        ..QuiescenceInputs::default()
    }
}

fn uuid(row: &Row) -> Option<&str> {
    row.get("uuid").and_then(Value::as_str)
}

#[test]
fn process_census_preserves_paths_with_spaces_and_pairs_args_by_pid() {
    let combined: Vec<DesktopProcess> = serde_json::from_str(
        &combine_desktop_processes(
            "456 1 /Applications/Claude.app/Contents/MacOS/Claude\n457 456 /path with spaces/claude\n",
            "457 claude --resume id\n456 Claude\n",
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(combined[1].executable, "/path with spaces/claude");
    assert_eq!(combined[1].args, "claude --resume id");
}

#[test]
fn one_exact_selected_engine_with_terminal_transcript_may_remain_alive() {
    assert_eq!(
        quiescence(&roster(&[source_engine()]), true).busy_workers,
        0.0
    );
    assert_eq!(
        quiescence(&roster(&[source_engine()]), false).busy_workers,
        1.0
    );
}

#[test]
fn idle_sibling_engines_do_not_block_unfinished_transcripts_and_active_tools_do() {
    let sibling = DesktopProcess {
        pid: 458,
        args: "claude --resume eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee".into(),
        ..source_engine()
    };
    let wrapper = process(
        460,
        456,
        "/Applications/Claude.app/Contents/Helpers/disclaimer",
        "disclaimer --pgroup -- claude",
    );
    assert_eq!(
        with(
            &roster(&[source_engine(), sibling.clone(), wrapper]),
            true,
            idle_inputs(0.0)
        ),
        ContinuationQuiescence {
            coverage: QuiescenceCoverage::GuardedLocal,
            busy_workers: 0.0,
            subagents: 0.0,
            pending_tasks: 0.0,
            waiting: 0.0,
            queued_prompts: 0.0,
            scheduled_wakeups: 0.0,
            unknown_work: 0.0,
        }
    );
    assert_eq!(
        with(&roster(&[source_engine(), sibling]), true, idle_inputs(1.0)).busy_workers,
        1.0
    );
    let shell = process(459, 457, "/bin/bash", "bash");
    // A tool process blocks until CPU has been measured, and while it is busy.
    for (active, expected) in [
        (None, 1.0),
        (Some(HashSet::from([459])), 1.0),
        (Some(HashSet::new()), 0.0),
    ] {
        let inputs = QuiescenceInputs {
            active_pids: active,
            ..QuiescenceInputs::default()
        };
        assert_eq!(
            with(&roster(&[source_engine(), shell.clone()]), true, inputs).unknown_work,
            expected
        );
    }
}

#[test]
fn normal_chromium_helpers_are_allowed_but_their_arbitrary_child_is_not() {
    let helper = process(
        458,
        456,
        "/Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer)",
        "helper",
    );
    assert_eq!(
        quiescence(&roster(std::slice::from_ref(&helper)), false).unknown_work,
        0.0
    );
    assert_eq!(
        quiescence(
            &roster(&[helper, process(459, 458, "/bin/python", "python task")]),
            false
        )
        .unknown_work,
        1.0
    );
}

#[test]
fn bad_or_missing_app_census_remains_unknown() {
    let app = serde_json::to_value(app()).unwrap();
    for raw in [
        "not json".to_owned(),
        "[]".to_owned(),
        json!([app, app]).to_string(),
        json!([without(&app, "args")]).to_string(),
    ] {
        assert_eq!(quiescence(&raw, true).coverage, QuiescenceCoverage::Unknown);
    }
}

#[test]
fn claude_code_engines_are_recognized_but_those_outside_claudes_tree_do_not_block() {
    let versioned = process(
        900,
        1,
        "/Users/test/.local/share/claude/versions/2.1.296",
        "claude --resume different",
    );
    let npm = process(
        901,
        1,
        "/opt/homebrew/bin/node",
        "node /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js --resume different",
    );
    let npm_bin = DesktopProcess {
        pid: 902,
        args: "node /opt/homebrew/bin/claude --resume different".into(),
        ..npm.clone()
    };
    let npm_spaces = DesktopProcess {
        pid: 903,
        args:
            "node /Users/Test User/node_modules/@anthropic-ai/claude-code/cli.js --resume different"
                .into(),
        ..npm.clone()
    };
    let native_host = process(
        904,
        1,
        "/Applications/Claude.app/Contents/Helpers/chrome-native-host",
        "chrome-native-host",
    );
    for worker in [versioned, npm.clone(), npm_bin, npm_spaces] {
        assert!(is_desktop_claude_engine(&worker));
        let census = with(
            &roster(&[worker, native_host.clone()]),
            true,
            idle_inputs(0.0),
        );
        assert_eq!(census.busy_workers + census.unknown_work, 0.0);
    }
    assert!(!is_desktop_claude_engine(&DesktopProcess {
        args: "node /test/unrelated.js --prompt @anthropic-ai/claude-code".into(),
        ..npm
    }));
}

#[test]
fn transcript_turn_state_finished_interrupted_and_errored_turns_are_idle_tools_and_prompts_are_busy()
 {
    let user = |content: Value, extra: Value| {
        spread(
            &json!({ "type": "user", "message": { "content": content } }),
            extra,
        )
    };
    let assistant = |content: Value, stop_reason: Value| json!({ "type": "assistant", "message": { "content": content, "stop_reason": stop_reason } });
    let cases: Vec<(Vec<Value>, TurnState)> = vec![
        (
            vec![
                user(json!("hi"), json!({})),
                assistant(
                    json!([{ "type": "text", "text": "done" }]),
                    json!("end_turn"),
                ),
            ],
            TurnState::Idle,
        ),
        (vec![user(json!("hi"), json!({}))], TurnState::Busy),
        (
            vec![user(
                json!([{ "type": "tool_result", "content": "ok" }]),
                json!({}),
            )],
            TurnState::Busy,
        ),
        (
            vec![assistant(
                json!([{ "type": "tool_use", "name": "Bash" }]),
                json!("tool_use"),
            )],
            TurnState::Busy,
        ),
        (
            vec![user(json!("[Request interrupted by user]"), json!({}))],
            TurnState::Idle,
        ),
        (
            vec![
                user(json!("hi"), json!({})),
                spread(
                    &assistant(json!("limited"), Value::Null),
                    json!({ "error": "rate_limit" }),
                ),
            ],
            TurnState::Idle,
        ),
        (
            vec![
                assistant(json!([{ "type": "text", "text": "x" }]), json!("end_turn")),
                user(json!("note"), json!({ "isMeta": true })),
            ],
            TurnState::Idle,
        ),
        (
            vec![assistant(
                json!([{ "type": "text", "text": "x" }]),
                Value::Null,
            )],
            TurnState::Busy,
        ),
        (vec![], TurnState::Idle),
    ];
    for (list, expected) in cases {
        assert_eq!(transcript_turn_state(&rows(&list)), expected, "{list:?}");
    }
}

#[test]
fn cumulative_cpu_times_parse_minutes_hours_and_days() {
    let times = parse_cpu_times("  1 161:55.53\n 295   0:00.96\n 7 1-02:03:04.50\nbad line\n");
    assert_eq!(times[&1], 161.0 * 60.0 + 55.53);
    assert_eq!(times[&295], 0.96);
    assert_eq!(times[&7], 86_400.0 + 2.0 * 3600.0 + 3.0 * 60.0 + 4.5);
    assert_eq!(times.len(), 3);
}

fn turn_id(list: &[Value]) -> Option<String> {
    latest_quota_ended_turn(&rows(list)).map(|t| t.turn_id)
}

#[test]
fn only_the_latest_main_assistant_structured_rate_error_is_a_quota_ended_turn() {
    assert_eq!(turn_id(&[terminal()]).as_deref(), Some(ASSISTANT_ID));
    assert_eq!(
        turn_id(&[
            terminal(),
            json!({ "type": "user", "uuid": USER_ID, "message": { "content": "new task" } }),
        ]),
        None
    );
    assert_eq!(
        turn_id(&[spread(&terminal(), json!({ "error": "network_error" }))]),
        None
    );
    assert_eq!(
        turn_id(&[spread(&terminal(), json!({ "isSidechain": true }))]),
        None
    );
}

const NOTICE_A: &str = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const NOTICE_B: &str = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2";

/// A background task's notification, as Claude Code writes it.
fn notice(id: &str, parent_uuid: &str) -> Value {
    json!({
        "type": "user",
        "uuid": id,
        "parentUuid": parent_uuid,
        "timestamp": "2026-10-13T14:00:30.000Z",
        "origin": { "kind": "task-notification", "producer": "session-task" },
        "message": {
            "role": "user",
            "content": "<task-notification>\n<task-id>a3870edfc2231487c</task-id>\n<status>completed</status>\n</task-notification>",
        },
    })
}

#[test]
fn task_notifications_after_a_quota_stop_leave_it_stopped_and_idle_after_a_finished_turn_they_start_one()
 {
    let stopped = vec![
        terminal(),
        notice(NOTICE_A, ASSISTANT_ID),
        notice(NOTICE_B, NOTICE_A),
    ];
    assert_eq!(transcript_turn_state(&rows(&stopped)), TurnState::Idle);
    assert_eq!(turn_id(&stopped).as_deref(), Some(ASSISTANT_ID));
    assert_eq!(
        latest_quota_ended_turn(&rows(&stopped)).unwrap().timestamp,
        date_parse("2026-10-13T14:00:00.000Z")
    );
    // Older transcripts carry no origin; the text still says what the row is.
    let legacy = without(&notice(NOTICE_A, ASSISTANT_ID), "origin");
    assert_eq!(
        transcript_turn_state(&rows(&[terminal(), legacy.clone()])),
        TurnState::Idle
    );
    assert_eq!(
        turn_id(&[terminal(), legacy]).as_deref(),
        Some(ASSISTANT_ID)
    );
    // A newer quota stop answering a notification is the stop.
    let mut newer = stopped.clone();
    newer.push(spread(
        &terminal(),
        json!({ "uuid": NEXT_ASSISTANT, "parentUuid": NOTICE_B }),
    ));
    assert_eq!(turn_id(&newer).as_deref(), Some(NEXT_ASSISTANT));
    // With quota, a notification after a finished or otherwise failed turn starts a new turn:
    // work is running until its reply ends.
    for before in [
        json!({
            "type": "assistant",
            "uuid": ASSISTANT_ID,
            "message": { "content": [{ "type": "text", "text": "done" }], "stop_reason": "end_turn" },
        }),
        spread(&terminal(), json!({ "error": "network_error" })),
    ] {
        let list = vec![before.clone(), notice(NOTICE_A, ASSISTANT_ID)];
        assert_eq!(
            transcript_turn_state(&rows(&list)),
            TurnState::Busy,
            "{before}"
        );
        assert_eq!(turn_id(&list), None);
    }
    // A person's prompt, even one quoting a notification, ends the stop.
    for after in [
        json!({ "type": "user", "uuid": USER_ID, "message": { "content": "go on" } }),
        spread(
            &notice(USER_ID, NOTICE_A),
            json!({ "origin": { "kind": "human" } }),
        ),
    ] {
        let mut list = stopped.clone();
        list.push(after.clone());
        assert_eq!(
            transcript_turn_state(&rows(&list)),
            TurnState::Busy,
            "{after}"
        );
        assert_eq!(turn_id(&list), None);
    }
}

fn turn_assistant(list: &[Value], request: Option<&str>) -> Option<String> {
    continuation_turn(&rows(list), request)?
        .assistant
        .and_then(|a| uuid(&a).map(str::to_owned))
}

#[test]
fn the_receipt_looks_past_claudes_synthetic_reply_before_the_prompt_and_notifications_after_it() {
    let filler = "f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0";
    // What Claude Code writes before the first prompt after a stop.
    let no_response = json!({
        "type": "assistant",
        "uuid": filler,
        "parentUuid": NOTICE_B,
        "isApiErrorMessage": false,
        "message": {
            "model": "<synthetic>",
            "role": "assistant",
            "stop_reason": "stop_sequence",
            "content": [{ "type": "text", "text": "No response requested." }],
        },
    });
    let prompt = json!({
        "type": "user",
        "uuid": USER_ID,
        "parentUuid": filler,
        "message": { "content": "Continue\n[Relay continuation: request]" },
    });
    let reply = json!({
        "type": "assistant",
        "uuid": NEXT_ASSISTANT,
        "parentUuid": USER_ID,
        "message": {
            "model": "claude-opus-5-5",
            "content": [{ "type": "text", "text": "ok" }],
            "stop_reason": "end_turn",
        },
    });
    let accepted = continuation_turn(
        &rows(&[no_response.clone(), prompt.clone()]),
        Some("request"),
    )
    .unwrap();
    assert_eq!(uuid(&accepted.user), Some(USER_ID));
    assert_eq!(accepted.assistant, None);
    assert_eq!(
        turn_assistant(
            &[no_response.clone(), prompt.clone(), reply.clone()],
            Some("request")
        )
        .as_deref(),
        Some(NEXT_ASSISTANT)
    );
    // A background task finishing during the resumed turn is not a new prompt.
    assert_eq!(
        turn_assistant(
            &[
                no_response.clone(),
                prompt.clone(),
                reply,
                notice(NOTICE_A, NEXT_ASSISTANT)
            ],
            Some("request")
        )
        .as_deref(),
        Some(NEXT_ASSISTANT)
    );
    // A synthetic row after the prompt proves nothing resumed.
    assert_eq!(
        turn_assistant(
            &[
                prompt.clone(),
                spread(
                    &no_response,
                    json!({ "uuid": NEXT_ASSISTANT, "parentUuid": USER_ID })
                ),
            ],
            Some("request")
        ),
        None
    );
    // One outside the prompt's own chain is still other work.
    assert_eq!(
        continuation_turn(
            &rows(&[
                no_response,
                spread(&prompt, json!({ "parentUuid": NOTICE_B }))
            ]),
            Some("request")
        ),
        None
    );
}

#[test]
fn partial_or_malformed_transcript_records_cannot_become_a_safe_checkpoint() {
    assert!(parse_desktop_transcript(br#"{"type":"assistant"}"#).is_err());
    assert!(parse_desktop_transcript(b"invalid\n").is_err());
    assert_eq!(
        parse_desktop_transcript(b"{\"type\":\"assistant\"}\n")
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn continuation_receipt_binds_the_latest_assistant_chain_to_the_nonce_user_turn() {
    let working = vec![
        json!({
            "type": "user",
            "uuid": USER_ID,
            "message": { "content": "Continue\n[Relay continuation: request]" },
        }),
        json!({
            "type": "assistant",
            "uuid": ASSISTANT_ID,
            "parentUuid": USER_ID,
            "message": { "content": [{ "type": "tool_use" }], "stop_reason": "tool_use" },
        }),
        json!({
            "type": "user",
            "uuid": NEXT_ASSISTANT.replace('d', "e"),
            "parentUuid": ASSISTANT_ID,
            "message": { "content": [{ "type": "tool_result", "content": "ok" }] },
        }),
    ];
    // A tool result as the latest row still proves the resumed turn started.
    assert_eq!(
        turn_assistant(&working, Some("request")).as_deref(),
        Some(ASSISTANT_ID)
    );
    let user = json!({
        "type": "user",
        "uuid": USER_ID,
        "message": { "content": "Continue\n[Relay continuation: request]" },
    });
    let assistant = json!({
        "type": "assistant",
        "uuid": ASSISTANT_ID,
        "parentUuid": USER_ID,
        "message": { "content": "started" },
    });
    let last = spread(
        &assistant,
        json!({ "uuid": NEXT_ASSISTANT, "parentUuid": ASSISTANT_ID }),
    );
    assert_eq!(turn_assistant(std::slice::from_ref(&user), None), None);
    assert_eq!(
        turn_assistant(&[user.clone(), assistant.clone(), last], Some("request")).as_deref(),
        Some(NEXT_ASSISTANT)
    );
    assert_eq!(
        continuation_turn(
            &rows(&[
                user.clone(),
                spread(&assistant, json!({ "parentUuid": UUID }))
            ]),
            Some("request")
        ),
        None
    );
    assert_eq!(
        continuation_turn(
            &rows(&[
                user,
                assistant,
                json!({ "type": "user", "uuid": UUID, "message": { "content": "human changed the task" } }),
            ]),
            Some("request")
        ),
        None
    );
}

#[test]
fn every_supported_quota_error_form_acknowledges_the_user_turn_without_claiming_resumed_work() {
    let user = json!({
        "type": "user",
        "uuid": USER_ID,
        "message": { "content": "Continue\n[Relay continuation: request]" },
    });
    for reason in [
        "rate_limit",
        "rate_limit_error",
        "rate-limit",
        "usage_limit",
    ] {
        for error in [
            json!({ "error": reason }),
            json!({ "error": { "type": reason } }),
            json!({ "errorType": reason }),
            json!({ "apiError": { "type": reason } }),
            json!({ "message": { "content": "limited", "stop_reason": reason } }),
        ] {
            let assistant = spread(
                &json!({
                    "type": "assistant",
                    "uuid": ASSISTANT_ID,
                    "parentUuid": USER_ID,
                    "timestamp": "2026-10-13T14:00:00.000Z",
                    "message": { "content": "limited" },
                }),
                error,
            );
            let list = vec![user.clone(), assistant];
            assert_eq!(turn_id(&list).as_deref(), Some(ASSISTANT_ID));
            let turn = continuation_turn(&rows(&list), Some("request")).unwrap();
            assert_eq!(uuid(&turn.user), Some(USER_ID));
            assert_eq!(turn.assistant, None);
        }
    }
    for error in [
        json!({ "errorType": "network_error" }),
        json!({ "errorType": "overloaded_error" }),
        json!({ "isApiErrorMessage": true }),
    ] {
        let list = vec![
            user.clone(),
            spread(
                &json!({
                    "type": "assistant",
                    "uuid": ASSISTANT_ID,
                    "parentUuid": USER_ID,
                    "message": { "content": "request failed" },
                }),
                error,
            ),
        ];
        assert_eq!(turn_id(&list), None);
        assert_eq!(turn_assistant(&list, Some("request")), None);
    }
}

fn read(
    f: &helpers::Fixture,
) -> relay_core::desktop_continuation_host::DesktopContinuationObservation {
    f.evidence.read(&f.ui()).unwrap()
}

#[test]
fn real_metadata_adapter_binds_alias_account_project_transcript_and_quota_turn() {
    let f = fixture();
    let state = read(&f);
    assert_eq!(state.state.session.id, UUID);
    assert_eq!(state.state.identity.profile_id, f.source.id);
    assert_eq!(
        state.quota_stop.as_ref().map(|s| s.turn_id.as_str()),
        Some(ASSISTANT_ID)
    );
    assert_eq!(
        state.state.quiescence.coverage,
        QuiescenceCoverage::GuardedLocal
    );
    assert_eq!(
        state.state.session.project_key,
        f.path().join("project").to_string_lossy()
    );
    assert_eq!(
        state.state.context_revision,
        read(&f).state.context_revision
    );
    lock(&f.ui).quota_auto_resume = Some(true);
    let wake = read(&f);
    assert_eq!(wake.state.quiescence.scheduled_wakeups, 1.0);
    assert_eq!(wake.own_quota_wakeup, Some(true));
}

fn delivery(f: &helpers::Fixture, request: &str) -> (DeliveryStatus, Option<String>) {
    let found = f.evidence.lookup_delivery(request).unwrap();
    (found.status, found.receipt.map(|r| r.turn_id))
}

#[test]
fn durable_receipt_progresses_absent_accepted_started_with_exact_assistant_turn_id() {
    let f = fixture();
    let state = read(&f);
    f.evidence
        .checkpoint(&ContinuationCheckpointInput {
            request_id: "request".into(),
            session: state.state.session.clone(),
            expected_context_revision: state.state.context_revision,
        })
        .unwrap();
    f.evidence
        .switch_account(&ContinuationSwitchInput {
            request_id: "request".into(),
            target: ContinuationIdentity {
                profile_id: f.target.id.clone(),
                account_uuid: f.target.id.clone(),
                org_id: ORG.into(),
            },
            expected_context_revision: state.state.context_revision,
        })
        .unwrap();
    assert_eq!(delivery(&f, "request"), (DeliveryStatus::Absent, None));
    let user = json!({
        "type": "user",
        "uuid": USER_ID,
        "parentUuid": ASSISTANT_ID,
        "message": { "content": "Continue\n[Relay continuation: request]" },
    });
    append(&f.transcript_file, &line(&user));
    assert_eq!(delivery(&f, "request"), (DeliveryStatus::Accepted, None));
    for (index, error) in [
        json!({ "errorType": "rate_limit" }),
        json!({ "message": { "content": "quota exhausted", "stop_reason": "usage_limit" } }),
    ]
    .into_iter()
    .enumerate()
    {
        append(
            &f.transcript_file,
            &line(&spread(
                &json!({
                    "type": "assistant",
                    "uuid": format!("00000000-0000-4000-8000-{:012}", index + 1),
                    "parentUuid": USER_ID,
                    "timestamp": "2026-10-13T14:01:00.000Z",
                    "message": { "content": "quota exhausted" },
                }),
                error,
            )),
        );
        assert_eq!(delivery(&f, "request"), (DeliveryStatus::Accepted, None));
    }
    append(
        &f.transcript_file,
        &line(&json!({
            "type": "assistant",
            "uuid": NEXT_ASSISTANT,
            "parentUuid": USER_ID,
            "message": { "content": "continuing", "stop_reason": "end_turn" },
        })),
    );
    let receipt = f.evidence.lookup_delivery("request").unwrap();
    assert_eq!(receipt.status, DeliveryStatus::Started);
    let receipt = receipt.receipt.unwrap();
    assert_eq!(receipt.turn_id, NEXT_ASSISTANT);
    let after = read(&f);
    assert_eq!(
        after.state.session.last_request_id.as_deref(),
        Some("request")
    );
    assert_eq!(
        after.state.session.last_turn_id.as_deref(),
        Some(NEXT_ASSISTANT)
    );
    assert_eq!(
        after.state.session.transcript_revision,
        receipt.after_revision
    );
    append(
        &f.transcript_file,
        &line(&json!({
            "type": "assistant",
            "uuid": "ffffffff-ffff-4fff-8fff-ffffffffffff",
            "parentUuid": NEXT_ASSISTANT,
            "isApiErrorMessage": true,
            "error": "rate_limit",
            "apiError": { "type": "rate_limit_error" },
            "timestamp": "2026-10-13T14:01:00.000Z",
            "message": { "content": "rate limit", "stop_reason": "stop_sequence" },
        })),
    );
    // The handoff succeeded: work resumed on the target before its own limit.
    assert_eq!(
        delivery(&f, "request"),
        (DeliveryStatus::Started, Some(NEXT_ASSISTANT.into()))
    );
    append(
        &f.transcript_file,
        &line(
            &json!({ "type": "user", "uuid": UUID, "message": { "content": "new manual prompt" } }),
        ),
    );
    assert_eq!(delivery(&f, "request"), (DeliveryStatus::Unknown, None));
}

#[test]
fn a_conversation_whose_tools_changed_directory_is_still_observed_another_unfinished_turn_blocks() {
    let f = fixture();
    let cwd = f.path().join("project");
    fs::write(
        &f.transcript_file,
        [
            json!({ "type": "user", "uuid": USER_ID, "cwd": cwd, "message": { "content": "go" } }),
            json!({ "type": "attachment", "cwd": cwd.join("app").join("Models") }),
            spread(
                &terminal(),
                json!({ "parentUuid": USER_ID, "cwd": cwd.join("app") }),
            ),
        ]
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n")
            + "\n",
    )
    .unwrap();
    let quiet = read(&f);
    assert_eq!(
        quiet.quota_stop.as_ref().map(|s| s.turn_id.as_str()),
        Some(ASSISTANT_ID)
    );
    assert_eq!(quiet.state.quiescence.busy_workers, 0.0);
    let other = f
        .transcript_file
        .parent()
        .unwrap()
        .join(format!("{USER_ID}.jsonl"));
    fs::write(
        &other,
        line(&json!({ "type": "user", "message": { "content": "still working" } })),
    )
    .unwrap();
    assert_eq!(read(&f).state.quiescence.busy_workers, 1.0);
    // A transcript last written long ago is not a live conversation.
    let old = SystemTime::UNIX_EPOCH
        + Duration::from_millis(date_parse("2026-10-13T10:00:00.000Z") as u64);
    set_times(&other, old).unwrap();
    assert_eq!(read(&f).state.quiescence.busy_workers, 0.0);
}

#[test]
fn other_empty_organization_folders_of_the_account_do_not_hide_the_open_conversations_organization()
{
    let f = fixture();
    let other = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    *lock(&f.desktop.organizations) = vec![other.into(), ORG.into()];
    let mut ui = f.ui();
    ui.account_label = Some("Ahmet".into());
    let state = f.evidence.read(&ui).unwrap();
    assert_eq!(state.state.identity.profile_id, f.source.id);
    // The same record under another organization makes the scope ambiguous.
    let duplicate = f
        .path()
        .join("desktop")
        .join("claude-code-sessions")
        .join(&f.source.id)
        .join(other)
        .join(format!("local_{UUID}.json"));
    fs::create_dir_all(duplicate.parent().unwrap()).unwrap();
    fs::write(&duplicate, "{}").unwrap();
    assert!(issue_of(f.evidence.read(&ui)).contains("desktop-observation-incomplete"));
}

#[test]
fn every_quota_stopped_conversation_of_an_account_is_found_from_files_and_its_continuation_is_verified()
 {
    let f = recent_fixture();
    let account = f.account(&f.source.id);
    let stops = f.evidence.quota_stops(&account, None).unwrap();
    assert_eq!(stops.len(), 1);
    assert_eq!(stops[0].local_session_id, format!("local_{UUID}"));
    assert_eq!(stops[0].cli_session_id, UUID);
    assert_eq!(stops[0].turn_id, ASSISTANT_ID);
    assert_eq!(stops[0].permission_mode.as_deref(), Some("Auto"));
    assert!(f.evidence.unchanged(&stops[0]));
    assert_eq!(f.evidence.quiet_except(&stops).unwrap(), None);
    assert_eq!(
        f.evidence.delivery_after(&stops[0], "r1").unwrap(),
        DeliveryStatus::Absent
    );
    append(
        &f.transcript_file,
        &line(&json!({
            "type": "user",
            "uuid": USER_ID,
            "parentUuid": ASSISTANT_ID,
            "message": { "content": "Continue\n[Relay continuation: r1]" },
        })),
    );
    assert!(!f.evidence.unchanged(&stops[0]));
    assert_eq!(
        f.evidence.delivery_after(&stops[0], "r1").unwrap(),
        DeliveryStatus::Accepted
    );
    append(
        &f.transcript_file,
        &line(&json!({
            "type": "assistant",
            "uuid": NEXT_ASSISTANT,
            "parentUuid": USER_ID,
            "message": { "content": [{ "type": "text", "text": "ok" }], "stop_reason": "end_turn" },
        })),
    );
    assert_eq!(
        f.evidence.delivery_after(&stops[0], "r1").unwrap(),
        DeliveryStatus::Started
    );
    // The conversation no longer ends at its limit.
    assert_eq!(f.evidence.quota_stops(&account, None).unwrap().len(), 0);
}

fn append_rows(f: &helpers::Fixture, list: &[Value]) {
    append(
        &f.transcript_file,
        &list.iter().map(line).collect::<String>(),
    );
}

#[test]
fn a_quota_stop_followed_by_background_task_notifications_is_a_quiet_stop_and_its_continuation_is_verified()
 {
    let f = recent_fixture();
    let account = f.account(&f.source.id);
    // Scanned once before the notifications, as polling does.
    assert_eq!(f.evidence.quota_stops(&account, None).unwrap().len(), 1);
    append_rows(
        &f,
        &[
            json!({ "type": "queue-operation", "operation": "enqueue" }),
            notice(NOTICE_A, ASSISTANT_ID),
            json!({ "type": "queue-operation", "operation": "dequeue" }),
            notice(NOTICE_B, NOTICE_A),
        ],
    );
    let stops = f.evidence.quota_stops(&account, None).unwrap();
    assert_eq!(stops.len(), 1);
    assert_eq!(stops[0].turn_id, ASSISTANT_ID);
    assert_eq!(stops[0].stopped_at, date_parse("2026-10-13T14:00:00.000Z"));
    assert_eq!(
        stops[0].transcript_bytes,
        fs::metadata(&f.transcript_file).unwrap().len()
    );
    assert!(f.evidence.unchanged(&stops[0]));
    // Neither the fleet's check nor the open conversation's sees work running.
    assert_eq!(f.evidence.quiet_except(&[]).unwrap(), None);
    let state = read(&f);
    assert_eq!(
        state.quota_stop.as_ref().map(|s| s.turn_id.as_str()),
        Some(ASSISTANT_ID)
    );
    assert_eq!(state.state.quiescence.busy_workers, 0.0);
    // With quota, a notification after a finished turn is work running.
    let other = f
        .transcript_file
        .parent()
        .unwrap()
        .join(format!("{USER_ID}.jsonl"));
    fs::write(
        &other,
        [
            json!({
                "type": "assistant",
                "uuid": NEXT_ASSISTANT,
                "message": { "content": "done", "stop_reason": "end_turn" },
            }),
            notice(NOTICE_A, NEXT_ASSISTANT),
        ]
        .iter()
        .map(line)
        .collect::<String>(),
    )
    .unwrap();
    assert_eq!(
        f.evidence.quiet_except(&stops).unwrap().as_deref(),
        Some("not-quiescent:busyWorkers")
    );
    fs::remove_file(&other).unwrap();
    // After the switch, Claude writes its synthetic reply, then the prompt.
    assert_eq!(
        f.evidence.delivery_after(&stops[0], "r1").unwrap(),
        DeliveryStatus::Absent
    );
    let filler = "f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0";
    append_rows(
        &f,
        &[
            json!({
                "type": "assistant",
                "uuid": filler,
                "parentUuid": NOTICE_B,
                "isApiErrorMessage": false,
                "message": {
                    "model": "<synthetic>",
                    "stop_reason": "stop_sequence",
                    "content": [{ "type": "text", "text": "No response requested." }],
                },
            }),
            json!({
                "type": "user",
                "uuid": USER_ID,
                "parentUuid": filler,
                "origin": { "kind": "human" },
                "message": { "content": "Continue\n[Relay continuation: r1]" },
            }),
        ],
    );
    assert_eq!(
        f.evidence.delivery_after(&stops[0], "r1").unwrap(),
        DeliveryStatus::Accepted
    );
    append_rows(
        &f,
        &[json!({
            "type": "assistant",
            "uuid": NEXT_ASSISTANT,
            "parentUuid": USER_ID,
            "message": {
                "model": "claude-opus-5-5",
                "content": [{ "type": "text", "text": "ok" }],
                "stop_reason": "end_turn",
            },
        })],
    );
    assert_eq!(
        f.evidence.delivery_after(&stops[0], "r1").unwrap(),
        DeliveryStatus::Started
    );
    assert_eq!(f.evidence.quota_stops(&account, None).unwrap().len(), 0);
}

#[test]
fn claudes_own_rows_after_a_stop_as_it_quits_and_opens_again_leave_the_stop_unchanged_a_prompt_does_not()
 {
    let f = recent_fixture();
    let account = f.account(&f.source.id);
    let stop = f.evidence.quota_stops(&account, None).unwrap().remove(0);
    // Seen in real transcripts after a switch: bookkeeping rows, a background task's notice
    // queued and written to the transcript only, titles and modes.
    append_rows(
        &f,
        &[
            json!({ "type": "last-prompt", "lastPrompt": "x" }),
            json!({ "type": "cost-state", "cost": 1 }),
            json!({
                "type": "queue-operation",
                "operation": "enqueue",
                "content": "<task-notification>\n<task-id>t1</task-id>",
            }),
            json!({ "type": "queue-operation", "operation": "dequeue" }),
            spread(
                &notice(NOTICE_A, ASSISTANT_ID),
                json!({ "queueTranscriptOnly": true }),
            ),
            json!({ "type": "custom-title", "customTitle": "t" }),
            json!({ "type": "isolation-latch" }),
            json!({ "type": "system", "subtype": "stop_hook_summary" }),
        ],
    );
    assert!(f.evidence.unchanged(&stop));
    // The stop is still the conversation's latest turn, and nothing reads as running.
    assert_eq!(
        f.evidence.quota_stops(&account, None).unwrap()[0].turn_id,
        stop.turn_id
    );
    assert_eq!(f.evidence.quiet_except(&[]).unwrap(), None);
    // A prompt queued to be sent, or one sent, is the conversation moving on.
    let queued = stop.clone();
    append_rows(
        &f,
        &[json!({ "type": "queue-operation", "operation": "enqueue", "content": "carry on" })],
    );
    assert!(!f.evidence.unchanged(&queued));
}

#[test]
fn the_rows_that_move_a_stopped_conversation_on() {
    let prompt = json!({ "type": "user", "message": { "content": "go" } });
    let cases: Vec<(Vec<Value>, bool)> = vec![
        (vec![prompt.clone()], true),
        (
            vec![json!({ "type": "assistant", "message": { "content": [] } })],
            true,
        ),
        // A stopped command's notification, answered by the limit again (seen live 2026-10-26).
        (
            vec![
                json!({
                    "type": "user",
                    "origin": { "kind": "task-notification" },
                    "message": { "content": "<task-notification>" },
                }),
                json!({
                    "type": "assistant",
                    "isApiErrorMessage": true,
                    "error": "rate_limit",
                    "message": { "content": [{ "type": "text", "text": "You've hit your session limit" }] },
                }),
            ],
            false,
        ),
        (
            vec![json!({
                "type": "assistant",
                "isApiErrorMessage": true,
                "error": "overloaded",
                "message": { "content": [] },
            })],
            true,
        ),
        (
            vec![json!({ "type": "attachment", "attachment": { "type": "queued_command" } })],
            true,
        ),
        (
            vec![json!({
                "type": "queue-operation",
                "operation": "enqueue",
                "content": [{ "type": "image" }],
            })],
            true,
        ),
        (vec![spread(&prompt, json!({ "isSidechain": true }))], false),
        (vec![spread(&prompt, json!({ "isMeta": true }))], false),
        (
            vec![json!({
                "type": "user",
                "origin": { "kind": "task-notification" },
                "message": { "content": "<task-notification>" },
            })],
            false,
        ),
        (
            vec![json!({ "type": "attachment", "attachment": { "type": "todo_reminder" } })],
            false,
        ),
        (
            vec![json!({ "type": "queue-operation", "operation": "remove" })],
            false,
        ),
        (vec![], false),
    ];
    for (list, expected) in cases {
        assert_eq!(moved_on(&rows(&list)), expected, "{list:?}");
    }
}

#[test]
fn a_notice_written_to_the_transcript_only_starts_no_turn_so_it_hides_no_finished_turn() {
    let finished = json!({
        "type": "assistant",
        "uuid": "a",
        "message": { "content": [{ "type": "text", "text": "done" }], "stop_reason": "end_turn" },
    });
    let notice = json!({
        "type": "user",
        "origin": { "kind": "task-notification" },
        "queueTranscriptOnly": true,
        "message": { "content": "<task-notification>\n<task-id>t</task-id>" },
    });
    assert_eq!(
        transcript_turn_state(&rows(&[finished.clone(), notice.clone()])),
        TurnState::Idle
    );
    // One that is sent to the model starts a turn, as before.
    let sent = without(&notice, "queueTranscriptOnly");
    assert_eq!(
        transcript_turn_state(&rows(&[finished, sent])),
        TurnState::Busy
    );
}

#[test]
fn quota_stop_polling_follows_a_growing_transcript_and_refuses_a_malformed_one() {
    let f = recent_fixture();
    let account = f.account(&f.source.id);
    let stops = |f: &helpers::Fixture| f.evidence.quota_stops(&account, None).unwrap();
    assert_eq!(stops(&f).len(), 1);
    // Agent and meta rows after the stop do not end the main chain's turn.
    append_rows(
        &f,
        &[json!({ "type": "assistant", "uuid": NEXT_ASSISTANT, "isSidechain": true })],
    );
    append_rows(
        &f,
        &[json!({ "type": "user", "uuid": USER_ID, "isMeta": true })],
    );
    let stop = stops(&f).remove(0);
    assert_eq!(stop.turn_id, ASSISTANT_ID);
    assert_eq!(
        stop.transcript_bytes,
        fs::metadata(&f.transcript_file).unwrap().len()
    );
    assert!(f.evidence.unchanged(&stop));
    // A line still being written hides the conversation until it is complete.
    append(&f.transcript_file, r#"{"type":"summary""#);
    assert_eq!(stops(&f).len(), 0);
    append(&f.transcript_file, "}\n");
    assert_eq!(stops(&f).len(), 1);
    // A malformed line makes the transcript unusable, also after more rows.
    append(&f.transcript_file, "{not json\n");
    assert_eq!(stops(&f).len(), 0);
    append_rows(
        &f,
        &[spread(&terminal(), json!({ "uuid": NEXT_ASSISTANT }))],
    );
    assert_eq!(stops(&f).len(), 0);
}

#[test]
fn a_known_conversations_project_folder_is_looked_up_alone_without_listing_every_folder() {
    let f = recent_fixture();
    #[cfg(unix)]
    let projects = f.path().join("transcripts").join("projects");
    let account = f.account(&f.source.id);
    assert_eq!(f.evidence.quota_stops(&account, None).unwrap().len(), 1);
    // The project list cannot be read now; the folder found before still can.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&projects, fs::Permissions::from_mode(0o333)).unwrap();
    }
    let found = f.evidence.quota_stops(&account, None);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&projects, fs::Permissions::from_mode(0o755)).unwrap();
    }
    let stop = found.unwrap().into_iter().next();
    assert_eq!(
        stop.map(|s| s.transcript_relative),
        Some(format!("projects/-test/{UUID}.jsonl"))
    );
}

#[test]
fn a_conversation_no_folder_holds_is_probed_again_only_after_a_minute() {
    let f = recent_fixture();
    let aside = f.transcript_file.with_extension("jsonl.aside");
    let account = f.account(&f.source.id);
    let count = || f.evidence.quota_stops(&account, None).unwrap().len();
    fs::rename(&f.transcript_file, &aside).unwrap();
    assert_eq!(count(), 0);
    fs::rename(&aside, &f.transcript_file).unwrap();
    lock(&f.ui).observed_at += 30_000;
    assert_eq!(count(), 0);
    lock(&f.ui).observed_at += 30_000;
    assert_eq!(count(), 1);
    // A folder that lost the transcript is forgotten and probed again.
    let moved = f.path().join("transcripts").join("projects").join("-moved");
    fs::create_dir(&moved).unwrap();
    fs::rename(&f.transcript_file, moved.join(format!("{UUID}.jsonl"))).unwrap();
    let found = f.evidence.quota_stops(&account, None).unwrap();
    assert_eq!(
        found.first().map(|s| s.transcript_relative.clone()),
        Some(format!("projects/-moved/{UUID}.jsonl"))
    );
}

#[test]
fn the_periodic_cpu_sample_is_read_asynchronously_only_the_switch_time_guards_read_synchronously() {
    let f = recent_fixture();
    let stops = f
        .evidence
        .quota_stops(&f.account(&f.source.id), None)
        .unwrap();
    let mut options = f.options();
    options.processes = Some(Box::new(|| Ok(roster(&[]))));
    options.cpu_times = Some(Box::new(|| Ok("456 0:01.00\n".into())));
    let clock = Arc::clone(&f.ui);
    options.now = Some(Box::new(move || lock(&clock).observed_at as f64));
    let evidence = NativeDesktopContinuationEvidence::new(options).unwrap();
    assert_eq!(evidence.quiet_except(&stops).unwrap(), None);
}

fn engine_shell(pid: i64, ppid: i64, command: &str) -> DesktopProcess {
    process(
        pid,
        ppid,
        "/bin/zsh",
        &format!(
            "/bin/zsh -c source /Users/me/.claude/shell-snapshots/snapshot-zsh-1-ab.sh 2>/dev/null || true && eval '{command}'"
        ),
    )
}

fn dev_server() -> Vec<DesktopProcess> {
    vec![
        engine_shell(600, 457, "npm run dev"),
        process(601, 600, "/usr/local/bin/node", "node vite"),
        process(602, 601, "/x/esbuild", "esbuild --service"),
    ]
}

#[test]
fn a_command_an_engine_runs_in_its_own_shell_is_a_background_command_mcp_servers_and_other_shells_are_not()
 {
    let mut census = vec![
        app(),
        source_engine(),
        process(510, 457, "/usr/local/bin/node", "node playwright-mcp"),
    ];
    census.extend(dev_server());
    // A shell under Claude but not under an engine, and a Terminal one outside Claude.
    census.push(engine_shell(700, 456, "ls"));
    census.push(engine_shell(800, 1, "ls"));
    assert_eq!(
        engine_commands(&census, 456),
        vec![EngineCommand {
            pid: 600,
            pids: vec![600, 601, 602],
            names: vec!["node".into(), "esbuild".into()],
        }]
    );
}

#[test]
fn lsofs_field_output_gives_each_processs_listening_ports() {
    let ports = parse_listening_ports("p601\nn*:5173\nn[::1]:5173\np700\nn127.0.0.1:3000\nnbad\n");
    assert_eq!(
        ports.into_iter().collect::<Vec<_>>(),
        vec![(601, vec![5173]), (700, vec![3000])]
    );
}

#[test]
fn background_commands_are_weighed_apart_from_other_work_servers_by_their_ports_builds_by_their_cpu()
 {
    let f = fixture();
    let clock = Arc::new(Mutex::new(date_parse("2026-10-13T15:00:00.000Z")));
    let cpu = Arc::new(Mutex::new(String::from("601 0:01.00\n")));
    let build = vec![
        engine_shell(650, 457, "docker build ."),
        process(651, 650, "/usr/local/bin/docker", "docker build ."),
    ];
    let mut census = vec![source_engine()];
    census.extend(dev_server());
    census.extend(build);
    let mut options = f.options();
    options.processes = Some(Box::new(move || Ok(roster(&census))));
    let reading = Arc::clone(&cpu);
    options.cpu_times = Some(Box::new(move || Ok(lock(&reading).clone())));
    options.listening_ports = Some(Box::new(|pids| {
        assert_eq!(pids, [600, 601, 602, 650, 651]);
        IndexMap::from([(601, vec![5173])])
    }));
    let now = Arc::clone(&clock);
    options.now = Some(Box::new(move || *lock(&now)));
    let evidence = NativeDesktopContinuationEvidence::new(options).unwrap();
    // Busy CPU in them is not unknown work: the fleet weighs them itself.
    assert_eq!(evidence.quiet_except(&[]).unwrap(), None);
    let at = *lock(&clock);
    let first = evidence.background_commands();
    assert_eq!(
        first
            .iter()
            .map(|c| (c.pid, c.ports.clone(), c.active_at == Some(at)))
            .collect::<Vec<_>>(),
        vec![
            (600, vec![5173], true),
            // Without a CPU sample to compare with, a command counts as working.
            (650, vec![], true),
        ]
    );
    // 10 s later the build used CPU and the server did not.
    let seen = at;
    *lock(&clock) += 10_000.0;
    *lock(&cpu) = "601 0:01.00\n651 0:05.00\n".into();
    evidence.quiet_except(&[]).unwrap();
    *lock(&clock) += 10_000.0;
    *lock(&cpu) = "601 0:01.10\n651 0:09.00\n".into();
    evidence.quiet_except(&[]).unwrap();
    let later = evidence.background_commands();
    assert_eq!(later[0].seen_at, seen);
    assert_eq!(later[0].active_at, Some(seen));
    assert_eq!(later[1].active_at, Some(*lock(&clock)));
}

#[test]
fn stopping_background_commands_ends_their_process_groups_kills_what_stays_and_refuses_an_unexpected_one()
 {
    let f = fixture();
    let signals: Arc<Mutex<Vec<(i64, &'static str)>>> = Arc::default();
    let alive = Arc::new(Mutex::new(HashSet::from([600, 601, 602])));
    let stubborn = Arc::new(Mutex::new(true));
    let mut census = vec![source_engine()];
    census.extend(dev_server());
    let mut options = f.options();
    options.processes = Some(Box::new(move || Ok(roster(&census))));
    let (record, living) = (Arc::clone(&signals), Arc::clone(&alive));
    options.signal = Some(Box::new(move |pid, signal| {
        lock(&record).push((pid, signal.name()));
        let mut alive = lock(&living);
        if signal == Signal::Probe {
            return alive.contains(&pid);
        }
        if signal == Signal::Term {
            alive.remove(&600);
            alive.remove(&601);
        }
        if signal == Signal::Kill {
            *lock(&stubborn) = false;
        }
        if !*lock(&stubborn) {
            alive.clear();
        }
        pid < 0 || alive.contains(&pid)
    }));
    options.sleep = Some(Box::new(|_| {}));
    let evidence = NativeDesktopContinuationEvidence::new(options).unwrap();
    // A command the fleet did not weigh: nothing is stopped.
    assert_eq!(
        evidence.stop_background(&HashSet::from([999])).unwrap(),
        BackgroundStopResult {
            stopped: vec![],
            left: 0,
            unexpected: 1,
        }
    );
    assert_eq!(lock(&signals).len(), 0);
    // esbuild ignores TERM: it is killed.
    assert_eq!(
        evidence.stop_background(&HashSet::from([600])).unwrap(),
        BackgroundStopResult {
            stopped: vec!["node".into(), "esbuild".into()],
            left: 0,
            unexpected: 0,
        }
    );
    let signals = lock(&signals).clone();
    assert_eq!(
        signals[..4],
        [
            (-600, "SIGTERM"),
            (600, "SIGTERM"),
            (601, "SIGTERM"),
            (602, "SIGTERM"),
        ]
    );
    assert!(signals.contains(&(-600, "SIGKILL")));
}
