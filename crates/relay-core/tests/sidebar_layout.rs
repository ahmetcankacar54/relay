//! Port of `tests/sidebar-layout.test.ts`. "Copy recipe writes the clipboard in main…" tests
//! `sidebar-main.ts` (the app's IPC wiring, ported with the Tauri shell). The worker half of "the
//! helper reads exactly the sidebar keys, and the worker never writes them" read
//! `electron/draft-worker.ts`'s source; the in-process reader has no write path at all.

use indexmap::IndexSet;
use relay_core::desktop_files::{CarriedConversation, CarriedMember, Scope};
use relay_core::draft_transfer::{DraftPage, DraftResult, checked_result, run_draft_job};
use relay_core::shared::types::js::JsMap;
use relay_core::sidebar_keys::{MAX_SIDEBAR_CHARS, SIDEBAR_KEYS};
use relay_core::sidebar_layout::{
    AccountLayout, GapSection, LIST_LIMIT, MOVE_BATCH, SidebarGap, SidebarSection,
    plan_sidebar_gap, read_sidebar_storage, sidebar_recipe,
};
use relay_core::sidebar_vault::SidebarGapVault;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn ids<const N: usize>() -> [String; N] {
    std::array::from_fn(|_| uuid())
}

fn scope_of() -> Scope {
    Scope {
        account_uuid: uuid(),
        org_id: uuid(),
    }
}

fn key(s: &Scope) -> String {
    format!("{}/{}", s.account_uuid, s.org_id)
}

fn code(alias: &str) -> String {
    format!("code:local_{alias}")
}

fn section(id: &str, kind: &str, name: &str, order: i64, extra: Value) -> Value {
    let mut s = json!({
        "id": id, "kind": kind, "v": 2, "name": name, "order": order, "sortBy": "recency",
        "ascending": false, "show": { "metadata": false, "emptyGroups": false, "sideChats": false },
        "collapsed": false, "shown": true,
    });
    for (k, v) in extra.as_object().unwrap() {
        s[k] = v.clone();
    }
    s
}

fn builtins(manual: Vec<Value>) -> Vec<Value> {
    let mut all = vec![
        section("pinned", "pinned", "", 0, json!({})),
        section("routines", "routines", "", 1, json!({})),
    ];
    all.extend(manual);
    all.push(section(
        "sessions",
        "sessions",
        "",
        99,
        json!({ "groupBy": "folder" }),
    ));
    all
}

fn wrapped(value: Value) -> String {
    json!({ "value": value, "tabId": "", "timestamp": 1792400846879_i64 }).to_string()
}

struct Group<'a> {
    id: &'a str,
    name: &'a str,
    members: Vec<String>,
}

fn raw(pairs: Vec<(&str, String)>) -> JsMap<String> {
    pairs.into_iter().map(|(k, v)| (k.to_owned(), v)).collect()
}

