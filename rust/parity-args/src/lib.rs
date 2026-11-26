//! Structured arguments of rust-anything's napi bridges (`rust/<unit>-rs`) read as typed serde
//! values, the way the JS code sees them: `{"$num": "NaN"}` markers are numbers,
//! `{"$utf16": [...]}` markers are strings, keys holding `{"$undefined": true}` are absent (as
//! `JSON.stringify` drops them) and `undefined` or `null` is `None`. The parity crates' `port.rs`
//! files share this so their relay-core types deserialize straight from what `index.cjs` sends.

#![forbid(unsafe_code)]

use serde::de::value::BorrowedStrDeserializer;
use serde::de::{self, DeserializeOwned, DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Value};

/// A required structured argument; a value of the wrong shape is a `TypeError`.
pub fn arg<T: DeserializeOwned>(value: &Value) -> Result<T, String> {
    T::deserialize(Js(value)).map_err(|e| format!("TypeError: {e}"))
}

/// An optional structured argument: `undefined` and `null` are absent.
pub fn opt_arg<T: DeserializeOwned>(value: Option<&Value>) -> Result<Option<T>, String> {
    match value {
        Some(v) if !absent(v) => arg(v).map(Some),
        _ => Ok(None),
    }
}

/// `{"$undefined": true}`, JS `undefined` inside a structured value.
pub fn is_undefined(value: &Value) -> bool {
    marker(value, "$undefined") == Some(&Value::Bool(true))
}

fn absent(value: &Value) -> bool {
    value.is_null() || is_undefined(value)
}

fn marker<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.as_object().filter(|o| o.len() == 1)?.get(key)
}

fn number(value: &Value) -> Option<f64> {
    match marker(value, "$num")?.as_str()? {
        "NaN" => Some(f64::NAN),
        "Infinity" => Some(f64::INFINITY),
        "-Infinity" => Some(f64::NEG_INFINITY),
        "-0" => Some(-0.0),
        _ => None,
    }
}

fn utf16(value: &Value) -> Option<String> {
    let units: Option<Vec<u16>> = marker(value, "$utf16")?
        .as_array()?
        .iter()
        .map(|u| u.as_u64().and_then(|u| u16::try_from(u).ok()))
        .collect();
    units.map(|u| String::from_utf16_lossy(&u))
}

struct Js<'de>(&'de Value);

impl<'de> de::Deserializer<'de> for Js<'de> {
    type Error = serde_json::Error;

    fn deserialize_any<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Self::Error> {
        if let Some(n) = number(self.0) {
            return visitor.visit_f64(n);
        }
        if let Some(s) = utf16(self.0) {
            return visitor.visit_string(s);
        }
        if is_undefined(self.0) {
            return visitor.visit_unit();
        }
        match self.0 {
            Value::Array(items) => visitor.visit_seq(Seq(items.iter())),
            Value::Object(o) => visitor.visit_map(Fields {
                iter: o.iter(),
                value: None,
            }),
            other => de::Deserializer::deserialize_any(other, visitor),
        }
    }

    fn deserialize_option<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Self::Error> {
        if absent(self.0) {
            visitor.visit_none()
        } else {
            visitor.visit_some(self)
        }
    }

    fn deserialize_newtype_struct<V: Visitor<'de>>(
        self,
        _name: &'static str,
        visitor: V,
    ) -> Result<V::Value, Self::Error> {
        visitor.visit_newtype_struct(self)
    }

    fn deserialize_enum<V: Visitor<'de>>(
        self,
        name: &'static str,
        variants: &'static [&'static str],
        visitor: V,
    ) -> Result<V::Value, Self::Error> {
        de::Deserializer::deserialize_enum(self.0, name, variants, visitor)
    }

    serde::forward_to_deserialize_any! {
        bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 char str string bytes byte_buf
        unit unit_struct seq tuple tuple_struct map struct identifier ignored_any
    }
}

struct Seq<'de>(std::slice::Iter<'de, Value>);

impl<'de> SeqAccess<'de> for Seq<'de> {
    type Error = serde_json::Error;

    fn next_element_seed<T: DeserializeSeed<'de>>(
        &mut self,
        seed: T,
    ) -> Result<Option<T::Value>, Self::Error> {
        self.0.next().map(|v| seed.deserialize(Js(v))).transpose()
    }
}

struct Fields<'de> {
    iter: <&'de Map<String, Value> as IntoIterator>::IntoIter,
    value: Option<&'de Value>,
}

impl<'de> MapAccess<'de> for Fields<'de> {
    type Error = serde_json::Error;

    fn next_key_seed<K: DeserializeSeed<'de>>(
        &mut self,
        seed: K,
    ) -> Result<Option<K::Value>, Self::Error> {
        for (key, value) in self.iter.by_ref() {
            if !is_undefined(value) {
                self.value = Some(value);
                return seed
                    .deserialize(BorrowedStrDeserializer::new(key))
                    .map(Some);
            }
        }
        Ok(None)
    }

    fn next_value_seed<V: DeserializeSeed<'de>>(
        &mut self,
        seed: V,
    ) -> Result<V::Value, Self::Error> {
        match self.value.take() {
            Some(v) => seed.deserialize(Js(v)),
            None => Err(de::Error::custom("value missing")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use serde_json::json;

    #[derive(Debug, Deserialize, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct Window {
        used_percent: f64,
        resets_at: Option<String>,
        #[serde(default)]
        label: Option<String>,
    }

    #[test]
    fn markers_read_as_the_values_they_stand_for() {
        let w: Window = arg(&json!({
            "usedPercent": {"$num": "-Infinity"},
            "resetsAt": {"$undefined": true},
            "label": {"$utf16": [97, 0xD800]},
        }))
        .unwrap();
        assert_eq!(w.used_percent, f64::NEG_INFINITY);
        assert_eq!(w.resets_at, None);
        assert_eq!(w.label.as_deref(), Some("a\u{FFFD}"));
        let nan: Window = arg(&json!({"usedPercent": {"$num": "NaN"}, "resetsAt": null})).unwrap();
        assert!(nan.used_percent.is_nan());
        let zero: f64 = arg(&json!({"$num": "-0"})).unwrap();
        assert!(zero == 0.0 && zero.is_sign_negative());
    }

    #[test]
    fn undefined_and_null_are_absent() {
        assert_eq!(opt_arg::<Window>(None).unwrap(), None);
        assert_eq!(opt_arg::<Window>(Some(&json!(null))).unwrap(), None);
        assert_eq!(
            opt_arg::<Window>(Some(&json!({"$undefined": true}))).unwrap(),
            None
        );
        assert!(arg::<Window>(&json!({"resetsAt": "x"})).is_err());
        let list: Vec<Option<f64>> = arg(&json!([1, {"$undefined": true}, null])).unwrap();
        assert_eq!(list, vec![Some(1.0), None, None]);
    }
}
