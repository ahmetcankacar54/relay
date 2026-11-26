//! Forecast segments as the TS builds them: an outage is `{ accountId: undefined, from, to }`,
//! a key that holds `undefined`, where relay-core leaves the key out (`JSON.stringify` writes
//! both the same).

use serde_json::{Map, Value};

/// Puts `accountId: undefined` first in every outage segment under a `segments` key.
pub fn mark_outages(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (key, item) in map.iter_mut() {
                if key == "segments"
                    && let Value::Array(segments) = item
                {
                    for segment in segments {
                        if let Value::Object(fields) = segment
                            && !fields.contains_key("accountId")
                        {
                            let mut marked = Map::new();
                            marked.insert("accountId".into(), crate::js::undefined());
                            marked.extend(std::mem::take(fields));
                            *fields = marked;
                        }
                    }
                } else {
                    mark_outages(item);
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(mark_outages),
        _ => {}
    }
}