/// Local Storage values shaped like Claude Desktop's on 2026-10-19: `dframe-store` holds the
/// groups and sections, and the LSS copies lag behind it by one group.
fn storage(
    scope: &Scope,
    groups: &[Group],
    lss_drops_last: bool,
    starred: &[String],
    store_version: i64,
) -> JsMap<String> {
    let plain: Vec<Value> = groups
        .iter()
        .map(|g| json!({ "id": g.id, "name": g.name }))
        .collect();
    let mut assignments = serde_json::Map::new();
    for g in groups {
        for m in &g.members {
            assignments.insert(code(m), json!(g.id));
        }
    }
    let mut order = serde_json::Map::new();
    for g in groups.iter().filter(|g| !g.members.is_empty()) {
        order.insert(
            g.id.to_owned(),
            json!(g.members.iter().map(|m| code(m)).collect::<Vec<_>>()),
        );
    }
    let sections = builtins(
        groups
            .iter()
            .enumerate()
            .map(|(i, g)| {
                section(
                    g.id,
                    "manual",
                    g.name,
                    2 + i as i64,
                    json!({ "members": g.members.iter().map(|m| code(m)).collect::<Vec<_>>() }),
                )
            })
            .collect(),
    );
    let lss_groups: Vec<Value> = if lss_drops_last {
        plain[..plain.len().saturating_sub(1)].to_vec()
    } else {
        plain.clone()
    };
    let k = key(scope);
    let lss_sections: Vec<Value> = sections
        .iter()
        .map(|s| {
            let mut s = s.clone();
            if s.get("members").is_some() {
                s["members"] = json!([]);
            }
            s
        })
        .collect();
    raw(vec![
        (
            "dframe-store",
            json!({
                "state": {
                    "collapsed": false, "pinnedOrder": [],
                    "customGroupsByScope": { &k: { "groups": plain, "assignments": assignments, "order": order } },
                    "codeSidebarByScope": { &k: { "sections": sections, "migratedFrom": 1, "prefsSeeded": true } },
                },
                "version": store_version, "shared": 1,
            })
            .to_string(),
        ),
        (
            "LSS-persisted.dframe-group-scopes",
            wrapped(json!({ &k: { "groups": lss_groups, "assignments": assignments, "order": order } })),
        ),
        (
            "LSS-persisted.dframe-code-sections",
            wrapped(json!({ &k: { "sections": lss_sections, "migratedFrom": 1, "prefsSeeded": true } })),
        ),
        (
            "LSS-persisted.starred-local-code-sessions",
            wrapped(json!(starred.iter().map(|a| format!("local_{a}")).collect::<Vec<_>>())),
        ),
    ])
}

fn simple(scope: &Scope, groups: &[Group]) -> JsMap<String> {
    storage(scope, groups, false, &[], 1)
}

fn sec(id: &str, name: &str, members: &[&String]) -> SidebarSection {
    SidebarSection {
        id: id.into(),
        name: name.into(),
        members: members.iter().map(|m| (*m).clone()).collect(),
    }
}

fn edit_store(raw: &mut JsMap<String>, change: impl FnOnce(&mut Value)) {
    let mut store: Value = serde_json::from_str(raw.get("dframe-store").unwrap()).unwrap();
    change(&mut store);
    raw.insert("dframe-store", store.to_string());
}

#[test]
fn a_scopes_sections_come_from_dframe_store_in_sidebar_order_with_their_sessions_in_order() {
    let scope = scope_of();
    let [a, b, c] = ids::<3>();
    let raw = storage(
        &scope,
        &[
            Group {
                id: "cg-1",
                name: "bidsorted",
                members: vec![b.clone(), a.clone()],
            },
            Group {
                id: "cg-2",
                name: " legesis ",
                members: vec![c.clone()],
            },
            Group {
                id: "cg-3",
                name: "bidsorted-landing",
                members: vec![],
            },
        ],
        // Desktop's own LSS copy lacked the newest, empty group: the sidebar still shows it.
        true,
        &[],
        1,
    );
    assert_eq!(
        read_sidebar_storage(&raw).unwrap().layout(&scope).unwrap(),
        [
            sec("cg-1", "bidsorted", &[&b, &a]),
            sec("cg-2", "legesis", &[&c]),
            sec("cg-3", "bidsorted-landing", &[])
        ]
    );
}

#[test]
fn the_scope_is_found_whatever_the_case_of_its_key_and_other_scopes_stay_apart() {
    let scope = scope_of();
    let [a] = ids::<1>();
    let raw = simple(
        &scope,
        &[Group {
            id: "cg-1",
            name: "x",
            members: vec![a],
        }],
    );
    let upper = Scope {
        account_uuid: scope.account_uuid.to_uppercase(),
        org_id: scope.org_id.to_uppercase(),
    };
    let read = read_sidebar_storage(&raw).unwrap();
    assert_eq!(read.layout(&upper).unwrap().len(), 1);
    assert!(read.layout(&scope_of()).unwrap().is_empty());
}

