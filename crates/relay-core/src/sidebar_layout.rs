//! Port of `electron/core/sidebar-layout.ts`: reading Claude Desktop's Code sidebar organization
//! from its Local Storage values, and planning what the account switched to lacks of it.
//!
//! Claude Desktop keeps each account's Code sidebar organization in its shared Local Storage, per
//! `<accountUuid>/<orgId>` scope, and keeps it more than once (found 2026-10-19):
//! - `dframe-store` (zustand persist, version 1): `state.customGroupsByScope[scope]` holds the
//!   custom groups and `state.codeSidebarByScope[scope]` the sections; a "manual" section's id is
//!   its group's id.
//! - `LSS-persisted.dframe-group-scopes` and `LSS-persisted.dframe-code-sections`: the same two
//!   maps under `value`. They can lag behind `dframe-store`, which is what the sidebar shows.
//!
//! The Pinned section is the global `LSS-persisted.starred-local-code-sessions`, keyed by alias.
//! Relay only reads these, from a copy, and never writes them.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use indexmap::{IndexMap, IndexSet};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::desktop_files::{CarriedConversation, Scope};
use crate::shared::types::js::JsMap;

/// Why the sidebar step stops: Desktop's storage has a shape Relay does not know.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("unsupported Desktop sidebar format: {0}")]
pub struct UnsupportedSidebar(pub String);

fn unsupported(what: impl Into<String>) -> UnsupportedSidebar {
    UnsupportedSidebar(what.into())
}

/// One custom ("manual") section of an account's Code sidebar.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SidebarSection {
    pub id: String,
    /// As the user named it, trimmed. May be empty.
    pub name: String,
    /// The aliases filed in it, lower case, in sidebar order.
    pub members: Vec<String>,
}

/// An account's custom sections, in sidebar order.
pub type SidebarLayout = Vec<SidebarSection>;

type Json = Map<String, Value>;
const STORE_VERSION: f64 = 1.0;
const SECTION_VERSION: f64 = 2.0;

const HEX_UUID: &str =
    "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
static CODE_KEY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!("^(?i-u:code:local_)({HEX_UUID})$")).expect("static"));
static PIN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!("^(?i-u:(?:code:)?local_)({HEX_UUID})$")).expect("static")
});
static ANY_UUID: LazyLock<Regex> = LazyLock::new(|| Regex::new(HEX_UUID).expect("static"));

/// The JSON object in `raw[key]`, None when the key is absent.
fn parsed(raw: &JsMap<String>, key: &str) -> Result<Option<Json>, UnsupportedSidebar> {
    let Some(text) = raw.get(key) else {
        return Ok(None);
    };
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(map)) => Ok(Some(map)),
        Ok(_) => Err(unsupported(format!("{key} is not an object"))),
        Err(_) => Err(unsupported(format!("{key} is not JSON"))),
    }
}

/// An optional map inside an object: absent is empty, anything but an object is refused.
fn map(owner: Option<&Json>, key: &str, where_: &str) -> Result<Json, UnsupportedSidebar> {
    match owner.and_then(|o| o.get(key)) {
        None => Ok(Json::new()),
        Some(Value::Object(map)) => Ok(map.clone()),
        Some(_) => Err(unsupported(format!("{where_}.{key}"))),
    }
}

/// The value a `LSS-persisted.*` key wraps, `{value, tabId, timestamp}`.
fn persisted(raw: &JsMap<String>, key: &str) -> Result<Json, UnsupportedSidebar> {
    match parsed(raw, key)? {
        None => Ok(Json::new()),
        Some(outer) => map(Some(&outer), "value", key),
    }
}

/// The entry for `scope` in a map keyed by `<accountUuid>/<orgId>`, compared in lower case.
fn scoped<'a>(
    entries: &'a Json,
    scope: &Scope,
    where_: &str,
) -> Result<Option<&'a Json>, UnsupportedSidebar> {
    let want = format!("{}/{}", scope.account_uuid, scope.org_id).to_lowercase();
    let Some((_, entry)) = entries.iter().find(|(k, _)| k.to_lowercase() == want) else {
        return Ok(None);
    };
    match entry {
        Value::Object(entry) => Ok(Some(entry)),
        _ => Err(unsupported(format!("{where_} entry"))),
    }
}

struct Group {
    id: String,
    name: String,
}

