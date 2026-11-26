//! Port of tests/proxy-clients.test.ts: the gateway's cases (the pool's order and status, the
//! request log's feed) and the omp models.yml cases at the level of `omp_models`, the text edits
//! and file choice the host's client binding runs.
//!
//! Left to the host's client binding (relay-app `services/gateway/clients.rs`, with the
//! Claude Code and Codex client-file cases): reading and writing the file itself, i.e. the
//! `created` bookkeeping, the 0600 mode, writing through a symlinked models.yml and removing a
//! file Relay made on unbind. "quota at risk" tests `src/lib/proxy-ui.ts` (the UI) and the
//! Tailscale interface lookup is the host's; neither is ported here.

mod common;

use common::*;
use indexmap::IndexMap;
use relay_gateway::omp_models::{
    OMP_END, OMP_START, OmpBlock, OmpTarget, omp_blocked, omp_bound, omp_bound_to, omp_legacy_json,
    omp_marked, omp_models_file, omp_relay_only, omp_unbound,
};
use relay_gateway::proxy_request_log::{GatewayRequestLog, RequestLogOptions};
use relay_gateway::proxy_stats::REQUEST_LOG_SIZE;
use relay_gateway::proxy_status::{
    StatusInput, build_proxy_status, ordered_accounts, pool_accounts,
};
use relay_gateway::{AccountTokenMetrics, ProxyConfig, ProxyMetrics, ProxyRequestLog, UsageMap};
use std::fs;
use std::path::{Path, PathBuf};

#[test]
fn the_pool_keeps_its_saved_order_leaves_excluded_accounts_out_and_reports_both_windows() {
    let accounts: Vec<_> = ["a", "b", "c"]
        .iter()
        .map(|id| named(id, &id.to_uppercase()))
        .collect();
    let config = ProxyConfig {
        account_order: Some(vec!["c".into(), "gone".into(), "a".into()]),
        excluded_account_ids: Some(vec!["a".into()]),
        ..ProxyConfig::default()
    };
    let ids = |list: Vec<&relay_gateway::Account>| -> Vec<String> {
        list.into_iter().map(|a| a.id.clone()).collect()
    };
    assert_eq!(
        ids(ordered_accounts(&accounts, config.account_order.as_deref())),
        ["c", "a", "b"]
    );
    assert_eq!(
        pool_accounts(&accounts, &config)
            .iter()
            .map(|a| a.id.clone())
            .collect::<Vec<_>>(),
        ["c", "b"]
    );
    let now = parse("2026-11-09T12:00:00Z");
    let mut usage = UsageMap::new();
    usage.insert(
        "c".into(),
        ready(
            "c",
            Some(window(40.0, Some("2026-11-09T13:00:00Z".into()))),
            Some(window(70.0, Some("2026-11-10T12:00:00Z".into()))),
        ),
    );
    let metrics = ProxyMetrics {
        total_requests: 3,
        active_sessions: 0,
        requests_by_account: IndexMap::from([("c".to_string(), 3)]),
        tokens_by_account: IndexMap::from([(
            "c".to_string(),
            AccountTokenMetrics {
                input: 1.0,
                output: 2.0,
                cache_read: 30.0,
                cache_write: 4.0,
            },
        )]),
        cache_hit_ratio: 0.9,
        active_requests: 0,
        prompt_cache_hits: 0,
        last_account_id: None,
        extra_usage: None,
        last_error: None,
        last_error_at: None,
    };
    let status = build_proxy_status(StatusInput {
        metrics: Some(&metrics),
        ..StatusInput::new(true, &config, &accounts, &usage, now)
    });
    let c = &status.accounts[0];
    assert_eq!(c.id, "c");
    assert_eq!(
        (
            c.five_hour_percent,
            c.five_hour_reset_minutes,
            c.weekly_percent,
            c.weekly_reset_minutes,
            c.in_pool,
            c.requests,
            c.tokens.as_ref().map(|t| t.cache_read),
        ),
        (
            Some(40),
            Some(60),
            Some(70),
            Some(1_440),
            true,
            3,
            Some(30.0)
        )
    );
    assert!(!status.accounts[1].in_pool);
}

#[test]
fn the_request_log_keeps_the_newest_entries_for_the_feed_and_caps_their_length() {
    let dir = tempfile::Builder::new()
        .prefix("relay-clients-")
        .tempdir()
        .unwrap();
    let mut log = GatewayRequestLog::new(
        dir.path().join("gateway-requests.jsonl"),
        RequestLogOptions {
            now: None,
            feed_size: Some(REQUEST_LOG_SIZE),
        },
    );
    log.load();
    let now = now_ms();
    for i in 0..REQUEST_LOG_SIZE + 5 {
        log.record(&ProxyRequestLog {
            at: now + i as i64,
            status: 200,
            model: Some("m".repeat(200)),
            ..Default::default()
        });
    }
    let recent = log.recent();
    assert_eq!(recent.len(), REQUEST_LOG_SIZE);
    let newest = recent.last().unwrap();
    assert_eq!(
        newest.at,
        now + REQUEST_LOG_SIZE as i64 + 4,
        "the newest last"
    );
    assert_eq!(newest.model.as_ref().unwrap().len(), 80);
}