#[test]
fn the_lss_copies_count_only_for_a_scope_dframe_store_does_not_have_at_all() {
    let scope = scope_of();
    let [a] = ids::<1>();
    let mut raw = simple(
        &scope,
        &[Group {
            id: "cg-1",
            name: "x",
            members: vec![a.clone()],
        }],
    );
    raw.remove("dframe-store");
    assert_eq!(
        read_sidebar_storage(&raw).unwrap().layout(&scope).unwrap(),
        [sec("cg-1", "x", &[&a])]
    );
}

#[test]
fn a_group_deleted_or_filings_undone_in_dframe_store_do_not_come_back_from_the_lagging_lss_copy() {
    let scope = scope_of();
    let [b] = ids::<1>();
    let mut raw = simple(
        &scope,
        &[
            Group {
                id: "cg-1",
                name: "kept",
                members: vec![],
            },
            Group {
                id: "cg-2",
                name: "deleted",
                members: vec![b],
            },
        ],
    );
    let k = key(&scope);
    edit_store(&mut raw, |store| {
        // The user deleted "deleted" and unfiled everything; only dframe-store has caught up.
        let groups = &mut store["state"]["customGroupsByScope"][&k];
        let kept: Vec<Value> = groups["groups"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|g| g["id"] == "cg-1")
            .cloned()
            .collect();
        groups["groups"] = json!(kept);
        groups["assignments"] = json!({});
        groups["order"] = json!({});
        let sections = &mut store["state"]["codeSidebarByScope"][&k];
        let left: Vec<Value> = sections["sections"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|s| s["id"] != "cg-2")
            .map(|s| {
                let mut s = s.clone();
                if s.get("members").is_some() {
                    s["members"] = json!([]);
                }
                s
            })
            .collect();
        sections["sections"] = json!(left);
    });
    assert_eq!(
        read_sidebar_storage(&raw).unwrap().layout(&scope).unwrap(),
        [sec("cg-1", "kept", &[])]
    );
}

#[test]
fn a_section_with_no_name_of_its_own_shows_its_groups() {
    let scope = scope_of();
    let mut raw = simple(
        &scope,
        &[Group {
            id: "cg-1",
            name: "from-group",
            members: vec![],
        }],
    );
    let k = key(&scope);
    edit_store(&mut raw, |store| {
        store["state"]["codeSidebarByScope"][&k]["sections"][2]["name"] = json!("")
    });
    assert_eq!(
        read_sidebar_storage(&raw).unwrap().layout(&scope).unwrap()[0].name,
        "from-group"
    );
}

#[test]
fn no_sidebar_keys_at_all_read_as_no_sections_and_no_pins() {
    let read = read_sidebar_storage(&JsMap::new()).unwrap();
    assert!(read.layout(&scope_of()).unwrap().is_empty());
    assert!(read.starred.is_empty());
}

#[test]
fn pins_are_read_as_lower_case_aliases_a_pin_of_another_kind_is_ignored_one_relay_cannot_read_refuses()
 {
    let [a, b] = ids::<2>();
    let pins = |list: Value| {
        read_sidebar_storage(&raw(vec![(
            "LSS-persisted.starred-local-code-sessions",
            wrapped(list),
        )]))
        .map(|r| r.starred)
    };
    let found: Vec<String> = pins(json!([
        format!("local_{}", a.to_uppercase()),
        format!("code:local_{b}"),
        "routine_daily"
    ]))
    .unwrap()
    .into_iter()
    .collect();
    assert_eq!(found, [a.clone(), b.clone()]);
    // Read as unpinned, these would be moved, and a move unpins on every account.
    assert!(pins(json!([42])).is_err());
    assert!(pins(json!([format!("cloud_{a}")])).is_err());
    assert!(pins(json!([format!("local_{a}_v2")])).is_err());
}

