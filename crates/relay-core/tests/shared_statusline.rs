//! Port of the `shared/statusline` cases of tests/statusline.test.ts. The CLI wrapper, the app's
//! snapshot builder and the settings installer cases belong to their own ports.

#[path = "common/shared_b.rs"]
mod helpers;

use helpers::uuid;
use relay_core::shared::statusline::{
    STATUSLINE_STALE_MS, StatuslineRender, StatuslineSnapshot, StatuslineStyle,
    parse_statusline_input, render_statusline,
};
use relay_core::shared::terminal_identity::TerminalIdentity;
use relay_core::shared::types::js::date_parse;
use serde_json::{Value, json};

struct World {
    now: f64,
    vertex: String,
    alto: String,
    person: TerminalIdentity,
}

fn world() -> World {
    World {
        now: date_parse("2026-11-23T12:00:00Z"),
        vertex: uuid(),
        alto: uuid(),
        person: TerminalIdentity {
            account_uuid: uuid(),
            org_id: uuid(),
        },
    }
}

impl World {
    fn snapshot_json(&self) -> Value {
        let now = self.now;
        json!({
            "version": 1,
            "generatedAt": now,
            "formatLocale": "en-GB",
            "profiles": "/data/Relay/profiles",
            "desktopAccountId": self.vertex,
            "terminalFollows": true,
            "accounts": [
                {
                    "id": self.vertex,
                    "name": "Vertex",
                    "identities": [{ "accountUuid": self.person.account_uuid, "orgId": self.person.org_id }],
                    "fiveHour": { "used": 42, "resetsAt": now + 2.0 * 3_600_000.0, "resets": "renews 14:00" },
                    "week": { "used": 18, "resetsAt": now + 3.0 * 86_400_000.0, "resets": "renews Thu 09:00" },
                },
                { "id": self.alto, "name": "Alto", "identities": [], "fiveHour": { "used": 7 }, "week": { "used": 61 } },
            ],
            "text": { "fiveHour": "5 h {percent}", "week": "week {percent}", "viaGateway": "via gateway", "updatedAgo": "updated {age}" },
        })
    }

    fn snapshot(&self, overrides: Value) -> StatuslineSnapshot {
        let mut value = self.snapshot_json();
        for (k, v) in overrides.as_object().unwrap() {
            value[k] = v.clone();
        }
        serde_json::from_value(value).unwrap()
    }

    fn render(
        &self,
        snap: &StatuslineSnapshot,
        input: Value,
        config_dir: Option<&str>,
        sign_in: Option<TerminalIdentity>,
        now: Option<f64>,
    ) -> String {
        let input = parse_statusline_input(Some(&input.to_string()));
        let plain = |_: StatuslineStyle, text: &str| text.to_string();
        render_statusline(StatuslineRender {
            snapshot: snap,
            input: &input,
            config_dir,
            sign_in: Box::new(move || sign_in),
            now: now.unwrap_or(self.now),
            paint: &plain,
        })
    }
}

#[test]
fn the_line_names_the_terminal_s_sign_in_its_five_hour_and_weekly_use_and_the_next_renewal() {
    let w = world();
    assert_eq!(
        w.render(
            &w.snapshot(json!({})),
            json!({ "session_id": "s1" }),
            None,
            Some(w.person.clone()),
            None
        ),
        "Vertex · 5 h 42% · week 18% · renews 14:00"
    );
}

#[test]
fn claude_code_s_own_rate_limits_on_stdin_win_over_relay_s_last_read() {
    let w = world();
    let input = json!({
        "session_id": "s1",
        "rate_limits": {
            "five_hour": { "used_percentage": 63.7, "resets_at": w.now / 1000.0 + 3600.0 },
            "seven_day": { "used_percentage": 20 },
        },
    });
    assert_eq!(
        w.render(
            &w.snapshot(json!({})),
            input,
            None,
            Some(w.person.clone()),
            None
        ),
        "Vertex · 5 h 63% · week 20% · renews 14:00"
    );
}

#[test]
fn a_session_the_gateway_carried_names_the_gateway_s_account() {
    let w = world();
    let snap = w.snapshot(json!({ "gateway": { "sessions": { "s-gw": w.alto } } }));
    assert_eq!(
        w.render(
            &snap,
            json!({ "session_id": "s-gw" }),
            None,
            Some(w.person.clone()),
            None
        ),
        "Alto · via gateway · 5 h 7% · week 61%"
    );
    // Another session is still the terminal's sign-in.
    assert!(
        w.render(
            &snap,
            json!({ "session_id": "other" }),
            None,
            Some(w.person.clone()),
            None
        )
        .starts_with("Vertex · 5 h 42%")
    );
}

#[test]
fn a_relay_profile_in_claude_config_dir_relay_run_is_that_account() {
    let w = world();
    let snap = w.snapshot(json!({}));
    let inside = std::path::Path::new(&snap.profiles).join(&w.alto);
    assert!(
        w.render(
            &snap,
            json!({}),
            inside.to_str(),
            Some(w.person.clone()),
            None
        )
        .starts_with("Alto · ")
    );
    // A folder elsewhere falls through to the sign-in.
    let elsewhere = format!("/elsewhere/{}", w.alto);
    assert!(
        w.render(
            &snap,
            json!({}),
            Some(&elsewhere),
            Some(w.person.clone()),
            None
        )
        .starts_with("Vertex · ")
    );
}