// ---------------------------------------------------------------- omp

fn target() -> OmpTarget {
    OmpTarget {
        url: "http://127.0.0.1:8317".into(),
        key: "relay-sec-test-key".into(),
    }
}

fn keyed(key: &str) -> OmpTarget {
    OmpTarget {
        key: key.into(),
        ..target()
    }
}

fn relay_entries(pad: &str) -> Vec<String> {
    vec![
        format!("{pad}anthropic:"),
        format!("{pad}{pad}baseUrl: \"http://127.0.0.1:8317\""),
        format!("{pad}{pad}apiKey: \"sk-ant-oat01-relay-gateway\""),
        format!("{pad}{pad}headers:"),
        format!("{pad}{pad}{pad}x-relay-key: \"relay-sec-test-key\""),
        format!("{pad}openai-codex:"),
        format!("{pad}{pad}baseUrl: \"http://127.0.0.1:8317\""),
        format!("{pad}{pad}apiKey: \"relay-gateway\""),
        format!("{pad}{pad}headers:"),
        format!("{pad}{pad}{pad}x-relay-key: \"relay-sec-test-key\""),
    ]
}

fn joined(parts: &[&str], entries: &[String], rest: &[&str]) -> String {
    parts
        .iter()
        .map(|s| s.to_string())
        .chain(entries.iter().cloned())
        .chain(rest.iter().map(|s| s.to_string()))
        .collect::<Vec<_>>()
        .join("\n")
}

/// What the Proxy page reads of omp's file, as `clientStatuses` derives it.
struct OmpView {
    bound: bool,
    stale: bool,
    blocked: Option<OmpBlock>,
}

fn view(text: &str, relay_bound: bool, to: &OmpTarget) -> OmpView {
    let bound = relay_bound && omp_bound_to(text, to);
    OmpView {
        bound,
        stale: (relay_bound || omp_marked(text)) && !bound,
        blocked: omp_blocked(text),
    }
}

/// Binds the user's text, checks the bound text, then checks that binding again (under another
/// key and back) stacks nothing and that unbinding gives `before` back, byte for byte.
fn round_trip(before: &str, bound: impl Fn(&str)) {
    assert_eq!(omp_blocked(before), None, "{before:?}");
    // The file is the user's: Relay did not create it, so unbinding never removes it.
    assert!(!omp_relay_only(before), "{before:?}");
    let text = omp_bound(before, &target());
    bound(&text);
    assert!(view(&text, true, &target()).bound, "{text}");
    let moved = omp_bound(&text, &keyed("relay-sec-new"));
    assert_eq!(omp_bound(&moved, &target()), text);
    assert_eq!(omp_unbound(&text), before);
    assert_eq!(omp_unbound(&moved), before);
}

#[test]
fn omp_one_click_writes_models_yml_the_next_takes_it_away_leaving_no_file_relay_made() {
    // No file yet: Relay writes one of its own.
    assert!(!view("", false, &target()).bound);
    let text = omp_bound("", &target());
    assert_eq!(
        text,
        joined(
            &[OMP_START, "providers:"],
            &relay_entries("  "),
            &[OMP_END, ""]
        )
    );
    let status = view(&text, true, &target());
    assert_eq!((status.bound, status.stale), (true, false));
    let moved = view(&text, true, &keyed("relay-sec-other"));
    assert_eq!((moved.bound, moved.stale), (false, true));
    assert_eq!(omp_bound(&text, &target()), text);
    // All of it is Relay's: unbinding (or quitting) takes the whole file away, also without a
    // record of the binding.
    assert!(omp_relay_only(&text));
    assert_eq!(omp_unbound(&text).trim(), "");
}