#[test]
fn a_shape_relay_does_not_know_is_refused_never_guessed_at() {
    let scope = scope_of();
    let good = || {
        simple(
            &scope,
            &[Group {
                id: "cg-1",
                name: "x",
                members: vec![],
            }],
        )
    };
    let refused = |raw: JsMap<String>| {
        let result = read_sidebar_storage(&raw).and_then(|r| r.layout(&scope));
        assert!(result.is_err(), "{raw:?}");
    };
    refused(storage(&scope, &[], false, &[], 2));
    let mut not_json = good();
    not_json.insert("dframe-store", "{not json".into());
    refused(not_json);
    let mut array = good();
    array.insert("LSS-persisted.dframe-group-scopes", "[]".into());
    refused(array);
    let k = key(&scope);
    let mut v3 = good();
    edit_store(&mut v3, |store| {
        store["state"]["codeSidebarByScope"][&k]["sections"][2]["v"] = json!(3)
    });
    refused(v3);
    let mut bad_groups = good();
    edit_store(&mut bad_groups, |store| {
        store["state"]["customGroupsByScope"][&k]["groups"] = json!({ "id": "cg-1" })
    });
    refused(bad_groups);
}

/// Conversations each carried under the same alias unless `to` says otherwise.
fn carried(
    pairs: &[(&String, &String, Option<&String>)],
    target: &str,
) -> Vec<CarriedConversation> {
    pairs
        .iter()
        .map(|(alias, from, to)| CarriedConversation {
            target_alias: (*to).unwrap_or(alias).clone(),
            members: std::iter::once(CarriedMember {
                alias: (*alias).clone(),
                account_uuid: (*from).clone(),
            })
            .chain(to.map(|to| CarriedMember {
                alias: to.clone(),
                account_uuid: target.to_owned(),
            }))
            .collect(),
        })
        .collect()
}

fn account(uuid: &str, layout: Vec<SidebarSection>) -> AccountLayout {
    AccountLayout {
        account_uuid: uuid.to_owned(),
        layout,
    }
}

fn gap_section(name: &str, ids: &[&String]) -> GapSection {
    GapSection {
        name: name.into(),
        ids: ids.iter().map(|i| (*i).clone()).collect(),
    }
}

#[test]
fn the_gap_lists_missing_sections_empty_ones_too_with_the_targets_aliases() {
    let (a, b) = (uuid(), uuid());
    let [x, y, z, renamed] = ids::<4>();
    let gap = plan_sidebar_gap(
        &[account(
            &a,
            vec![
                sec("cg-1", "bidsorted", &[&x, &y]),
                sec("cg-2", "landing", &[]),
            ],
        )],
        &account(&b, vec![]),
        &carried(
            &[(&x, &a, None), (&y, &a, Some(&renamed)), (&z, &a, None)],
            &b,
        ),
        &IndexSet::new(),
    );
    assert_eq!(
        gap,
        Some(SidebarGap {
            sections: vec![
                gap_section("bidsorted", &[&x, &renamed]),
                gap_section("landing", &[])
            ],
            missing_sections: 2,
            sessions: 2,
            from: vec![a],
        })
    );
}

#[test]
fn fill_gaps_only_what_the_target_already_has_is_never_moved_and_pins_are_left_alone() {
    let (a, b) = (uuid(), uuid());
    let [filed, pinned, open, uncarried] = ids::<4>();
    let gap = plan_sidebar_gap(
        &[account(
            &a,
            vec![
                sec("cg-1", "kept", &[&filed, &pinned, &open, &uncarried]),
                sec("cg-2", "already-there", &[]),
            ],
        )],
        &account(
            &b,
            vec![
                sec("cg-9", "already-there", &[]),
                sec("cg-8", "elsewhere", &[&filed]),
            ],
        ),
        &carried(
            &[(&filed, &a, None), (&pinned, &a, None), (&open, &a, None)],
            &b,
        ),
        &IndexSet::from([pinned.clone()]),
    );
    assert_eq!(
        gap,
        Some(SidebarGap {
            sections: vec![gap_section("kept", &[&open])],
            missing_sections: 1,
            sessions: 1,
            from: vec![a]
        })
    );
}