struct Groups {
    groups: Vec<Group>,
    assignments: Vec<(String, String)>,
    order: HashMap<String, Vec<String>>,
}

/// A scope's custom groups, `{groups, assignments, order}`.
fn groups_of(entry: Option<&Json>, where_: &str) -> Result<Groups, UnsupportedSidebar> {
    let Some(entry) = entry else {
        return Ok(Groups {
            groups: Vec::new(),
            assignments: Vec::new(),
            order: HashMap::new(),
        });
    };
    let groups = match entry.get("groups") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(list)) => list
            .iter()
            .map(|g| match g {
                Value::Object(g) => match (g.get("id"), g.get("name")) {
                    (Some(Value::String(id)), Some(Value::String(name))) => Some(Group {
                        id: id.clone(),
                        name: name.clone(),
                    }),
                    _ => None,
                },
                _ => None,
            })
            .collect::<Option<Vec<_>>>()
            .ok_or_else(|| unsupported(format!("{where_}.groups")))?,
        Some(_) => return Err(unsupported(format!("{where_}.groups"))),
    };
    let assignments = map(Some(entry), "assignments", where_)?
        .into_iter()
        .map(|(k, v)| match v {
            Value::String(g) => Some((k, g)),
            _ => None,
        })
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| unsupported(format!("{where_}.assignments")))?;
    let order = map(Some(entry), "order", where_)?
        .into_iter()
        .map(|(k, list)| {
            let list = list.as_array()?;
            let keys = list
                .iter()
                .map(|key| key.as_str().map(str::to_owned))
                .collect::<Option<Vec<_>>>()?;
            Some((k, keys))
        })
        .collect::<Option<HashMap<_, _>>>()
        .ok_or_else(|| unsupported(format!("{where_}.order")))?;
    Ok(Groups {
        groups,
        assignments,
        order,
    })
}

struct Section {
    id: String,
    kind: String,
    name: String,
    order: Option<f64>,
    members: Option<Vec<String>>,
}

/// A scope's sections; a version other than 2 is refused, not guessed at.
fn sections_of(entry: Option<&Json>, where_: &str) -> Result<Vec<Section>, UnsupportedSidebar> {
    let Some(entry) = entry else {
        return Ok(Vec::new());
    };
    let sections = match entry.get("sections") {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Array(list)) => list,
        Some(_) => return Err(unsupported(format!("{where_}.sections"))),
    };
    sections
        .iter()
        .map(|s| {
            let refused = || unsupported(format!("{where_}.sections entry"));
            let s = s.as_object().ok_or_else(refused)?;
            let (Some(Value::String(id)), Some(Value::String(kind))) = (s.get("id"), s.get("kind"))
            else {
                return Err(refused());
            };
            let name = match s.get("name") {
                None => String::new(),
                Some(Value::String(name)) => name.clone(),
                Some(_) => return Err(refused()),
            };
            if let Some(v) = s.get("v")
                && v.as_f64() != Some(SECTION_VERSION)
            {
                return Err(refused());
            }
            let order = match s.get("order") {
                None => None,
                Some(Value::Number(n)) => n.as_f64(),
                Some(_) => return Err(refused()),
            };
            let members = match s.get("members") {
                None => None,
                Some(Value::Array(list)) => Some(
                    list.iter()
                        .map(|m| m.as_str().map(str::to_owned))
                        .collect::<Option<Vec<_>>>()
                        .ok_or_else(refused)?,
                ),
                Some(_) => return Err(refused()),
            };
            Ok(Section {
                id: id.clone(),
                kind: kind.clone(),
                name,
                order,
                members,
            })
        })
        .collect()
}

/// The alias in a `code:local_<alias>` key, lower case; None for anything else.
fn code_alias(key: &str) -> Option<String> {
    CODE_KEY.captures(key).map(|c| c[1].to_lowercase())
}

/// What Relay read of Claude's sidebar storage.
#[derive(Debug, Clone)]
pub struct SidebarStorage {
    /// The pinned sessions' aliases, lower case. Pins are not per account.
    pub starred: IndexSet<String>,
    store_groups: Json,
    store_sections: Json,
    lss_groups: Json,
    lss_sections: Json,
}

/// JS `String#trim`.
fn js_trim(text: &str) -> &str {
    crate::shared::model_prices::js_trim(text)
}

