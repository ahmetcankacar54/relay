//! Port of tests/gateway-routing.test.ts.

mod common;

use common::*;
use relay_gateway::proxy_router::{
    MIN_STAY_MS, PickContext, ProxyRouter, REBALANCE_GAP_MS, RouterSelection, model_family,
};
use relay_gateway::upstream_common::{LimitScope, limit_scope_of, parse_live_limits};
use relay_gateway::{
    Account, AccountUsage, LiveModelWindow, ModelWindow, Provider, ProxyMoveReason, ProxyPick,
    ProxyPickReason, RoutingStrategy, ServerOptions, Upstreams, UsageMap,
};
use std::collections::HashSet;

const HOUR: i64 = 3_600_000;

fn now() -> i64 {
    utc(2026, 10, 13, 23, 30)
}

fn at(hours: f64) -> String {
    iso(now() + (hours * HOUR as f64) as i64)
}

fn usage(
    id: &str,
    five: (f64, Option<f64>),
    week: (f64, f64),
    fable: Option<(f64, f64)>,
) -> AccountUsage {
    let mut usage = ready(
        id,
        Some(window(five.0, five.1.map(at))),
        Some(window(week.0, Some(at(week.1)))),
    );
    if let Some((used, reset)) = fable {
        usage.model_windows = Some(vec![fable_window("seven_day_fable", used, reset)]);
    }
    usage
}

fn fable_window(key: &str, used: f64, reset: f64) -> ModelWindow {
    ModelWindow {
        key: key.into(),
        label: "Fable".into(),
        model: Some("fable".into()),
        used_percent: used,
        resets_at: Some(at(reset)),
        ..Default::default()
    }
}

// The pool as it stood on 2026-11-14 at 02:30 (Istanbul): Alto's 5-hour window running hot,
// Vertex's week ending in ~30 h with its Fable week spent, Nova untouched until the 20th.
fn accounts() -> Vec<Account> {
    vec![account("vertex"), account("nova"), account("alto")]
}

fn pool() -> UsageMap {
    let mut map = UsageMap::new();
    map.insert(
        "alto".into(),
        usage(
            "alto",
            (81.0, Some(2.2)),
            (27.0, 124.0),
            Some((12.0, 124.0)),
        ),
    );
    map.insert(
        "vertex".into(),
        usage(
            "vertex",
            (18.0, Some(1.5)),
            (80.0, 29.5),
            Some((100.0, 29.5)),
        ),
    );
    map.insert(
        "nova".into(),
        usage("nova", (0.0, None), (0.0, 165.0), Some((0.0, 165.0))),
    );
    map
}

fn ctx(model: &str) -> PickContext {
    PickContext::model(model)
}

fn turn(model: &str) -> PickContext {
    PickContext {
        turn_start: true,
        ..PickContext::model(model)
    }
}

fn pick(
    router: &mut ProxyRouter,
    key: Option<&str>,
    accounts: &[Account],
    map: &UsageMap,
    context: &PickContext,
) -> RouterSelection {
    router
        .select_account(
            key,
            accounts,
            map,
            Some(Provider::Claude),
            &HashSet::new(),
            None,
            context,
        )
        .unwrap()
}

fn router_at(clock: &TestClock) -> ProxyRouter {
    ProxyRouter::with_strategy(RoutingStrategy::SoonestReset, Some(clock.clock()))
}

#[test]
fn a_new_session_goes_to_the_account_whose_week_ends_first_not_to_the_one_whose_5_hour_window_is_running()
 {
    let mut router = ProxyRouter::with_strategy(RoutingStrategy::SoonestReset, Some(fixed(now())));
    let opus = pick(
        &mut router,
        Some("s-opus"),
        &accounts(),
        &pool(),
        &ctx("claude-opus-5-5"),
    );
    assert_eq!(opus.account.id, "vertex");
    assert_eq!(opus.reason, ProxyPickReason::SoonestReset);
}