#[test]
fn a_section_the_target_has_is_listed_only_for_the_sessions_to_file_in_it() {
    let a = uuid();
    let [x] = ids::<1>();
    let gap = plan_sidebar_gap(
        &[account(&a, vec![sec("cg-1", "same", &[&x])])],
        &account(&uuid(), vec![sec("cg-2", "same", &[])]),
        &carried(&[(&x, &a, None)], &uuid()),
        &IndexSet::new(),
    );
    assert_eq!(
        gap,
        Some(SidebarGap {
            sections: vec![gap_section("same", &[&x])],
            missing_sections: 0,
            sessions: 1,
            from: vec![a]
        })
    );
}

#[test]
fn nothing_missing_is_no_gap() {
    let a = uuid();
    let [x] = ids::<1>();
    assert_eq!(
        plan_sidebar_gap(
            &[account(&a, vec![sec("cg-1", "same", &[&x])])],
            &account(&uuid(), vec![sec("cg-2", "same", &[&x])]),
            &carried(&[(&x, &a, None)], &uuid()),
            &IndexSet::new(),
        ),
        None
    );
    assert_eq!(
        plan_sidebar_gap(&[], &account(&uuid(), vec![]), &[], &IndexSet::new()),
        None
    );
}

#[test]
fn the_account_being_left_comes_first_it_places_sections_and_decides_where_a_session_goes() {
    let (left, other) = (uuid(), uuid());
    let [x, y] = ids::<2>();
    let member = |alias: &String, account: &String| CarriedMember {
        alias: alias.clone(),
        account_uuid: account.clone(),
    };
    let gap = plan_sidebar_gap(
        &[
            account(&left, vec![sec("cg-1", "mine", &[&x])]),
            account(
                &other,
                vec![sec("cg-2", "theirs", &[&x, &y]), sec("cg-3", "mine", &[&y])],
            ),
        ],
        &account(&uuid(), vec![]),
        &[
            CarriedConversation {
                target_alias: x.clone(),
                members: vec![member(&x, &left), member(&x, &other)],
            },
            CarriedConversation {
                target_alias: y.clone(),
                members: vec![member(&y, &other)],
            },
        ],
        &IndexSet::new(),
    )
    .unwrap();
    assert_eq!(
        gap.sections,
        [gap_section("mine", &[&x]), gap_section("theirs", &[&y])]
    );
    assert_eq!(gap.from, [left, other]);
}

#[test]
fn a_conversation_the_target_had_filed_under_an_alias_the_merge_replaced_goes_back_to_the_targets_section()
 {
    let (a, b) = (uuid(), uuid());
    let [old_alias, new_alias] = ids::<2>();
    let gap = plan_sidebar_gap(
        &[account(&a, vec![sec("cg-1", "theirs", &[&new_alias])])],
        &account(&b, vec![sec("cg-9", "mine", &[&old_alias])]),
        // B's card `old_alias` is replaced by A's newer `new_alias`.
        &[CarriedConversation {
            target_alias: new_alias.clone(),
            members: vec![
                CarriedMember {
                    alias: new_alias.clone(),
                    account_uuid: a.clone(),
                },
                CarriedMember {
                    alias: old_alias.clone(),
                    account_uuid: b.clone(),
                },
            ],
        }],
        &IndexSet::new(),
    );
    assert_eq!(
        gap,
        Some(SidebarGap {
            sections: vec![
                gap_section("mine", &[&new_alias]),
                gap_section("theirs", &[])
            ],
            missing_sections: 1,
            sessions: 1,
            from: vec![a],
        })
    );
}