impl SidebarStorage {
    /// The custom sections of `scope`; none when Desktop has none for it.
    pub fn layout(&self, scope: &Scope) -> Result<SidebarLayout, UnsupportedSidebar> {
        // `dframe-store` is what the sidebar shows. The LSS copies can lag behind it, keeping a
        // group the user deleted or filings the user undid, so they count only for a scope
        // `dframe-store` does not have at all.
        let groups = match scoped(&self.store_groups, scope, "customGroupsByScope")? {
            Some(entry) => groups_of(Some(entry), "customGroupsByScope")?,
            None => groups_of(
                scoped(&self.lss_groups, scope, "dframe-group-scopes")?,
                "dframe-group-scopes",
            )?,
        };
        let sections_entry = match scoped(&self.store_sections, scope, "codeSidebarByScope")? {
            Some(entry) => Some(entry),
            None => scoped(&self.lss_sections, scope, "dframe-code-sections")?,
        };
        let sections = sections_of(sections_entry, "sections")?;

        struct Entry {
            id: String,
            name: String,
            order: f64,
            index: usize,
        }
        let mut by_id: IndexMap<String, Entry> = IndexMap::new();
        let mut add = |id: &str, name: &str, order: Option<f64>| {
            if !by_id.contains_key(id) {
                let index = by_id.len();
                by_id.insert(
                    id.to_owned(),
                    Entry {
                        id: id.to_owned(),
                        name: js_trim(name).to_owned(),
                        order: order.unwrap_or(f64::INFINITY),
                        index,
                    },
                );
            }
        };
        for s in sections.iter().filter(|s| s.kind == "manual") {
            add(&s.id, &s.name, s.order);
        }
        for g in &groups.groups {
            add(&g.id, &g.name, None);
        }
        // A section without a name of its own shows its group's.
        for g in &groups.groups {
            let entry = by_id.get_mut(&g.id).expect("added above");
            if entry.name.is_empty() {
                entry.name = js_trim(&g.name).to_owned();
            }
        }

        let mut filed: IndexMap<String, String> = IndexMap::new();
        let mut file = |alias: Option<String>, id: &str| {
            if let Some(alias) = alias
                && by_id.contains_key(id)
                && !filed.contains_key(&alias)
            {
                filed.insert(alias, id.to_owned());
            }
        };
        for (key, id) in &groups.assignments {
            file(code_alias(key), id);
        }
        for s in sections.iter().filter(|s| s.kind == "manual") {
            for key in s.members.iter().flatten() {
                file(code_alias(key), &s.id);
            }
        }

        let mut entries: Vec<&Entry> = by_id.values().collect();
        entries.sort_by(|a, b| {
            a.order
                .partial_cmp(&b.order)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(a.index.cmp(&b.index))
        });
        Ok(entries
            .into_iter()
            .map(|entry| {
                let mut members: Vec<String> = Vec::new();
                for key in groups.order.get(&entry.id).into_iter().flatten() {
                    if let Some(alias) = code_alias(key)
                        && filed.get(&alias) == Some(&entry.id)
                        && !members.contains(&alias)
                    {
                        members.push(alias);
                    }
                }
                for (alias, section_id) in &filed {
                    if *section_id == entry.id && !members.contains(alias) {
                        members.push(alias.clone());
                    }
                }
                SidebarSection {
                    id: entry.id.clone(),
                    name: entry.name.clone(),
                    members,
                }
            })
            .collect())
    }
}

