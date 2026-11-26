//! Port of `tests/relay-link.test.ts`.

use relay_core::shared::relay_link::{
    RelayLink, linked_switch_account, parse_relay_link, relay_link_argument, relay_switch_link,
};
use relay_core::shared::types::Account;

const A: &str = "00000000-0000-4000-8000-000000000001";
const B: &str = "00000000-0000-4000-8000-00000000000b";

fn accounts() -> Vec<Account> {
    vec![Account::new(A, "Kişisel"), Account::new(B, "Vertex")]
}

fn switch(id: &str) -> Option<RelayLink> {
    Some(RelayLink::Switch {
        account_id: id.into(),
    })
}

#[test]
fn the_widgets_switch_link_round_trips_to_a_switch_request_for_a_known_account() {
    let accounts = accounts();
    let link = relay_switch_link(A);
    assert_eq!(link, format!("relay://switch?account={A}"));
    assert_eq!(
        parse_relay_link(Some(&link), Some(&accounts[..])),
        switch(A)
    );
    assert_eq!(
        parse_relay_link(
            Some(&format!("RELAY://switch?account={B}")),
            Some(&accounts[..])
        ),
        switch(B)
    );
    assert_eq!(
        parse_relay_link::<Account>(Some("relay://open"), None),
        Some(RelayLink::Open)
    );
    // Without accounts only the shape is checked.
    assert_eq!(parse_relay_link::<Account>(Some(&link), None), switch(A));
}

#[test]
fn anything_but_a_well_formed_link_to_one_of_relays_accounts_is_ignored() {
    let accounts = accounts();
    let unknown = "00000000-0000-4000-8000-0000000000ff";
    for url in [
        format!("relay://switch?account={unknown}"),
        "relay://switch?account=../../etc".into(),
        "relay://switch?account=".into(),
        "relay://switch".into(),
        format!("relay://switch?account={A}&account={B}"),
        format!("relay://switch?account={A}&confirm=1"),
        format!("relay://switch/now?account={A}"),
        format!("relay://switch?account={A}#go"),
        format!("relay://user:pw@switch?account={A}"),
        format!("relay://switch:80?account={A}"),
        format!("relay:switch?account={A}"),
        format!("https://switch?account={A}"),
        "relay://quit".into(),
        "relay://open?page=ayarlar".into(),
        "not a url".into(),
        String::new(),
        format!("relay://switch?account={A}{}", "x".repeat(600)),
    ] {
        assert_eq!(
            parse_relay_link(Some(&url), Some(&accounts[..])),
            None,
            "{url}"
        );
    }
    // `undefined` and `42`: not a string.
    assert_eq!(parse_relay_link(None, Some(&accounts[..])), None);
}

#[test]
fn a_link_among_command_line_arguments_is_found_none_is_undefined() {
    let link = format!("relay://switch?account={A}");
    assert_eq!(
        relay_link_argument(&["/Applications/Relay.app", "--flag", &link]),
        Some(link.as_str())
    );
    assert_eq!(
        relay_link_argument(&["/Applications/Relay.app", "--flag"]),
        None
    );
}

#[test]
fn the_review_opens_only_for_a_known_account_that_is_not_already_open_in_claude() {
    let accounts = accounts();
    assert_eq!(
        linked_switch_account(Some(B), &accounts, Some(A)).map(|a| a.name.as_str()),
        Some("Vertex")
    );
    assert_eq!(linked_switch_account(Some(A), &accounts, Some(A)), None);
    assert_eq!(
        linked_switch_account(
            Some("00000000-0000-4000-8000-0000000000ff"),
            &accounts,
            Some(A)
        ),
        None
    );
    assert_eq!(linked_switch_account(None, &accounts, Some(A)), None);
    assert_eq!(
        linked_switch_account(Some(B), &accounts, None).map(|a| a.id.as_str()),
        Some(B)
    );
}
