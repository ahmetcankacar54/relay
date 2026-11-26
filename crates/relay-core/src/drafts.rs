//! Port of `electron/core/drafts.ts`: which of account A's unsent Claude drafts are worth
//! re-typing once Claude runs as account B.

use std::collections::{BTreeSet, HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::desktop_files::CarriedConversation;
use crate::shared::types::js::JsMap;

/// Every draft Claude keeps in Local Storage has a key that starts with this.
pub const DRAFT_KEY_PREFIX: &str = "composer-draft:";
/// Claude's Local Storage key for the unsent draft of a Code conversation, followed by its alias.
pub const CONVERSATION_DRAFT_PREFIX: &str = "composer-draft:epitaxy-local_";
/// Claude's Local Storage key for the draft of a session that does not exist yet.
pub const NEW_SESSION_DRAFT: &str = "composer-draft:epitaxy-draft";

/// An unsent draft of account A that is worth re-typing once Claude runs as account B.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturedDraft {
    /// The alias of B's session the draft belongs to. Absent for the new-session draft.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_alias: Option<String>,
    /// Set (always `true`) on the draft of a session that does not exist yet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_session: Option<bool>,
    /// B's title for the conversation, or "" when there is none.
    pub title: String,
    pub text: String,
    /// The draft also holds files or snippets, which cannot be re-typed.
    pub attachments: bool,
}

/// A JSON object with a string `owner`.
fn parse_draft(raw: &str) -> Option<Map<String, Value>> {
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Object(map)) if map.get("owner").is_some_and(Value::is_string) => Some(map),
        _ => None,
    }
}

fn owner(draft: &Map<String, Value>) -> &str {
    draft
        .get("owner")
        .and_then(Value::as_str)
        .unwrap_or_default()
}

/// `text.trim() === ""` in JS.
fn js_blank(text: &str) -> bool {
    crate::shared::model_prices::js_trim(text).is_empty()
}

/// The draft's text, or "" when it has none worth keeping.
fn text_of(draft: &Map<String, Value>) -> &str {
    match draft.get("text").and_then(Value::as_str) {
        Some(text) if !js_blank(text) => text,
        _ => "",
    }
}

fn attached(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_array)
        .is_some_and(|list| !list.is_empty())
}

/// Picks the unsent drafts of account `from` that are worth re-typing after a switch away from
/// it. Nothing is written or removed: this only reads.
///
/// A conversation's drafts are looked for at its target alias and at every member alias. Of
/// `from`'s drafts there, the one at the target alias is kept, otherwise the lexically first.
/// Drafts of other accounts are never kept, and a draft is kept for one conversation only. A
/// conversation whose target key holds a value that is not a draft is skipped altogether. Drafts
/// without text are not kept, and neither are values that are not a JSON object with a string
/// `owner`. The draft of a session that does not exist yet comes last.
///
/// `drafts` holds every `composer-draft:` key with its raw string value. `titles` maps a
/// conversation's target alias to the title the account switched to gives it.
pub fn select_drafts(
    drafts: &JsMap<String>,
    from: &str,
    conversations: &[CarriedConversation],
    titles: &HashMap<String, String>,
) -> Vec<CapturedDraft> {
    // Account UUIDs compare without case.
    let from_key = from.to_lowercase();
    let is_from = |draft: &Map<String, Value>| owner(draft).to_lowercase() == from_key;
    let mut seen: HashSet<String> = HashSet::new();
    // The parsed draft at `key` when it is in scope; `Some(None)` when its value is not a draft.
    let mut read = |key: &str| -> Option<Option<Map<String, Value>>> {
        let raw = drafts.get(key)?;
        if !seen.insert(key.to_owned()) {
            return None;
        }
        Some(parse_draft(raw))
    };
    let capture = |draft: &Map<String, Value>, target_alias: Option<String>, title: String| {
        let new_session = target_alias.is_none().then_some(true);
        CapturedDraft {
            target_alias,
            new_session,
            title,
            text: text_of(draft).to_owned(),
            attachments: attached(draft.get("files")) || attached(draft.get("snippets")),
        }
    };

    let mut captured = Vec::new();
    for conversation in conversations {
        let target_key = format!("{CONVERSATION_DRAFT_PREFIX}{}", conversation.target_alias);
        // Sorted by UTF-16 code units as JS sorts; aliases are ASCII in practice.
        let keys: BTreeSet<Vec<u16>> = std::iter::once(target_key.clone())
            .chain(
                conversation
                    .members
                    .iter()
                    .map(|member| format!("{CONVERSATION_DRAFT_PREFIX}{}", member.alias)),
            )
            .map(|key| key.encode_utf16().collect())
            .collect();
        let mut mine: Vec<(String, Map<String, Value>)> = Vec::new();
        for key in keys {
            let key = String::from_utf16_lossy(&key);
            if let Some(Some(draft)) = read(&key)
                && is_from(&draft)
                && !text_of(&draft).is_empty()
            {
                mine.push((key, draft));
            }
        }
        // A value Relay cannot read may be a draft of any account: the conversation is left out.
        if let Some(raw) = drafts.get(&target_key)
            && parse_draft(raw).is_none()
        {
            continue;
        }
        if mine.is_empty() {
            continue;
        }
        // The draft already at the target alias wins; otherwise the lexically first.
        let keep = mine
            .iter()
            .find(|(key, _)| *key == target_key)
            .unwrap_or(&mine[0]);
        let title = titles
            .get(&conversation.target_alias)
            .cloned()
            .unwrap_or_default();
        captured.push(capture(
            &keep.1,
            Some(conversation.target_alias.clone()),
            title,
        ));
    }

    if let Some(Some(new_session)) = read(NEW_SESSION_DRAFT)
        && is_from(&new_session)
        && !text_of(&new_session).is_empty()
    {
        captured.push(capture(&new_session, None, String::new()));
    }
    captured
}