#[test]
fn a_model_whose_own_weekly_limit_is_spent_goes_elsewhere_while_the_account_keeps_serving_other_models()
 {
    let mut router = ProxyRouter::with_strategy(RoutingStrategy::SoonestReset, Some(fixed(now())));
    let fable = pick(
        &mut router,
        Some("s-fable"),
        &accounts(),
        &pool(),
        &ctx("claude-fable-5-2"),
    );
    assert_eq!(
        fable.account.id, "nova",
        "Vertex's Fable week is spent and Alto's 5-hour window is 81 % used"
    );
    // With room in Alto's 5-hour window, Alto's week (ending before Nova's) goes first.
    let mut cooler = pool();
    cooler.get_mut("alto").unwrap().five_hour = Some(window(40.0, Some(at(2.2))));
    assert_eq!(
        pick(
            &mut router,
            Some("s-fable-2"),
            &accounts(),
            &cooler,
            &ctx("claude-fable-5-2")
        )
        .account
        .id,
        "alto"
    );
    let opus = pick(
        &mut router,
        Some("s-opus"),
        &accounts(),
        &pool(),
        &ctx("claude-opus-5-5"),
    );
    assert_eq!(opus.account.id, "vertex");
    // A Fable request in a session bound to Vertex moves: its model is out there.
    router.session_cache_mut().set("s-mixed", "vertex");
    let moved = pick(
        &mut router,
        Some("s-mixed"),
        &accounts(),
        &cooler,
        &ctx("claude-fable-5-2"),
    );
    assert_eq!(moved.account.id, "alto");
    assert_eq!(moved.moved, Some(ProxyMoveReason::Limit));
    assert_eq!(moved.from.as_deref(), Some("vertex"));
}

#[test]
fn a_429_that_spent_only_one_models_limit_keeps_that_model_off_the_account_not_the_account() {
    let mut router = ProxyRouter::with_strategy(RoutingStrategy::SoonestReset, Some(fixed(now())));
    let mut map = pool();
    map.get_mut("vertex").unwrap().model_windows = Some(vec![]);
    map.get_mut("alto").unwrap().five_hour = Some(window(40.0, Some(at(2.2))));
    router.mark_model_unavailable("vertex", "fable", 30 * HOUR);
    assert_eq!(
        pick(
            &mut router,
            None,
            &accounts(),
            &map,
            &ctx("claude-fable-5-2")
        )
        .account
        .id,
        "alto"
    );
    assert_eq!(
        pick(
            &mut router,
            None,
            &accounts(),
            &map,
            &ctx("claude-opus-5-5")
        )
        .account
        .id,
        "vertex"
    );
    let scope = |pairs: &[(&str, &str)]| limit_scope_of(&headers(pairs));
    assert_eq!(
        scope(&[
            ("anthropic-ratelimit-unified-7d_fable-status", "rejected"),
            ("anthropic-ratelimit-unified-5h-status", "allowed")
        ]),
        LimitScope::Model
    );
    assert_eq!(
        scope(&[
            ("anthropic-ratelimit-unified-7d_fable-status", "rejected"),
            ("anthropic-ratelimit-unified-7d-status", "rejected")
        ]),
        LimitScope::Account
    );
    assert_eq!(
        scope(&[(
            "anthropic-ratelimit-unified-7d_oauth_apps-status",
            "rejected"
        )]),
        LimitScope::Account,
        "a client-scoped limit stops every request"
    );
    assert_eq!(
        scope(&[
            ("anthropic-ratelimit-unified-status", "rejected"),
            (
                "anthropic-ratelimit-unified-representative-claim",
                "five_hour"
            )
        ]),
        LimitScope::Account
    );
    assert_eq!(scope(&[]), LimitScope::Account);
    assert_eq!(model_family(Some("claude-fable-5-2")), Some("fable"));
    assert_eq!(model_family(Some("gpt-5.3-codex")), None);
}