/// Reads the raw values of `SIDEBAR_KEYS` the draft reader found. A missing key reads as no
/// organization. Fails with `UnsupportedSidebar` on any shape Relay does not know, so nothing is
/// planned from a guess.
pub fn read_sidebar_storage(raw: &JsMap<String>) -> Result<SidebarStorage, UnsupportedSidebar> {
    let store = parsed(raw, "dframe-store")?;
    if let Some(store) = &store
        && store.get("version").and_then(Value::as_f64) != Some(STORE_VERSION)
    {
        return Err(unsupported("dframe-store version"));
    }
    let state = match &store {
        Some(store) => map(Some(store), "state", "dframe-store")?,
        None => Json::new(),
    };
    let store_groups = map(Some(&state), "customGroupsByScope", "dframe-store")?;
    let store_sections = map(Some(&state), "codeSidebarByScope", "dframe-store")?;
    let lss_groups = persisted(raw, "LSS-persisted.dframe-group-scopes")?;
    let lss_sections = persisted(raw, "LSS-persisted.dframe-code-sections")?;
    let starred_raw = parsed(raw, "LSS-persisted.starred-local-code-sessions")?;
    let empty = Vec::new();
    let starred_list = match starred_raw.as_ref().and_then(|s| s.get("value")) {
        None | Some(Value::Null) => &empty,
        Some(Value::Array(list)) => list,
        Some(_) => return Err(unsupported("LSS-persisted.starred-local-code-sessions")),
    };
    let mut starred = IndexSet::new();
    for id in starred_list {
        let Value::String(id) = id else {
            return Err(unsupported("pinned entry"));
        };
        if let Some(c) = PIN.captures(id) {
            starred.insert(c[1].to_lowercase());
        } else if ANY_UUID.is_match(id) {
            // A pin that names a session in a form Relay does not know is refused: read as
            // unpinned, the recipe would move it, and moving unpins it on every account. A pin of
            // another kind, with no session id in it, is not a local session's.
            return Err(unsupported("pinned entry"));
        }
    }
    Ok(SidebarStorage {
        starred,
        store_groups,
        store_sections,
        lss_groups,
        lss_sections,
    })
}

/// One section of a gap: its name and the sessions to file in it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GapSection {
    pub name: String,
    pub ids: Vec<String>,
}

/// What the target account lacks of its sources' organization.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidebarGap {
    /// Sections in the order the recipe creates them, each with the sessions to file in it.
    pub sections: Vec<GapSection>,
    /// How many of those sections the target has no section of that name for.
    pub missing_sections: i64,
    /// How many sessions the recipe files, all sections together.
    pub sessions: i64,
    /// The source accounts the gap comes from, in order.
    pub from: Vec<String>,
}

/// An account and its sections, as `plan_sidebar_gap` takes them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountLayout {
    pub account_uuid: String,
    pub layout: SidebarLayout,
}

/// The organization the target lacks, as fill-gaps-only steps; None when it lacks nothing.
///
/// The target's own filing comes first: a conversation it had filed under an alias the merge
/// replaced (its card now has the conversation's `targetAlias`) goes back into the target's own
/// section. Then the sources, in priority order, the account being left first: the first source
/// that names a section places it, and the first that files a session decides where it goes. A
/// session is filed only when the switch carried its conversation to the target, it is not pinned
/// and the target has not filed it anywhere. Sections are matched by name. Nothing of the
/// target's own is ever moved, renamed or removed.
pub fn plan_sidebar_gap(
    sources: &[AccountLayout],
    target: &AccountLayout,
    conversations: &[CarriedConversation],
    starred: &IndexSet<String>,
) -> Option<SidebarGap> {
    let target_account = target.account_uuid.to_lowercase();
    let target_names: HashSet<&str> = target
        .layout
        .iter()
        .map(|s| s.name.as_str())
        .filter(|n| !n.is_empty())
        .collect();
    let target_filed: HashSet<&str> = target
        .layout
        .iter()
        .flat_map(|s| s.members.iter().map(String::as_str))
        .collect();
    let mut target_section: HashMap<&str, &str> = HashMap::new();
    for s in target.layout.iter().filter(|s| !s.name.is_empty()) {
        for alias in &s.members {
            target_section.insert(alias, &s.name);
        }
    }
    let mut carried: HashMap<String, String> = HashMap::new();
    for c in conversations {
        for m in &c.members {
            carried.insert(
                format!(
                    "{}|{}",
                    m.account_uuid.to_lowercase(),
                    m.alias.to_lowercase()
                ),
                c.target_alias.to_lowercase(),
            );
        }
    }

    struct Entry {
        name: String,
        ids: Vec<String>,
        from: HashSet<String>,
    }
    let mut planned: HashSet<String> = HashSet::new();
    let mut sections: IndexMap<String, Entry> = IndexMap::new();
    fn entry_for<'a>(
        sections: &'a mut IndexMap<String, Entry>,
        name: &str,
        source: Option<&str>,
    ) -> &'a mut Entry {
        sections.entry(name.to_owned()).or_insert_with(|| Entry {
            name: name.to_owned(),
            ids: Vec::new(),
            from: source.into_iter().map(str::to_owned).collect(),
        })
    }
    for c in conversations {
        let to = c.target_alias.to_lowercase();
        if target_filed.contains(to.as_str()) || starred.contains(&to) {
            continue;
        }
        let own = c.members.iter().find(|m| {
            m.account_uuid.to_lowercase() == target_account
                && target_section.contains_key(m.alias.to_lowercase().as_str())
        });
        let Some(own) = own else { continue };
        if planned.contains(&to) {
            continue;
        }
        planned.insert(to.clone());
        let name = target_section[own.alias.to_lowercase().as_str()];
        entry_for(&mut sections, name, None).ids.push(to);
    }
    for source in sources {
        let account = source.account_uuid.to_lowercase();
        for section in source.layout.iter().filter(|s| !s.name.is_empty()) {
            let entry = entry_for(&mut sections, &section.name, Some(&source.account_uuid));
            for alias in &section.members {
                let Some(to) = carried.get(&format!("{account}|{alias}")) else {
                    continue;
                };
                if starred.contains(to)
                    || target_filed.contains(to.as_str())
                    || planned.contains(to)
                {
                    continue;
                }
                planned.insert(to.clone());
                entry.ids.push(to.clone());
                entry.from.insert(source.account_uuid.clone());
            }
        }
    }
    // A section the target already has is only worth listing for the sessions to file in it.
    let kept: Vec<Entry> = sections
        .into_values()
        .filter(|s| !s.ids.is_empty() || !target_names.contains(s.name.as_str()))
        .collect();
    if kept.is_empty() {
        return None;
    }
    let contributed: HashSet<&String> = kept.iter().flat_map(|s| s.from.iter()).collect();
    let mut from: Vec<String> = Vec::new();
    for s in sources {
        if contributed.contains(&s.account_uuid) && !from.contains(&s.account_uuid) {
            from.push(s.account_uuid.clone());
        }
    }
    Some(SidebarGap {
        missing_sections: kept
            .iter()
            .filter(|s| !target_names.contains(s.name.as_str()))
            .count() as i64,
        sessions: kept.iter().map(|s| s.ids.len() as i64).sum(),
        sections: kept
            .into_iter()
            .map(|s| GapSection {
                name: s.name,
                ids: s.ids,
            })
            .collect(),
        from,
    })
}

