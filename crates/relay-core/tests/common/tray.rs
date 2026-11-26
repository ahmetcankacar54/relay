//! Fixtures for the tray, mascot and switch-scene ports: JSON builders with the TS spread rules.
#![allow(dead_code)]

use relay_core::shared::types::js::{date_parse, iso};
use serde_json::Value;

pub fn ms(text: &str) -> f64 {
    date_parse(text)
}

pub fn at(ms: f64) -> String {
    iso(ms)
}

pub fn from_json<T: serde::de::DeserializeOwned>(value: Value) -> T {
    serde_json::from_value(value).expect("fixture")
}

/// `{ ...base, ...patch }`: a `null` in the patch is `undefined`, which drops the key.
pub fn spread(base: Value, patch: Value) -> Value {
    let (Value::Object(mut base), Value::Object(patch)) = (base, patch) else {
        panic!("spread needs two objects");
    };
    for (key, value) in patch {
        if value.is_null() {
            base.remove(&key);
        } else {
            base.insert(key, value);
        }
    }
    Value::Object(base)
}