#[test]
fn a_busy_session_moves_to_the_expiring_week_at_the_start_of_a_prompt_never_mid_turn_and_not_back_and_forth()
 {
    let clock = TestClock::new(now());
    let mut router = router_at(&clock);
    router.session_cache_mut().set("s", "alto");
    // Mid-turn (tool calls, subagents' parent turns): the session stays with its cache.
    let mid = pick(
        &mut router,
        Some("s"),
        &accounts(),
        &pool(),
        &ctx("claude-opus-5-5"),
    );
    assert_eq!(mid.account.id, "alto");
    assert_eq!(mid.reason, ProxyPickReason::Bound);
    // A new prompt begins: Vertex's week ends four days before Alto's, so the session moves.
    let moved = pick(
        &mut router,
        Some("s"),
        &accounts(),
        &pool(),
        &turn("claude-opus-5-5"),
    );
    assert_eq!(moved.account.id, "vertex");
    assert_eq!(moved.moved, Some(ProxyMoveReason::Rebalance));
    assert_eq!(moved.from.as_deref(), Some("alto"));
    // Next prompts stay: it is already where it should be.
    let again = pick(
        &mut router,
        Some("s"),
        &accounts(),
        &pool(),
        &turn("claude-opus-5-5"),
    );
    assert_eq!(again.reason, ProxyPickReason::Bound);

    // Vertex's 5-hour window passes the soft stop: warm sessions still use its last percents.
    let mut hot = pool();
    hot.get_mut("vertex").unwrap().five_hour = Some(window(93.0, Some(at(1.0))));
    clock.advance(MIN_STAY_MS / 2);
    assert_eq!(
        pick(
            &mut router,
            Some("s"),
            &accounts(),
            &hot,
            &turn("claude-opus-5-5")
        )
        .account
        .id,
        "vertex"
    );
    // Past the eject threshold the session leaves at its next prompt, for the account with
    // 5-hour room (Alto's window is 81 % used, Nova's untouched).
    hot.get_mut("vertex").unwrap().five_hour = Some(window(96.0, Some(at(1.0))));
    let drained = pick(
        &mut router,
        Some("s"),
        &accounts(),
        &hot,
        &turn("claude-opus-5-5"),
    );
    assert_eq!(drained.account.id, "nova");
    assert_eq!(drained.moved, Some(ProxyMoveReason::Drain));
    // The window resets a moment later; the session just moved, so it stays a while first.
    clock.advance(60_000);
    let settled = pick(
        &mut router,
        Some("s"),
        &accounts(),
        &pool(),
        &turn("claude-opus-5-5"),
    );
    assert_eq!(settled.account.id, "nova");
    clock.advance(MIN_STAY_MS);
    let back = pick(
        &mut router,
        Some("s"),
        &accounts(),
        &pool(),
        &turn("claude-opus-5-5"),
    );
    assert_eq!(back.account.id, "vertex");
    assert_eq!(back.moved, Some(ProxyMoveReason::Rebalance));
}

#[test]
fn weeks_ending_within_a_few_hours_of_each_other_do_not_move_a_session_the_5_hour_window_decides_new_ones()
 {
    let mut router = ProxyRouter::with_strategy(RoutingStrategy::SoonestReset, Some(fixed(now())));
    let mut close = UsageMap::new();
    close.insert(
        "a".into(),
        usage("a", (40.0, Some(1.0)), (30.0, 50.0), None),
    );
    close.insert(
        "b".into(),
        usage(
            "b",
            (10.0, Some(4.0)),
            (30.0, 50.0 + (REBALANCE_GAP_MS / HOUR) as f64 / 2.0),
            None,
        ),
    );
    let pair = [account("a"), account("b")];
    router.session_cache_mut().set("s", "b");
    let kept = pick(
        &mut router,
        Some("s"),
        &pair,
        &close,
        &PickContext {
            turn_start: true,
            ..Default::default()
        },
    );
    assert_eq!(
        kept.account.id, "b",
        "half a day apart is not worth a cache write"
    );
    let fresh = pick(
        &mut router,
        Some("new"),
        &pair,
        &close,
        &PickContext::default(),
    );
    assert_eq!(fresh.account.id, "a");
}

