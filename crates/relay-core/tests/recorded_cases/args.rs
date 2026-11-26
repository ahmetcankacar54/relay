//! Arguments as relay-core reads them: the JSON the bindings carry, markers included, deserialized
//! into the relay-core types.
//!
//! JS `undefined` members are dropped (a missing key to serde), and `{"$num": ...}` markers are
//! the numbers they stand for, so NaN, the infinities and `-0` reach `f64` fields as in the TS.

#![allow(dead_code)]

use serde::de::value::{MapDeserializer, SeqDeserializer};
use serde::de::{DeserializeOwned, IntoDeserializer, Visitor};
use serde::forward_to_deserialize_any;
use serde_json::Value;

/// The value as a JS read sees it: `undefined` members dropped, `-0` as a number (JSON holds it);
/// `None` for `undefined` itself.
pub fn plain(value: Value) -> Option<Value> {
    if crate::js::is_undefined(&value) {
        return None;
    }
    Some(match value {
        Value::Object(o) if o.len() == 1 && o.get("$num") == Some(&Value::from("-0")) => {
            Value::from(-0.0)
        }
        Value::Object(o) => o
            .into_iter()
            .filter_map(|(k, v)| plain(v).map(|v| (k, v)))
            .collect(),
        Value::Array(a) => a
            .into_iter()
            .map(|v| plain(v).unwrap_or(Value::Null))
            .collect(),
        v => v,
    })
}

/// A structured argument as the relay-core type the TS signature names.
pub fn arg<T: DeserializeOwned>(value: Value) -> Result<T, String> {
    T::deserialize(Js(plain(value).unwrap_or(Value::Null))).map_err(|e| format!("TypeError: {e}"))
}

/// An optional argument: `undefined` and `null` are absent.
pub fn opt_arg<T: DeserializeOwned>(value: Option<Value>) -> Result<Option<T>, String> {
    value.and_then(plain).map(arg).transpose()
}

/// A JSON value whose number markers deserialize as numbers.
struct Js(Value);

impl<'de> IntoDeserializer<'de, serde_json::Error> for Js {
    type Deserializer = Self;
    fn into_deserializer(self) -> Self {
        self
    }
}

impl<'de> serde::Deserializer<'de> for Js {
    type Error = serde_json::Error;

    fn deserialize_any<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Self::Error> {
        if let Some(n) = crate::js::as_number(&self.0).filter(|_| self.0.is_object()) {
            return visitor.visit_f64(n);
        }
        match self.0 {
            Value::Object(o) => {
                visitor.visit_map(MapDeserializer::new(o.into_iter().map(|(k, v)| (k, Js(v)))))
            }
            Value::Array(a) => visitor.visit_seq(SeqDeserializer::new(a.into_iter().map(Js))),
            other => other.deserialize_any(visitor),
        }
    }

    fn deserialize_option<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Self::Error> {
        match self.0 {
            Value::Null => visitor.visit_none(),
            _ => visitor.visit_some(self),
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
        self.0.deserialize_enum(name, variants, visitor)
    }

    forward_to_deserialize_any! {
        bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 char str string bytes byte_buf unit
        unit_struct seq tuple tuple_struct map struct identifier ignored_any
    }
}