#[test]
fn a_recipe_that_only_restores_the_targets_own_filing_names_no_source() {
    let text = sidebar_recipe(
        &SidebarGap {
            sections: vec![gap_section("mine", &[&uuid()])],
            missing_sections: 0,
            sessions: 1,
            from: vec![],
        },
        "Alto",
        &[],
    );
    assert!(text.contains("(Alto). They put sessions back where this account had filed them"));
}

#[test]
fn the_recipe_names_the_accounts_keeps_the_order_and_the_fill_gaps_rules_and_lists_ids() {
    let [x, y] = ids::<2>();
    let gap = SidebarGap {
        sections: vec![
            gap_section("bidsorted", &[&x, &y]),
            gap_section("landing", &[]),
        ],
        missing_sections: 2,
        sessions: 2,
        from: vec![],
    };
    let text = sidebar_recipe(&gap, "Alto", &["Vertex".to_owned()]);
    assert!(text.contains("on this account (Alto). They come from Vertex"));
    assert!(text.contains("list_sections, create_section, move_sessions"));
    // list_sessions lists 20 by default and leaves archived ones out.
    assert!(text.contains(&format!(
        "list_sessions with limit {LIST_LIMIT} and include_archived true"
    )));
    const _: () = assert!(LIST_LIMIT >= 1000);
    assert!(text.contains("the same name (ignoring spaces at either end)"));
    assert!(text.contains(&format!("at most {MOVE_BATCH} ids per call")));
    assert!(text.contains("never pin or unpin anything"));
    assert!(text.contains("one whose pinned is true"));
    assert!(text.contains("one whose group is already another section"));
    assert!(text.contains(&format!("### bidsorted\n\nlocal_{x} local_{y}\n")));
    assert!(text.contains("### landing\n\n(no sessions: create the section only)"));
    assert!(text.find("### bidsorted") < text.find("### landing"));
}

fn some_gap() -> SidebarGap {
    SidebarGap {
        sections: vec![gap_section("x", &[&uuid()])],
        missing_sections: 1,
        sessions: 1,
        from: vec![uuid()],
    }
}

#[test]
fn the_vault_keeps_one_offer_gives_it_back_and_removes_it_only_by_its_own_id() {
    let dir = tempfile::Builder::new()
        .prefix("relay-sidebar-")
        .tempdir()
        .unwrap();
    let vault = SidebarGapVault::new(dir.path());
    assert_eq!(vault.get(), None);
    let to = uuid();
    let gap = some_gap();
    let first = vault.put(&to, gap.clone()).unwrap();
    assert_eq!(vault.get(), Some(first.clone()));
    assert_eq!(first.gap, gap);
    let second = vault.put(&to, some_gap()).unwrap();
    vault.remove(&first.id).unwrap();
    assert_eq!(vault.get(), Some(second.clone()));
    vault.remove(&second.id).unwrap();
    assert_eq!(vault.get(), None);
}

#[test]
fn an_offer_over_14_days_old_or_a_file_the_vault_did_not_write_reads_as_none() {
    let dir = tempfile::Builder::new()
        .prefix("relay-sidebar-")
        .tempdir()
        .unwrap();
    let now = Arc::new(Mutex::new(
        chrono::DateTime::parse_from_rfc3339("2026-10-19T12:00:00Z")
            .unwrap()
            .timestamp_millis(),
    ));
    let clock = now.clone();
    let vault = SidebarGapVault::with_clock(dir.path(), Arc::new(move || *clock.lock().unwrap()));
    vault.put(&uuid(), some_gap()).unwrap();
    *now.lock().unwrap() += 14 * 86_400_000;
    assert!(vault.get().is_some());
    *now.lock().unwrap() += 1;
    assert_eq!(vault.get(), None);
    let file = dir.path().join("sidebar").join("pending.json");
    std::fs::write(&file, "{oops").unwrap();
    assert_eq!(vault.get(), None);
    let at = relay_core::fs_util::iso_timestamp(*now.lock().unwrap());
    std::fs::write(
        &file,
        json!({ "id": "x", "to": uuid(), "at": at, "gap": some_gap() }).to_string(),
    )
    .unwrap();
    assert_eq!(vault.get(), None);
}