#[test]
fn a_cold_session_goes_where_a_new_one_would_at_no_cost_strict_priority_never_rebalances() {
    let mut router = ProxyRouter::with_strategy(RoutingStrategy::SoonestReset, Some(fixed(now())));
    router.session_cache_mut().set("s", "alto");
    let cold = pick(
        &mut router,
        Some("s"),
        &accounts(),
        &pool(),
        &PickContext {
            cold: true,
            ..ctx("claude-opus-5-5")
        },
    );
    assert_eq!(cold.account.id, "vertex");
    assert_eq!(cold.moved, Some(ProxyMoveReason::Cold));

    let mut strict =
        ProxyRouter::with_strategy(RoutingStrategy::StrictPriority, Some(fixed(now())));
    strict.session_cache_mut().set("s", "alto");
    assert_eq!(
        pick(
            &mut strict,
            Some("s"),
            &accounts(),
            &pool(),
            &turn("claude-opus-5-5")
        )
        .account
        .id,
        "alto"
    );
}

const MESSAGE_START: &str = "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":2,\"cache_read_input_tokens\":30000,\"cache_creation_input_tokens\":0,\"output_tokens\":3}}}\n\n";

async fn soon_late_gateway(clock: &TestClock) -> (Gateway, FakeUpstream) {
    let upstream = FakeUpstream::sync(|_| sse_once(MESSAGE_START)).await;
    let mut map = UsageMap::new();
    map.insert(
        "soon".into(),
        usage("soon", (95.0, Some(0.5)), (40.0, 24.0), None),
    );
    map.insert(
        "late".into(),
        usage("late", (10.0, Some(3.0)), (20.0, 120.0), None),
    );
    let gateway = Gateway::start_with(
        config(),
        Hooks::new(vec![account("soon"), account("late")]).usage(map),
        Upstreams {
            anthropic_url: Some(upstream.url.clone()),
            ..Default::default()
        },
        ServerOptions {
            now: Some(clock.clock()),
            ..Default::default()
        },
    )
    .await;
    (gateway, upstream)
}