/// Most ids Desktop's `move_sessions` takes in one call.
pub const MOVE_BATCH: usize = 100;

/// How many sessions the recipe asks `list_sessions` for: its default is only 20.
pub const LIST_LIMIT: usize = 1000;

/// The prompt the user pastes into a Code session on the target account: Claude rebuilds the
/// sections with Desktop's own sidebar tools, filling gaps only. `to` and `from` are account
/// names, for the reader; `from` is empty when the gap only restores the target's own filing.
pub fn sidebar_recipe(gap: &SidebarGap, to: &str, from: &[String]) -> String {
    let origin = if from.is_empty() {
        "They put sessions back where this account had filed them, as Relay read them at the last switch.".to_owned()
    } else {
        format!(
            "They come from {}, as Relay read them at the last switch.",
            from.join(", ")
        )
    };
    let mut lines: Vec<String> = vec![
        format!("Recreate my Code sidebar sections on this account ({to}). {origin}"),
        String::new(),
        "Use only the sidebar tools (list_sections, create_section, move_sessions) and list_sessions. Never delete, rename or reorder an existing section, and never pin or unpin anything.".to_owned(),
        String::new(),
        "1. Call list_sections. For each section below, reuse a \"manual\" section with the same name (ignoring spaces at either end); otherwise create it with create_section, in the order below.".to_owned(),
        format!("2. Call list_sessions with limit {LIST_LIMIT} and include_archived true, so that every session is listed. For each section, move the listed session ids into it with move_sessions (section_id; at most {MOVE_BATCH} ids per call). Leave out an id that list_sessions does not list, one whose pinned is true (moving would unpin it on every account), and one whose group is already another section."),
        "3. Do not touch any other session or setting. Finish with one line per section: created or reused, how many moved, how many left out and why.".to_owned(),
        String::new(),
        "## Sections".to_owned(),
    ];
    for section in &gap.sections {
        lines.push(String::new());
        lines.push(format!("### {}", section.name));
        lines.push(String::new());
        lines.push(if section.ids.is_empty() {
            "(no sessions: create the section only)".to_owned()
        } else {
            section
                .ids
                .iter()
                .map(|alias| format!("local_{alias}"))
                .collect::<Vec<_>>()
                .join(" ")
        });
    }
    lines.join("\n") + "\n"
}