#[test]
fn without_a_readable_sign_in_the_terminal_follows_the_claude_app_s_account_unless_it_is_set_not_to()
 {
    let w = world();
    assert!(
        w.render(&w.snapshot(json!({})), json!({}), None, None, None)
            .starts_with("Vertex · ")
    );
    assert_eq!(
        w.render(
            &w.snapshot(json!({ "terminalFollows": false })),
            json!({}),
            None,
            None,
            None
        ),
        ""
    );
    // An unknown sign-in names no account but still shows Claude Code's own figures.
    let stranger = TerminalIdentity {
        account_uuid: "x".into(),
        org_id: "y".into(),
    };
    assert_eq!(
        w.render(
            &w.snapshot(json!({})),
            json!({ "rate_limits": { "five_hour": { "used_percentage": 5 } } }),
            None,
            Some(stranger),
            None
        ),
        "5 h 5%"
    );
}

#[test]
fn a_period_that_renewed_since_the_read_is_left_out_with_the_week_s_renewal_shown_only_without_a_five_hour_figure()
 {
    let w = world();
    // Written a minute ago, read before the five-hour period renewed: its figure is gone.
    let later = w.now + 3.0 * 3_600_000.0;
    assert_eq!(
        w.render(
            &w.snapshot(json!({ "generatedAt": later - 60_000.0 })),
            json!({}),
            None,
            Some(w.person.clone()),
            Some(later)
        ),
        "Vertex · week 18% · renews Thu 09:00"
    );
    let week_only = w.snapshot(json!({
        "accounts": [{
            "id": w.vertex,
            "name": "Vertex",
            "identities": [{ "accountUuid": w.person.account_uuid, "orgId": w.person.org_id }],
            "week": { "used": 50, "resetsAt": w.now + 86_400_000.0 * 2.0, "resets": "renews Wed 08:00" },
        }],
    }));
    assert_eq!(
        w.render(&week_only, json!({}), None, Some(w.person.clone()), None),
        "Vertex · week 50% · renews Wed 08:00"
    );
}

#[test]
fn an_old_snapshot_says_how_old_it_is() {
    let w = world();
    let snap = w.snapshot(json!({}));
    let fresh = w.render(
        &snap,
        json!({}),
        None,
        Some(w.person.clone()),
        Some(w.now + STATUSLINE_STALE_MS - 1000.0),
    );
    assert!(!fresh.contains("updated"));
    let stale = w.render(
        &snap,
        json!({}),
        None,
        Some(w.person.clone()),
        Some(w.now + 17.0 * 60_000.0),
    );
    assert!(stale.ends_with(" · updated 17 min ago"), "{stale}");
    let hours = w.render(
        &snap,
        json!({}),
        None,
        Some(w.person.clone()),
        Some(w.now + 3.0 * 3_600_000.0),
    );
    assert!(hours.ends_with("updated 3 hr ago"), "{hours}");
}

#[test]
fn colors_only_when_asked_percentages_by_how_full_the_name_bold() {
    let w = world();
    let snap = w.snapshot(json!({}));
    let input = parse_statusline_input(None);
    let person = w.person.clone();
    let tag = |style: StatuslineStyle, text: &str| {
        let name = serde_json::to_value(style).unwrap();
        let name = name.as_str().unwrap();
        format!("<{name}>{text}</{name}>")
    };
    let colored = render_statusline(StatuslineRender {
        snapshot: &snap,
        input: &input,
        config_dir: None,
        sign_in: Box::new(move || Some(person)),
        now: w.now,
        paint: &tag,
    });
    assert_eq!(
        colored,
        "<bold>Vertex</bold> · 5 h <green>42%</green> · week <green>18%</green> · <dim>renews 14:00</dim>"
    );
}

#[test]
fn percentages_and_ages_follow_the_snapshot_s_locale() {
    // Not in the TS file: the Intl tables, against Node 24's output for Relay's FORMAT_LOCALE tags.
    let w = world();
    let cases = [
        ("tr-TR", "%42", "17 dk. önce"),
        ("de-DE", "42\u{a0}%", "vor 17 Min."),
        ("fr-FR", "42\u{a0}%", "il y a 17\u{a0}min"),
        ("ja-JP", "42%", "17 分前"),
        ("zh-TW", "42%", "17 分鐘前"),
        ("pl-PL", "42%", "17 min temu"),
        ("not a tag", "42%", "17 min. ago"),
    ];
    for (locale, percent, age) in cases {
        let snap = w.snapshot(json!({ "formatLocale": locale }));
        let line = w.render(
            &snap,
            json!({}),
            None,
            Some(w.person.clone()),
            Some(w.now + 17.0 * 60_000.0),
        );
        assert_eq!(
            line,
            format!(
                "Vertex · 5 h {percent} · week {} · renews 14:00 · updated {age}",
                percent.replace("42", "18")
            ),
            "{locale}"
        );
    }
    let days = w.render(
        &w.snapshot(json!({ "formatLocale": "de-DE" })),
        json!({}),
        None,
        Some(w.person.clone()),
        Some(w.now + 1000.0 * 86_400_000.0),
    );
    assert!(days.ends_with("updated vor 1.000 Tagen"), "{days}");
}