#[test]
fn omp_the_users_own_anthropic_and_openai_codex_entries_are_parked_while_bound_and_come_back_byte_for_byte()
 {
    let before = [
        "# my models",
        "providers:",
        "    ollama:",
        "        baseUrl: http://127.0.0.1:11434",
        "        models:",
        "            - id: anthropic",
        "    anthropic:",
        "        baseUrl: https://proxy.example",
        "        # a note inside",
        "",
        "        modelOverrides:",
        "            claude-opus-5: { name: Opus }",
        "    # a comment between entries",
        "",
        "    'openai-codex': { baseUrl: https://other.example }",
        "# other settings",
        "equivalence:",
        "    anthropic: x",
        "",
    ]
    .join("\n");
    round_trip(&before, |text| {
        let mut expected: Vec<String> = vec!["providers:".into(), OMP_START.into()];
        expected.extend(relay_entries("    "));
        expected.extend(
            [
                OMP_END,
                "    ollama:",
                "        baseUrl: http://127.0.0.1:11434",
                "        models:",
                "            - id: anthropic",
                "    # relay-disabled: anthropic:",
                "    # relay-disabled:     baseUrl: https://proxy.example",
                "    # relay-disabled:     # a note inside",
                "",
                "    # relay-disabled:     modelOverrides:",
                "    # relay-disabled:         claude-opus-5: { name: Opus }",
                "    # a comment between entries",
                "",
                "    # relay-disabled: 'openai-codex': { baseUrl: https://other.example }",
                "# other settings",
                "equivalence:",
                "    anthropic: x",
            ]
            .map(String::from),
        );
        let lines: Vec<&str> = text.split('\n').collect();
        assert_eq!(lines[1..30.min(lines.len())], expected);
    });
}

#[test]
fn omp_a_comment_less_indented_than_the_entry_ends_it_and_is_never_parked() {
    round_trip(
        "providers:\n  anthropic:\n    baseUrl: x\n# other settings\nretry: 3\n",
        |text| {
            assert!(text.contains("  # relay-disabled:   baseUrl: x\n# other settings\nretry: 3\n"))
        },
    );
    round_trip(
        "providers:\n    anthropic:\n        baseUrl: x\n  # c\n    ollama: {}\n",
        |text| {
            assert!(text.contains("    # relay-disabled:     baseUrl: x\n  # c\n    ollama: {}\n"))
        },
    );
}

#[test]
fn omp_crlf_a_missing_last_newline_trailing_blank_lines_and_an_empty_file_all_come_back_as_they_were()
 {
    round_trip(
        "retry: 3\r\nproviders:\r\n  anthropic:\r\n    baseUrl: x\r\n",
        |text| {
            assert!(text.contains(&format!("providers:\r\n{OMP_START}\r\n  anthropic:\r\n")));
            assert!(text.contains("  # relay-disabled:   baseUrl: x\r\n"));
        },
    );
    round_trip("retry: 3", |text| {
        assert!(text.starts_with(&format!("retry: 3\n{OMP_START}\nproviders:\n")))
    });
    round_trip("retry: 3\n\n\n", |text| {
        assert!(
            text.starts_with(&format!("retry: 3\n\n\n{OMP_START}\n"))
                && text.ends_with(&format!("{OMP_END}\n"))
        )
    });
    // An empty file of the user's stays, empty, after Disconnect.
    round_trip("", |text| assert!(text.starts_with(OMP_START)));
}

#[test]
fn omp_an_empty_inline_providers_map_is_parked_layouts_relay_cannot_edit_safely_block_it() {
    round_trip("providers: {}\nretry: 3\n", |text| {
        assert!(text.starts_with(&format!(
            "# relay-disabled: providers: {{}}\nretry: 3\n{OMP_START}\nproviders:\n"
        )))
    });
    for (text, reason) in [
        (
            "providers: { anthropic: { baseUrl: x } }\n",
            "inline-providers",
        ),
        ("providers: ~\n", "inline-providers"),
        ("\"providers\": {a: 1}\n", "inline-providers"),
        ("providers:\n  - x\n", "unsupported-layout"),
        (
            "providers:\n  anthropic: {\n    baseUrl: x\n  }\n",
            "unsupported-layout",
        ),
        ("providers:\n  ollama: {}\n...\n", "unsupported-layout"),
        ("---\nretry: 1\n---\nretry: 2\n", "unsupported-layout"),
        (
            "providers:\n  a: {}\n'providers':\n  b: {}\n",
            "unsupported-layout",
        ),
        ("a: 1\n---\nretry: 3\n", "unsupported-layout"),
        (
            "providers:\n  ? anthropic\n  : { baseUrl: x }\n",
            "unsupported-layout",
        ),
        (
            "providers:\n  anthropic: &a\n    baseUrl: x\n  other: *a\n",
            "unsupported-layout",
        ),
    ] {
        // A blocked layout is refused before anything is written.
        assert_eq!(
            view(text, false, &target()).blocked.map(OmpBlock::as_str),
            Some(reason),
            "{text:?}"
        );
    }
    // A quoted key is still the providers key: Relay's entries go under it, not a second one.
    round_trip("'providers':\n  ollama: {}\n", |text| {
        assert!(text.starts_with(&format!("'providers':\n{OMP_START}\n  anthropic:")))
    });
    // Brackets inside quotes are no unclosed map; a byte order mark does not hide the key.
    round_trip("providers:\n  anthropic: { name: \"a{b\" }\n", |text| {
        assert!(text.contains("  # relay-disabled: anthropic: { name: \"a{b\" }"))
    });
    round_trip("\u{FEFF}providers:\n  ollama: {}\n", |text| {
        assert!(text.starts_with(&format!("\u{FEFF}providers:\n{OMP_START}\n")))
    });
    // A single leading document marker is fine.
    round_trip("---\nretry: 1\n", |text| {
        assert!(text.starts_with(&format!("---\nretry: 1\n{OMP_START}")))
    });
}

