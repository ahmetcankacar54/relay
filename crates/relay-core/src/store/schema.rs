//! The zod 4 behaviors Relay's file schemas rely on, over `serde_json::Value`: shape-ordered
//! output with unknown keys stripped (or refused in strict objects), defaults for missing keys,
//! `.catch`, `.preprocess`, refinements, and issues in zod's order with their paths, so the
//! first issue's path names the same field the TS names.

use std::fmt;

use serde_json::{Map, Value};

/// One step of an issue's path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PathKey {
    Key(String),
    Index(usize),
}

impl fmt::Display for PathKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PathKey::Key(key) => f.write_str(key),
            PathKey::Index(index) => write!(f, "{index}"),
        }
    }
}

/// zod's issue codes, as far as these schemas raise them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IssueCode {
    InvalidType,
    InvalidValue,
    InvalidUnion,
    InvalidFormat,
    InvalidKey,
    TooSmall,
    TooBig,
    Custom,
    /// A strict object's (or an enum-keyed record's) keys it does not know.
    UnrecognizedKeys(Vec<String>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Issue {
    pub code: IssueCode,
    pub path: Vec<PathKey>,
    pub message: String,
    /// zod's `continue`: the value was still read, so later checks on it run.
    pub continues: bool,
}

/// A failed parse: zod's `ZodError`, issues in the order zod reports them.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{}", self.describe())]
pub struct SchemaError {
    pub issues: Vec<Issue>,
}

impl SchemaError {
    /// The first issue's path joined with `.` (`issues[0].path.join(".")`); empty at the root.
    pub fn path(&self) -> Option<String> {
        let issue = self.issues.first()?;
        Some(
            issue
                .path
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join("."),
        )
    }

    fn describe(&self) -> String {
        match self.issues.first() {
            Some(issue) if issue.path.is_empty() => issue.message.clone(),
            Some(issue) => format!("{} (at {})", issue.message, self.path().unwrap_or_default()),
            None => "Invalid input".into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    /// `z.uuid()`.
    Uuid,
    /// `z.iso.datetime()`: `Z` only, seconds required, any fraction.
    Datetime,
}

#[derive(Debug, Clone, Default)]
pub struct StringRule {
    pub trim: bool,
    /// Lengths in UTF-16 code units, as JavaScript counts them.
    pub min: Option<usize>,
    pub max: Option<usize>,
    pub format: Option<Format>,
    /// `.regex(...)`.
    pub pattern: Option<fn(&str) -> bool>,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct NumberRule {
    pub int: bool,
    pub min: Option<f64>,
    pub max: Option<f64>,
}

type Refinement = fn(&Value) -> bool;

/// A schema; build them with the functions below.
#[derive(Clone)]
pub enum Schema {
    Unknown,
    Bool,
    Number(NumberRule),
    String(StringRule),
    Literal(Value),
    Enum(Vec<String>),
    Union(Vec<Schema>),
    Array {
        item: Box<Schema>,
        max: Option<usize>,
    },
    Object {
        fields: Vec<(String, Schema)>,
        strict: bool,
    },
    /// `z.record(key, value)`; with `enum_keys`, `z.partialRecord(z.enum(...), value)`.
    Record {
        key: Box<Schema>,
        value: Box<Schema>,
        enum_keys: bool,
    },
    Optional(Box<Schema>),
    Default(Box<Schema>, fn() -> Value),
    /// `.catch(undefined)`.
    Catch(Box<Schema>),
    Preprocess(fn(&Value) -> Value, Box<Schema>),
    Refine(Box<Schema>, Refinement, &'static str),
}

pub fn unknown() -> Schema {
    Schema::Unknown
}
pub fn boolean() -> Schema {
    Schema::Bool
}
pub fn number(rule: NumberRule) -> Schema {
    Schema::Number(rule)
}
pub fn string(rule: StringRule) -> Schema {
    Schema::String(rule)
}
pub fn any_string() -> Schema {
    Schema::String(StringRule::default())
}
pub fn uuid() -> Schema {
    string(StringRule {
        format: Some(Format::Uuid),
        ..Default::default()
    })
}
pub fn datetime() -> Schema {
    string(StringRule {
        format: Some(Format::Datetime),
        ..Default::default()
    })
}
pub fn literal(value: Value) -> Schema {
    Schema::Literal(value)
}
pub fn enumeration<S: AsRef<str>>(values: impl IntoIterator<Item = S>) -> Schema {
    Schema::Enum(values.into_iter().map(|v| v.as_ref().to_string()).collect())
}
pub fn union(options: Vec<Schema>) -> Schema {
    Schema::Union(options)
}
pub fn array(item: Schema, max: Option<usize>) -> Schema {
    Schema::Array {
        item: Box::new(item),
        max,
    }
}
/// `z.object(...)`: unknown keys are dropped.
pub fn object(fields: Vec<(&str, Schema)>) -> Schema {
    Schema::Object {
        fields: fields
            .into_iter()
            .map(|(k, s)| (k.to_string(), s))
            .collect(),
        strict: false,
    }
}
/// `z.object(...).strict()`: unknown keys are refused.
pub fn strict(fields: Vec<(&str, Schema)>) -> Schema {
    Schema::Object {
        fields: fields
            .into_iter()
            .map(|(k, s)| (k.to_string(), s))
            .collect(),
        strict: true,
    }
}
pub fn record(key: Schema, value: Schema) -> Schema {
    Schema::Record {
        key: Box::new(key),
        value: Box::new(value),
        enum_keys: false,
    }
}
pub fn partial_record(keys: Schema, value: Schema) -> Schema {
    Schema::Record {
        key: Box::new(keys),
        value: Box::new(value),
        enum_keys: true,
    }
}

impl Schema {
    pub fn optional(self) -> Schema {
        Schema::Optional(Box::new(self))
    }
    pub fn default_to(self, value: fn() -> Value) -> Schema {
        Schema::Default(Box::new(self), value)
    }
    pub fn catch_undefined(self) -> Schema {
        Schema::Catch(Box::new(self))
    }
    pub fn refine(self, check: Refinement, message: &'static str) -> Schema {
        Schema::Refine(Box::new(self), check, message)
    }
    pub fn preprocess(self, step: fn(&Value) -> Value) -> Schema {
        Schema::Preprocess(step, Box::new(self))
    }
    /// The inner schema of `.default()`, as `.removeDefault()` gives it.
    pub fn remove_default(self) -> Schema {
        match self {
            Schema::Default(inner, _) => *inner,
            other => other,
        }
    }

    /// `.partial()` on an object: every field optional.
    pub fn partial(self) -> Schema {
        match self {
            Schema::Object { fields, strict } => Schema::Object {
                fields: fields
                    .into_iter()
                    .map(|(k, s)| match s {
                        Schema::Optional(_) => (k, s),
                        other => (k, other.optional()),
                    })
                    .collect(),
                strict,
            },
            other => other,
        }
    }

    /// An object's field schema (`schema.shape[key]`).
    pub fn field(&self, key: &str) -> Option<&Schema> {
        match self {
            Schema::Object { fields, .. } => fields.iter().find(|(k, _)| k == key).map(|(_, s)| s),
            Schema::Refine(inner, ..) | Schema::Preprocess(_, inner) => inner.field(key),
            _ => None,
        }
    }

    /// `.extend({...})` (a known key is replaced in its place, a new one appended) and
    /// `.omit({...})` on an object.
    pub fn extend_omit(self, replace: Vec<(&str, Schema)>, omit: &[&str]) -> Schema {
        match self {
            Schema::Object { mut fields, strict } => {
                for (key, schema) in replace {
                    match fields.iter_mut().find(|(k, _)| k == key) {
                        Some(slot) => slot.1 = schema,
                        None => fields.push((key.to_string(), schema)),
                    }
                }
                fields.retain(|(k, _)| !omit.contains(&k.as_str()));
                Schema::Object { fields, strict }
            }
            other => other,
        }
    }

    /// `schema.parse(value)`: the output value, or every issue.
    pub fn parse(&self, value: &Value) -> Result<Value, SchemaError> {
        let mut issues = Vec::new();
        let out = self.run(Some(value), &mut Vec::new(), &mut issues);
        if issues.is_empty() {
            Ok(out.unwrap_or(Value::Null))
        } else {
            Err(SchemaError { issues })
        }
    }

    /// `safeParse(value).success`.
    pub fn accepts(&self, value: &Value) -> bool {
        self.parse(value).is_ok()
    }

    fn optional_in(&self) -> bool {
        match self {
            Schema::Optional(_) => true,
            Schema::Catch(inner) | Schema::Refine(inner, ..) => inner.optional_in(),
            _ => false,
        }
    }

    fn run(
        &self,
        input: Option<&Value>,
        path: &mut Vec<PathKey>,
        issues: &mut Vec<Issue>,
    ) -> Option<Value> {
        let start = issues.len();
        match self {
            Schema::Optional(inner) => input.and_then(|v| inner.run(Some(v), path, issues)),
            Schema::Default(inner, make) => match input {
                None => Some(make()),
                Some(v) => inner.run(Some(v), path, issues),
            },
            Schema::Catch(inner) => {
                let mut own = Vec::new();
                let out = inner.run(input, path, &mut own);
                if own.is_empty() { out } else { None }
            }
            Schema::Preprocess(step, inner) => {
                let value = input.map(step);
                inner.run(value.as_ref(), path, issues)
            }
            Schema::Refine(inner, check, message) => {
                let out = inner.run(input, path, issues);
                let aborted = issues[start..].iter().any(|i| !i.continues);
                if !aborted
                    && let Some(value) = &out
                    && !check(value)
                {
                    push(issues, path, IssueCode::Custom, message, false);
                }
                out
            }
            _ => {
                let Some(value) = input else {
                    push(
                        issues,
                        path,
                        IssueCode::InvalidType,
                        &format!(
                            "Invalid input: expected {}, received undefined",
                            self.expected()
                        ),
                        false,
                    );
                    return None;
                };
                self.run_value(value, path, issues)
            }
        }
    }

    fn expected(&self) -> &'static str {
        match self {
            Schema::Bool => "boolean",
            Schema::Number(_) => "number",
            Schema::String(_) => "string",
            Schema::Array { .. } => "array",
            Schema::Object { .. } => "object",
            Schema::Record { .. } => "record",
            _ => "nonoptional",
        }
    }

    fn run_value(
        &self,
        value: &Value,
        path: &mut Vec<PathKey>,
        issues: &mut Vec<Issue>,
    ) -> Option<Value> {
        let invalid_type = |issues: &mut Vec<Issue>, path: &[PathKey]| {
            push(
                issues,
                path,
                IssueCode::InvalidType,
                &format!("Invalid input: expected {}", self.expected()),
                false,
            );
            None
        };
        match self {
            Schema::Unknown => Some(value.clone()),
            Schema::Bool => match value {
                Value::Bool(_) => Some(value.clone()),
                _ => invalid_type(issues, path),
            },
            Schema::Number(rule) => {
                let Some(n) = value.as_f64().filter(|n| n.is_finite()) else {
                    return invalid_type(issues, path);
                };
                if rule.int {
                    if n.fract() != 0.0 {
                        push(
                            issues,
                            path,
                            IssueCode::InvalidType,
                            "Invalid input: expected int, received number",
                            false,
                        );
                        return None;
                    }
                    const SAFE: f64 = 9_007_199_254_740_991.0;
                    if n > SAFE {
                        push(
                            issues,
                            path,
                            IssueCode::TooBig,
                            "Too big: expected int to be <= 9007199254740991",
                            true,
                        );
                    } else if n < -SAFE {
                        push(
                            issues,
                            path,
                            IssueCode::TooSmall,
                            "Too small: expected int to be >= -9007199254740991",
                            true,
                        );
                    }
                }
                if let Some(min) = rule.min
                    && n < min
                {
                    push(
                        issues,
                        path,
                        IssueCode::TooSmall,
                        &format!("Too small: expected number to be >={min}"),
                        true,
                    );
                }
                if let Some(max) = rule.max
                    && n > max
                {
                    push(
                        issues,
                        path,
                        IssueCode::TooBig,
                        &format!("Too big: expected number to be <={max}"),
                        true,
                    );
                }
                Some(js_number(n))
            }
            Schema::String(rule) => {
                let Some(text) = value.as_str() else {
                    return invalid_type(issues, path);
                };
                let text = if rule.trim { js_trim(text) } else { text };
                let length = text.encode_utf16().count();
                if let Some(min) = rule.min
                    && length < min
                {
                    push(
                        issues,
                        path,
                        IssueCode::TooSmall,
                        &format!("Too small: expected string to have >={min} characters"),
                        true,
                    );
                }
                if let Some(max) = rule.max
                    && length > max
                {
                    push(
                        issues,
                        path,
                        IssueCode::TooBig,
                        &format!("Too big: expected string to have <={max} characters"),
                        true,
                    );
                }
                let format_ok = match rule.format {
                    None => true,
                    Some(Format::Uuid) => crate::desktop_files::is_uuid(text),
                    Some(Format::Datetime) => is_iso_datetime(text),
                };
                if !format_ok {
                    let what = match rule.format {
                        Some(Format::Uuid) => "UUID",
                        _ => "ISO datetime",
                    };
                    push(
                        issues,
                        path,
                        IssueCode::InvalidFormat,
                        &format!("Invalid {what}"),
                        true,
                    );
                }
                if let Some(pattern) = rule.pattern
                    && !pattern(text)
                {
                    push(
                        issues,
                        path,
                        IssueCode::InvalidFormat,
                        "Invalid string: must match pattern",
                        true,
                    );
                }
                Some(Value::String(text.to_string()))
            }
            Schema::Literal(expected) => {
                if same_value(value, expected) {
                    Some(value.clone())
                } else {
                    push(
                        issues,
                        path,
                        IssueCode::InvalidValue,
                        &format!("Invalid input: expected {expected}"),
                        false,
                    );
                    None
                }
            }
            Schema::Enum(values) => match value.as_str() {
                Some(text) if values.iter().any(|v| v == text) => Some(value.clone()),
                _ => {
                    let list = values
                        .iter()
                        .map(|v| format!("\"{v}\""))
                        .collect::<Vec<_>>()
                        .join("|");
                    push(
                        issues,
                        path,
                        IssueCode::InvalidValue,
                        &format!("Invalid option: expected one of {list}"),
                        false,
                    );
                    None
                }
            },
            Schema::Union(options) => {
                for option in options {
                    let mut own = Vec::new();
                    let out = option.run(Some(value), path, &mut own);
                    if own.is_empty() {
                        return out;
                    }
                }
                push(
                    issues,
                    path,
                    IssueCode::InvalidUnion,
                    "Invalid input",
                    false,
                );
                None
            }
            Schema::Array { item, max } => {
                let Some(items) = value.as_array() else {
                    return invalid_type(issues, path);
                };
                let mut out = Vec::with_capacity(items.len());
                for (index, element) in items.iter().enumerate() {
                    path.push(PathKey::Index(index));
                    // An element zod reads as undefined is kept as null, as JSON.stringify writes it.
                    out.push(item.run(Some(element), path, issues).unwrap_or(Value::Null));
                    path.pop();
                }
                if let Some(max) = max
                    && items.len() > *max
                {
                    push(
                        issues,
                        path,
                        IssueCode::TooBig,
                        &format!("Too big: expected array to have <={max} items"),
                        true,
                    );
                }
                Some(Value::Array(out))
            }
            Schema::Object { fields, strict } => {
                let Some(map) = value.as_object() else {
                    return invalid_type(issues, path);
                };
                let mut out = Map::new();
                for (key, schema) in fields {
                    let present = map.get(key);
                    if present.is_none() && schema.optional_in() {
                        continue;
                    }
                    path.push(PathKey::Key(key.clone()));
                    let result = schema.run(present, path, issues);
                    path.pop();
                    if let Some(result) = result {
                        out.insert(key.clone(), result);
                    }
                }
                if *strict {
                    let unknown: Vec<String> = map
                        .keys()
                        .filter(|k| !fields.iter().any(|(f, _)| f == *k))
                        .cloned()
                        .collect();
                    if !unknown.is_empty() {
                        let message = format!(
                            "Unrecognized key{}: {}",
                            if unknown.len() == 1 { "" } else { "s" },
                            unknown
                                .iter()
                                .map(|k| format!("\"{k}\""))
                                .collect::<Vec<_>>()
                                .join(", ")
                        );
                        push(
                            issues,
                            path,
                            IssueCode::UnrecognizedKeys(unknown),
                            &message,
                            true,
                        );
                    }
                }
                Some(Value::Object(out))
            }
            Schema::Record {
                key,
                value: item,
                enum_keys,
            } => {
                let Some(map) = value.as_object() else {
                    return invalid_type(issues, path);
                };
                let mut out = Map::new();
                let mut unknown = Vec::new();
                for (name, element) in map {
                    let mut own = Vec::new();
                    let parsed = key.run(
                        Some(&Value::String(name.clone())),
                        &mut Vec::new(),
                        &mut own,
                    );
                    if !own.is_empty() {
                        if *enum_keys {
                            unknown.push(name.clone());
                        } else {
                            path.push(PathKey::Key(name.clone()));
                            push(
                                issues,
                                path,
                                IssueCode::InvalidKey,
                                "Invalid key in record",
                                false,
                            );
                            path.pop();
                        }
                        continue;
                    }
                    let out_key = parsed
                        .and_then(|k| k.as_str().map(str::to_string))
                        .unwrap_or_else(|| name.clone());
                    path.push(PathKey::Key(name.clone()));
                    let result = item.run(Some(element), path, issues);
                    path.pop();
                    out.insert(out_key, result.unwrap_or(Value::Null));
                }
                if !unknown.is_empty() {
                    let message = format!("Unrecognized keys: {}", unknown.join(", "));
                    push(
                        issues,
                        path,
                        IssueCode::UnrecognizedKeys(unknown),
                        &message,
                        true,
                    );
                }
                Some(Value::Object(out))
            }
            Schema::Optional(_)
            | Schema::Default(..)
            | Schema::Catch(_)
            | Schema::Preprocess(..)
            | Schema::Refine(..) => self.run(Some(value), path, issues),
        }
    }
}

fn push(
    issues: &mut Vec<Issue>,
    path: &[PathKey],
    code: IssueCode,
    message: &str,
    continues: bool,
) {
    issues.push(Issue {
        code,
        path: path.to_vec(),
        message: message.to_string(),
        continues,
    });
}

/// `Object.is`-like equality for literals: numbers by value.
fn same_value(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        _ => a == b,
    }
}

/// A JavaScript number as JSON: an integer without a fraction (`5`, not `5.0`).
pub fn js_number(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0 {
        Value::from(n as i64)
    } else {
        serde_json::Number::from_f64(n)
            .map(Value::Number)
            .unwrap_or(Value::Null)
    }
}

/// `String.prototype.trim`: JavaScript's white space (any `Zs`, tab, VT, FF, BOM) and line
/// terminators; U+0085 stays, as in JavaScript.
pub fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| c != '\u{85}' && (c.is_whitespace() || c == '\u{feff}'))
}

/// zod 4's `z.iso.datetime()`: `YYYY-MM-DDTHH:mm:ss(.f+)?Z` with real calendar dates.
pub fn is_iso_datetime(text: &str) -> bool {
    let b = text.as_bytes();
    if b.len() < 20 || b[b.len() - 1] != b'Z' || b[10] != b'T' {
        return false;
    }
    let digits = |range: std::ops::Range<usize>| b[range].iter().all(u8::is_ascii_digit);
    if !(digits(0..4) && b[4] == b'-' && digits(5..7) && b[7] == b'-' && digits(8..10)) {
        return false;
    }
    let num = |range: std::ops::Range<usize>| {
        b[range]
            .iter()
            .fold(0u32, |n, d| n * 10 + u32::from(d - b'0'))
    };
    let (year, month, day) = (num(0..4), num(5..7), num(8..10));
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    if day == 0 || day > days {
        return false;
    }
    let time = &b[11..b.len() - 1];
    if time.len() < 8 || time[2] != b':' || time[5] != b':' {
        return false;
    }
    let hour_ok = matches!(
        (time[0], time[1]),
        (b'0' | b'1', b'0'..=b'9') | (b'2', b'0'..=b'3')
    );
    let minute_ok = matches!(time[3], b'0'..=b'5') && time[4].is_ascii_digit();
    let second_ok = matches!(time[6], b'0'..=b'5') && time[7].is_ascii_digit();
    let fraction = &time[8..];
    let fraction_ok = fraction.is_empty()
        || (fraction[0] == b'.'
            && fraction.len() > 1
            && fraction[1..].iter().all(u8::is_ascii_digit));
    hour_ok && minute_ok && second_ok && fraction_ok
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn datetimes_as_zod_reads_them() {
        assert!(is_iso_datetime("2026-02-28T10:00:00Z"));
        assert!(is_iso_datetime("2024-02-29T10:00:00.123Z"));
        assert!(!is_iso_datetime("2026-02-29T10:00:00Z"));
        assert!(!is_iso_datetime("2026-02-28T10:00Z"));
        assert!(!is_iso_datetime("2026-02-28T10:00:00+01:00"));
        assert!(!is_iso_datetime("2026-02-28T24:00:00Z"));
    }

    #[test]
    fn first_issue_paths_follow_the_shape() {
        let schema = strict(vec![
            ("a", boolean()),
            ("b", array(object(vec![("c", uuid())]), None)),
        ]);
        let error = schema
            .parse(&json!({"b": [{"c": "x"}], "z": 1}))
            .unwrap_err();
        assert_eq!(error.path().as_deref(), Some("a"));
        assert_eq!(error.issues.len(), 3);
        assert_eq!(
            error.issues[1].path,
            vec![
                PathKey::Key("b".into()),
                PathKey::Index(0),
                PathKey::Key("c".into())
            ]
        );
        assert_eq!(
            error.issues[2].code,
            IssueCode::UnrecognizedKeys(vec!["z".into()])
        );
    }
}