fn map(pairs: &[(&str, &str)]) -> JsMap<String> {
    pairs
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect()
}

#[test]
fn the_helpers_sidebar_answer_is_kept_only_when_it_is_the_sidebar_keys_as_strings() {
    let sidebar = map(&[
        ("dframe-store", "{}"),
        ("LSS-persisted.starred-local-code-sessions", "{}"),
    ]);
    let answer = |sidebar: JsMap<String>| {
        checked_result(DraftResult::Ok {
            drafts: JsMap::new(),
            sidebar: Some(sidebar),
        })
    };
    assert_eq!(
        answer(sidebar.clone()),
        DraftResult::Ok {
            drafts: JsMap::new(),
            sidebar: Some(sidebar)
        }
    );
    // Off answers lose only the sidebar: the drafts still stand. (Values that are not strings
    // cannot be expressed here: the reader only ever yields strings.)
    assert_eq!(
        answer(map(&[("other", "{}")])),
        DraftResult::Ok {
            drafts: JsMap::new(),
            sidebar: None
        }
    );
    let huge = "x".repeat(4 * 1024 * 1024);
    assert_eq!(
        answer(map(&[("dframe-store", &huge)])),
        DraftResult::Ok {
            drafts: JsMap::new(),
            sidebar: None
        }
    );
}

/// A page answering from fixed values; `sidebar` None is a page that cannot say.
struct Page {
    sidebar: Option<Result<JsMap<String>, String>>,
}

impl DraftPage for Page {
    fn size(&self) -> Result<usize, String> {
        Ok(3)
    }
    fn read(&self) -> Result<JsMap<String>, String> {
        Ok(map(&[("composer-draft:epitaxy-draft", "{}")]))
    }
    fn read_sidebar(&self) -> Option<Result<JsMap<String>, String>> {
        self.sidebar.clone()
    }
}

#[test]
fn the_helper_job_reads_the_sidebar_after_the_drafts_and_a_sidebar_that_fails_costs_nothing() {
    let drafts = map(&[("composer-draft:epitaxy-draft", "{}")]);
    assert_eq!(
        run_draft_job(&Page {
            sidebar: Some(Ok(map(&[("dframe-store", "{}")])))
        }),
        DraftResult::Ok {
            drafts: drafts.clone(),
            sidebar: Some(map(&[("dframe-store", "{}")]))
        }
    );
    assert_eq!(
        run_draft_job(&Page {
            sidebar: Some(Err("no".into()))
        }),
        DraftResult::Ok {
            drafts: drafts.clone(),
            sidebar: None
        }
    );
    assert_eq!(
        run_draft_job(&Page { sidebar: None }),
        DraftResult::Ok {
            drafts: drafts.clone(),
            sidebar: None
        }
    );
    // A sidebar too large to fit beside the drafts is left out.
    let huge = "x".repeat(MAX_SIDEBAR_CHARS);
    assert_eq!(
        run_draft_job(&Page {
            sidebar: Some(Ok(map(&[("dframe-store", &huge)])))
        }),
        DraftResult::Ok {
            drafts,
            sidebar: None
        }
    );
}

#[test]
fn the_helper_reads_exactly_the_sidebar_keys_and_the_worker_never_writes_them() {
    assert_eq!(
        SIDEBAR_KEYS,
        [
            "dframe-store",
            "LSS-persisted.dframe-group-scopes",
            "LSS-persisted.dframe-code-sections",
            "LSS-persisted.starred-local-code-sessions",
        ]
    );
}