async fn send_prompt(gateway: &Gateway, prompt: &str, class: &str) {
    gateway
        .post(
            "/v1/messages",
            &[
                ("x-claude-code-session-id", "s-1"),
                ("x-claude-code-request-class", class),
                ("x-claude-code-prompt-id", prompt),
            ],
            r#"{"model":"claude-opus-5-5"}"#,
        )
        .await;
    gateway.idle().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn through_the_gateway_a_session_moves_only_on_a_new_prompt_id_and_the_log_says_why() {
    let clock = TestClock::new(now());
    let (gateway, upstream) = soon_late_gateway(&clock).await;
    send_prompt(&gateway, "p1", "main").await;
    assert_eq!(
        upstream.tokens(),
        ["tok-late"],
        "the account whose week ends first is past its 5-hour soft stop"
    );
    // Its 5-hour window resets; the turn goes on with tool calls on the same prompt.
    gateway.hooks.update_usage(|map| {
        map.insert(
            "soon".into(),
            usage("soon", (5.0, Some(5.0)), (40.0, 24.0), None),
        );
    });
    clock.advance(3 * 60_000);
    send_prompt(&gateway, "p1", "main").await;
    assert_eq!(
        upstream.tokens(),
        ["tok-late", "tok-late"],
        "never mid-turn"
    );
    clock.advance(60_000);
    send_prompt(&gateway, "p2", "main").await;
    assert_eq!(upstream.tokens(), ["tok-late", "tok-late", "tok-soon"]);
    let moved = gateway.recent().remove(0);
    assert_eq!(moved.note.as_deref(), Some("rebalance-move"));
    let mut expected = ProxyPick::new(ProxyPickReason::SoonestReset);
    expected.moved = Some(ProxyMoveReason::Rebalance);
    expected.from = Some("late".into());
    assert_eq!(moved.pick, Some(expected));
    gateway.stop().await;
    upstream.close().await;
}

#[test]
fn an_answers_own_window_of_one_model_is_read_as_that_models_limit() {
    let reset = now() / 1000 + 3600;
    let live = parse_live_limits(&headers(&[
        ("anthropic-ratelimit-unified-5h-utilization", "0.31"),
        ("anthropic-ratelimit-unified-7d_fable-utilization", "0.995"),
        (
            "anthropic-ratelimit-unified-7d_fable-reset",
            &reset.to_string(),
        ),
        (
            "anthropic-ratelimit-unified-7d_oauth_apps-utilization",
            "0.2",
        ),
    ]))
    .unwrap();
    assert_eq!(live.five_hour.unwrap().used_percent, 31.0);
    assert_eq!(
        live.models.unwrap(),
        [LiveModelWindow {
            model: "fable".into(),
            weekly: true,
            used_percent: 99.5,
            resets_at: Some(iso(reset * 1000)),
        }]
    );
    assert_eq!(
        parse_live_limits(&headers(&[(
            "anthropic-ratelimit-unified-7d_opus-utilization",
            "0.4"
        )]))
        .and_then(|l| l.models)
        .map(|m| m[0].model.clone())
        .as_deref(),
        Some("opus")
    );
    assert_eq!(parse_live_limits(&headers(&[])), None);
}

#[test]
fn busy_sessions_move_to_an_expiring_week_one_at_a_time_and_ranking_keeps_fable_room_where_fable_still_works()
 {
    let clock = TestClock::new(now());
    let mut router = router_at(&clock);
    router.session_cache_mut().set("s1", "nova");
    router.session_cache_mut().set("s2", "nova");
    let opus_turn = turn("claude-opus-5-5");
    assert_eq!(
        pick(&mut router, Some("s1"), &accounts(), &pool(), &opus_turn).moved,
        Some(ProxyMoveReason::Rebalance)
    );
    assert_eq!(
        pick(&mut router, Some("s2"), &accounts(), &pool(), &opus_turn)
            .account
            .id,
        "nova",
        "the next waits"
    );
    clock.advance(5 * 60_000);
    assert_eq!(
        pick(&mut router, Some("s2"), &accounts(), &pool(), &opus_turn).moved,
        Some(ProxyMoveReason::Rebalance)
    );

    // Two accounts whose weeks end together: Opus work goes to the one whose Fable week is
    // spent, so the other keeps its room for Fable.
    let mut twins = UsageMap::new();
    twins.insert(
        "a".into(),
        usage("a", (10.0, Some(3.0)), (30.0, 50.0), Some((20.0, 50.0))),
    );
    twins.insert(
        "b".into(),
        usage("b", (10.0, Some(3.0)), (30.0, 51.0), Some((100.0, 51.0))),
    );
    let pair = [account("a"), account("b")];
    assert_eq!(
        pick(&mut router, None, &pair, &twins, &ctx("claude-opus-5-5"))
            .account
            .id,
        "b"
    );
    assert_eq!(
        pick(&mut router, None, &pair, &twins, &ctx("claude-fable-5-2"))
            .account
            .id,
        "a"
    );
    assert_eq!(
        limit_scope_of(&headers(&[(
            "anthropic-ratelimit-unified-7d_oi-status",
            "rejected"
        )])),
        LimitScope::Model,
        "a scoped window of any name"
    );
}

#[test]
fn review_a_subagents_fable_request_goes_elsewhere_without_taking_the_opus_conversation_along() {
    let clock = TestClock::new(now());
    let mut router = router_at(&clock);
    let opus = PickContext {
        main: Some(true),
        ..ctx("claude-opus-5-5")
    };
    // The conversation lands on Vertex (week ends first); its Fable week is spent.
    let first = pick(
        &mut router,
        Some("s"),
        &accounts(),
        &pool(),
        &PickContext {
            turn_start: true,
            ..opus.clone()
        },
    );
    assert_eq!(first.account.id, "vertex");
    // A Fable subagent of the same session is served elsewhere, and the session stays bound.
    let sub = pick(
        &mut router,
        Some("s"),
        &accounts(),
        &pool(),
        &PickContext {
            main: Some(false),
            ..ctx("claude-fable-5-2")
        },
    );
    assert_ne!(sub.account.id, "vertex");
    assert_eq!(sub.moved, None);
    clock.advance(60_000);
    let next = pick(&mut router, Some("s"), &accounts(), &pool(), &opus);
    assert_eq!(
        next.account.id, "vertex",
        "the main conversation never moved"
    );
    assert_eq!(next.reason, ProxyPickReason::Bound);
    // The main conversation itself asking for Fable does move: its model is out there.
    let main_fable = pick(
        &mut router,
        Some("s"),
        &accounts(),
        &pool(),
        &PickContext {
            main: Some(true),
            ..ctx("claude-fable-5-2")
        },
    );
    assert_eq!(main_fable.moved, Some(ProxyMoveReason::Limit));
}

#[test]
fn review_every_window_of_a_model_counts_an_expired_window_is_empty_and_an_unknown_window_is_the_accounts()
 {
    let mut router = ProxyRouter::with_strategy(RoutingStrategy::SoonestReset, Some(fixed(now())));
    let mut both = pool();
    both.get_mut("vertex").unwrap().model_windows = Some(vec![
        fable_window("five_hour_fable", 100.0, 1.0),
        fable_window("seven_day_fable", 100.0, 100.0),
    ]);
    let mut later =
        ProxyRouter::with_strategy(RoutingStrategy::SoonestReset, Some(fixed(now() + 2 * HOUR)));
    assert_ne!(
        pick(
            &mut later,
            None,
            &accounts(),
            &both,
            &ctx("claude-fable-5-2")
        )
        .account
        .id,
        "vertex",
        "the spent week still keeps Fable off after the 5-hour window resets"
    );
    // A stale reading whose Fable reset has passed: the account serves Fable again.
    let mut stale = pool();
    stale.get_mut("vertex").unwrap().model_windows =
        Some(vec![fable_window("seven_day_fable", 100.0, -0.2)]);
    stale.get_mut("alto").unwrap().five_hour = Some(window(40.0, Some(at(2.2))));
    assert_eq!(
        pick(
            &mut router,
            None,
            &accounts(),
            &stale,
            &ctx("claude-fable-5-2")
        )
        .account
        .id,
        "vertex"
    );
    assert_eq!(
        limit_scope_of(&headers(&[(
            "anthropic-ratelimit-unified-7d_claude_code-status",
            "rejected"
        )])),
        LimitScope::Account
    );
    assert_eq!(
        limit_scope_of(&headers(&[(
            "anthropic-ratelimit-unified-7d_opus-status",
            "rejected"
        )])),
        LimitScope::Model
    );
}

#[test]
fn review_weeks_minutes_apart_tie_however_they_fall_so_the_running_5_hour_window_decides() {
    let mut router = ProxyRouter::with_strategy(RoutingStrategy::SoonestReset, Some(fixed(now())));
    let mut edge = UsageMap::new();
    edge.insert("a".into(), usage("a", (10.0, Some(4.0)), (30.0, 5.9), None));
    edge.insert("b".into(), usage("b", (10.0, Some(1.0)), (30.0, 6.1), None));
    assert_eq!(
        pick(
            &mut router,
            None,
            &[account("a"), account("b")],
            &edge,
            &PickContext::default()
        )
        .account
        .id,
        "b"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn review_a_background_request_of_a_new_prompt_does_not_hide_the_turns_start() {
    let clock = TestClock::new(now());
    let (gateway, upstream) = soon_late_gateway(&clock).await;
    send_prompt(&gateway, "p1", "main").await;
    gateway.hooks.update_usage(|map| {
        map.insert(
            "soon".into(),
            usage("soon", (5.0, Some(5.0)), (40.0, 24.0), None),
        );
    });
    clock.advance(3 * 60_000);
    // The new prompt's title request arrives first; the main request still starts the turn.
    send_prompt(&gateway, "p2", "auxiliary").await;
    send_prompt(&gateway, "p2", "main").await;
    assert_eq!(
        upstream.tokens().last().map(String::as_str),
        Some("tok-soon")
    );
    gateway.stop().await;
    upstream.close().await;
}