#[test]
fn omp_a_blocked_file_that_still_holds_relays_block_can_be_disconnected() {
    let mut text = omp_bound("retry: 3\n", &target());
    text.push_str("providers: { mine: {} }\n");
    let status = view(&text, true, &target());
    assert_eq!(
        (status.bound, status.stale, status.blocked),
        (true, false, Some(OmpBlock::InlineProviders))
    );
    assert!(!omp_relay_only(&text));
    assert_eq!(omp_unbound(&text), "retry: 3\nproviders: { mine: {} }\n");
}

fn omp_home() -> (tempfile::TempDir, PathBuf) {
    let home = tempfile::Builder::new()
        .prefix("relay-clients-")
        .tempdir()
        .unwrap();
    let dir = home.path().join(".omp").join("agent");
    fs::create_dir_all(&dir).unwrap();
    (home, dir)
}

fn write_omp(dir: &Path, name: &str, text: &str) {
    fs::write(dir.join(name), text).unwrap();
}

#[test]
fn omp_models_yaml_is_written_when_omp_reads_it_a_models_json_omp_has_not_moved_blocks_a_symlink_stays_a_link()
 {
    let (yaml, dir) = omp_home();
    write_omp(&dir, "models.yaml", "retry: 3\n");
    assert_eq!(omp_models_file(yaml.path()), dir.join("models.yaml"));
    assert!(!omp_legacy_json(yaml.path()));
    let text = omp_bound("retry: 3\n", &target());
    write_omp(&dir, "models.yaml", &text);
    assert_eq!(omp_models_file(yaml.path()), dir.join("models.yaml"));
    assert!(!dir.join("models.yml").exists());
    assert_eq!(omp_unbound(&text), "retry: 3\n");
    // With both, omp reads models.yml.
    write_omp(&dir, "models.yml", "retry: 4\n");
    assert_eq!(omp_models_file(yaml.path()), dir.join("models.yml"));

    let (legacy, dir) = omp_home();
    write_omp(&dir, "models.json", "{\"providers\":{}}");
    assert!(omp_legacy_json(legacy.path()));
    assert_eq!(omp_models_file(legacy.path()), dir.join("models.yml"));
    assert!(!dir.join("models.yml").exists());
    // Once omp moved it, the yml is the file.
    write_omp(&dir, "models.yml", "retry: 3\n");
    assert!(!omp_legacy_json(legacy.path()));

    // A symlinked models.yml is the file omp reads; the host writes through the link.
    #[cfg(unix)]
    {
        let (linked, dir) = omp_home();
        let real = linked.path().join("dotfiles").join("models.yml");
        fs::create_dir_all(real.parent().unwrap()).unwrap();
        fs::write(&real, "retry: 3\n").unwrap();
        std::os::unix::fs::symlink(&real, dir.join("models.yml")).unwrap();
        assert_eq!(omp_models_file(linked.path()), dir.join("models.yml"));
        assert!(!omp_legacy_json(linked.path()));
    }
}

#[test]
fn omp_a_relay_block_with_only_one_provider_is_stale_and_binding_it_again_makes_the_file_relays_own()
 {
    let text = joined(
        &[OMP_START, "providers:"],
        &relay_entries("  ")[..5],
        &[OMP_END, ""],
    );
    let status = view(&text, false, &target());
    assert_eq!((status.bound, status.stale), (false, true));
    // Nothing of the user's is in it: Relay treats the file as one it made.
    assert!(omp_relay_only(&text));
    let bound = omp_bound(&text, &target());
    assert!(view(&bound, true, &target()).bound);
    assert_eq!(
        bound,
        joined(
            &[OMP_START, "providers:"],
            &relay_entries("  "),
            &[OMP_END, ""]
        )
    );
    assert!(omp_relay_only(&bound));
}

#[test]
fn omp_a_file_of_the_users_that_relay_found_gone_and_wrote_again_on_a_start_is_removed_on_disconnect()
 {
    // The first binding found the user's file: not Relay's to remove.
    assert!(!omp_relay_only("retry: 3\n"));
    // The file gone, the next start writes one only Relay's, which Disconnect takes away.
    let again = omp_bound("", &target());
    assert!(omp_relay_only(&again));
    assert_eq!(omp_unbound(&again).trim(), "");
}
