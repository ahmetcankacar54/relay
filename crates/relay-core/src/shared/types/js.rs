//! The JavaScript behaviors the shared modules' outputs depend on: `Date.parse`, `toISOString`,
//! `Math.round`, `String(number)`, `Array.prototype.sort`, plain-object key order, and numbers
//! written the way `JSON.stringify` writes them (`3`, not `3.0`).

use chrono::{Local, NaiveDate, TimeZone, Utc};
use indexmap::IndexMap;
use serde::de::{Deserialize, Deserializer, MapAccess, Visitor};
use serde::ser::{Serialize, SerializeMap, Serializer};
use std::fmt;

const DAY_MS: f64 = 86_400_000.0;
/// The largest time value a `Date` holds: ±8.64e15 ms.
const MAX_TIME: f64 = 8.64e15;

/// `Date.parse(text)`: `NaN` where JavaScript answers `NaN`. Reads V8's ISO forms (a bare date
/// or year-month is UTC, a date-time without an offset local time, `T` or a space between,
/// `Z` or `±HH:mm`/`±HHmm`, any number of fraction digits, days up to 31 rolling over, `24:00`)
/// and RFC 2822 dates.
pub fn date_parse(text: &str) -> f64 {
    parse_iso(text)
        .or_else(|| {
            chrono::DateTime::parse_from_rfc2822(text)
                .ok()
                .map(|at| at.timestamp_millis() as f64)
        })
        .filter(|ms| ms.abs() <= MAX_TIME)
        .unwrap_or(f64::NAN)
}

fn digits(bytes: &[u8], at: &mut usize, count: usize) -> Option<i64> {
    let slice = bytes.get(*at..*at + count)?;
    if !slice.iter().all(u8::is_ascii_digit) {
        return None;
    }
    *at += count;
    Some(slice.iter().fold(0, |n, b| n * 10 + i64::from(b - b'0')))
}

fn parse_iso(text: &str) -> Option<f64> {
    let b = text.as_bytes();
    let mut at = 0;
    let year = match b.first()? {
        b'+' | b'-' => {
            let negative = b[0] == b'-';
            at = 1;
            let y = digits(b, &mut at, 6)?;
            if negative && y == 0 {
                return None;
            }
            if negative { -y } else { y }
        }
        _ => digits(b, &mut at, 4)?,
    };
    let (mut month, mut day) = (1, 1);
    if b.get(at) == Some(&b'-') {
        at += 1;
        month = digits(b, &mut at, 2)?;
        if b.get(at) == Some(&b'-') {
            at += 1;
            day = digits(b, &mut at, 2)?;
        }
    }
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let date = NaiveDate::from_ymd_opt(year as i32, month as u32, 1)?;
    let days =
        date.and_hms_opt(0, 0, 0)?.and_utc().timestamp_millis() as f64 / DAY_MS + (day - 1) as f64;
    if at == b.len() {
        return Some(days * DAY_MS);
    }
    if !matches!(b[at], b'T' | b't' | b' ') {
        return None;
    }
    at += 1;
    let hour = digits(b, &mut at, 2)?;
    if b.get(at) != Some(&b':') {
        return None;
    }
    at += 1;
    let minute = digits(b, &mut at, 2)?;
    let (mut second, mut millis) = (0, 0.0);
    if b.get(at) == Some(&b':') {
        at += 1;
        second = digits(b, &mut at, 2)?;
        if b.get(at) == Some(&b'.') {
            at += 1;
            let start = at;
            while b.get(at).is_some_and(u8::is_ascii_digit) {
                at += 1;
            }
            if at == start {
                return None;
            }
            let frac = &text[start..at.min(start + 3)];
            millis = format!("{frac:0<3}").parse::<f64>().ok()?;
        }
    }
    if hour > 24
        || minute > 59
        || second > 59
        || (hour == 24 && (minute > 0 || second > 0 || millis > 0.0))
    {
        return None;
    }
    let clock = ((hour * 60 + minute) * 60 + second) as f64 * 1000.0 + millis;
    let offset = match b.get(at) {
        None => None,
        Some(b'Z' | b'z') => {
            at += 1;
            Some(0.0)
        }
        Some(sign @ (b'+' | b'-')) => {
            let sign = if *sign == b'-' { -1.0 } else { 1.0 };
            at += 1;
            let h = digits(b, &mut at, 2)?;
            if b.get(at) == Some(&b':') {
                at += 1;
            }
            let m = digits(b, &mut at, 2)?;
            if h > 23 || m > 59 {
                return None;
            }
            Some(sign * ((h * 60 + m) as f64) * 60_000.0)
        }
        _ => return None,
    };
    if at != b.len() {
        return None;
    }
    let nominal = days * DAY_MS + clock;
    match offset {
        Some(offset) => Some(nominal - offset),
        None => Some(local_to_utc(nominal)),
    }
}

/// A wall time read as the machine's local time (the earlier instant when it repeats, the
/// later offset when it is skipped, as V8 does).
fn local_to_utc(nominal: f64) -> f64 {
    let naive = Utc
        .timestamp_millis_opt(nominal as i64)
        .single()
        .map(|at| at.naive_utc());
    let Some(naive) = naive else { return f64::NAN };
    match Local.from_local_datetime(&naive) {
        chrono::LocalResult::Single(at) | chrono::LocalResult::Ambiguous(at, _) => {
            at.timestamp_millis() as f64
        }
        chrono::LocalResult::None => {
            // Skipped by a DST change: V8 applies the offset from before the gap.
            let before = Local.offset_from_utc_datetime(&(naive - chrono::Duration::hours(3)));
            nominal - f64::from(chrono::Offset::fix(&before).local_minus_utc()) * 1000.0
        }
    }
}

/// `new Date(ms).toISOString()`: `2026-11-13T15:00:00.000Z`; `""` for an invalid time (where
/// JavaScript throws).
pub fn iso(ms: f64) -> String {
    if !ms.is_finite() || ms.abs() > MAX_TIME {
        return String::new();
    }
    let ms = ms.trunc() as i64;
    let Some(at) = Utc.timestamp_millis_opt(ms).single() else {
        return String::new();
    };
    use chrono::{Datelike, Timelike};
    let year = at.year();
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else if year < 0 {
        format!("-{:06}", -year)
    } else {
        format!("+{year:06}")
    };
    format!(
        "{year}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        at.month(),
        at.day(),
        at.hour(),
        at.minute(),
        at.second(),
        at.timestamp_subsec_millis()
    )
}

/// `new Date(text).toISOString()` when `text` parses, else `None` (where JavaScript throws).
pub fn normalize_iso(text: &str) -> Option<String> {
    let ms = date_parse(text);
    ms.is_finite().then(|| iso(ms))
}

/// `String.prototype.trim`: JavaScript's white space (Zs, tab, VT, FF, BOM) and line
/// terminators. Unlike `char::is_whitespace`, U+0085 is not one of them.
pub fn trim(text: &str) -> &str {
    text.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
}

/// `Number(text)`: surrounding white space ignored, empty is 0, `0x`/`0o`/`0b` literals and
/// `Infinity` read, anything else that is not a decimal literal `NaN`.
pub fn number_value(text: &str) -> f64 {
    let t = trim(text);
    if t.is_empty() {
        return 0.0;
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(digits) = t.strip_prefix(prefix) {
            // Digits only: no sign, no separator, at least one.
            if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
                return f64::NAN;
            }
            return u128::from_str_radix(digits, radix).map_or_else(
                |_| {
                    digits.chars().fold(0.0, |n, c| {
                        n * f64::from(radix) + f64::from(c.to_digit(radix).unwrap_or(0))
                    })
                },
                |v| v as f64,
            );
        }
    }
    // Rust also reads "inf", "nan" and "infinity", which JavaScript does not.
    if !t
        .bytes()
        .all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'e' | b'E' | b'+' | b'-'))
    {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// `Math.round`: halves go toward +∞.
pub fn round(value: f64) -> f64 {
    if !value.is_finite() {
        return value;
    }
    let floor = value.floor();
    // A value in [-0.5, 0) rounds to -0, as in JavaScript.
    if value - floor >= 0.5 {
        (floor + 1.0).copysign(value)
    } else {
        floor
    }
}

/// `Math.min(...values)`: `Infinity` for none, `NaN` when any is.
pub fn min(values: impl IntoIterator<Item = f64>) -> f64 {
    let mut out = f64::INFINITY;
    for v in values {
        if v.is_nan() {
            return f64::NAN;
        }
        if v < out || (v == 0.0 && out == 0.0 && v.is_sign_negative()) {
            out = v;
        }
    }
    out
}

/// `Math.max(...values)`: `-Infinity` for none, `NaN` when any is.
pub fn max(values: impl IntoIterator<Item = f64>) -> f64 {
    let mut out = f64::NEG_INFINITY;
    for v in values {
        if v.is_nan() {
            return f64::NAN;
        }
        if v > out || (v == 0.0 && out == 0.0 && out.is_sign_negative()) {
            out = v;
        }
    }
    out
}

/// `String(number)`.
pub fn number_string(value: f64) -> String {
    if value.is_nan() {
        return "NaN".into();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    if value == 0.0 {
        return "0".into();
    }
    let sign = if value < 0.0 { "-" } else { "" };
    let text = format!("{:e}", value.abs());
    let (mantissa, exponent) = text.split_once('e').unwrap_or((&text, "0"));
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let k = digits.len() as i32;
    let n = exponent.parse::<i32>().unwrap_or(0) + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let e = if e >= 0 {
            format!("+{e}")
        } else {
            e.to_string()
        };
        if k == 1 {
            format!("{digits}e{e}")
        } else {
            format!("{}.{}e{e}", &digits[..1], &digits[1..])
        }
    };
    format!("{sign}{body}")
}

/// `Array.prototype.sort(compare)`: stable, and an element moves before an earlier one only
/// when `compare` says it is less (a `NaN` result keeps the order).
pub fn sort_by<T>(items: &mut Vec<T>, mut compare: impl FnMut(&T, &T) -> f64) {
    if items.len() < 2 {
        return;
    }
    let mut taken: Vec<Option<T>> = std::mem::take(items).into_iter().map(Some).collect();
    let order: Vec<usize> = {
        let mut idx: Vec<usize> = (0..taken.len()).collect();
        merge_sort(&mut idx, &mut |a, b| {
            compare(
                taken[*a].as_ref().expect("present"),
                taken[*b].as_ref().expect("present"),
            )
        });
        idx
    };
    *items = order
        .into_iter()
        .map(|i| taken[i].take().expect("each index once"))
        .collect();
}

fn merge_sort(items: &mut [usize], compare: &mut impl FnMut(&usize, &usize) -> f64) {
    let len = items.len();
    if len < 2 {
        return;
    }
    let mid = len / 2;
    merge_sort(&mut items[..mid], compare);
    merge_sort(&mut items[mid..], compare);
    let mut out = Vec::with_capacity(len);
    let (mut i, mut j) = (0, mid);
    while i < mid && j < len {
        if compare(&items[j], &items[i]) < 0.0 {
            out.push(items[j]);
            j += 1;
        } else {
            out.push(items[i]);
            i += 1;
        }
    }
    out.extend_from_slice(&items[i..mid]);
    out.extend_from_slice(&items[j..]);
    items.copy_from_slice(&out);
}

/// `a < b ? -1 : a > b ? 1 : 0` for strings, by UTF-16 code units as JavaScript compares them.
pub fn compare_str(a: &str, b: &str) -> f64 {
    match a.encode_utf16().cmp(b.encode_utf16()) {
        std::cmp::Ordering::Less => -1.0,
        std::cmp::Ordering::Equal => 0.0,
        std::cmp::Ordering::Greater => 1.0,
    }
}

/// A finite number with no fraction that JSON can carry as an integer.
fn integral(value: f64) -> Option<i128> {
    (value.is_finite() && value.fract() == 0.0 && value.abs() < 1e21).then_some(value as i128)
}

/// Serializes an `f64` as `JSON.stringify` does: integers without `.0`, `NaN`/`Infinity` as `null`.
/// (An integer past `u64` is written as a float: serde_json has no wider integer.)
pub fn ser_num<S: Serializer>(value: &f64, serializer: S) -> Result<S::Ok, S::Error> {
    match integral(*value) {
        Some(i) => match (i64::try_from(i), u64::try_from(i)) {
            (Ok(i), _) => serializer.serialize_i64(i),
            (_, Ok(u)) => serializer.serialize_u64(u),
            _ => serializer.serialize_f64(*value),
        },
        None if !value.is_finite() => serializer.serialize_unit(),
        None => serializer.serialize_f64(*value),
    }
}

/// [`ser_num`] for an optional number (with `skip_serializing_if = "Option::is_none"`).
pub fn ser_opt_num<S: Serializer>(value: &Option<f64>, serializer: S) -> Result<S::Ok, S::Error> {
    match value {
        Some(v) => ser_num(v, serializer),
        None => serializer.serialize_none(),
    }
}

/// [`ser_num`] for a list of numbers.
pub fn ser_nums<S: Serializer>(values: &[f64], serializer: S) -> Result<S::Ok, S::Error> {
    serializer.collect_seq(values.iter().map(|v| Num(*v)))
}

/// An `f64` that serializes as [`ser_num`] does.
#[derive(Debug, Clone, Copy, PartialEq, PartialOrd, Default)]
pub struct Num(pub f64);

impl Serialize for Num {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        ser_num(&self.0, serializer)
    }
}

impl<'de> Deserialize<'de> for Num {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        f64::deserialize(deserializer).map(Num)
    }
}

/// Whether `key` is an array index, which a plain object lists first in ascending order.
fn array_index(key: &str) -> Option<u32> {
    if key.is_empty()
        || (key.len() > 1 && key.starts_with('0'))
        || !key.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    key.parse::<u32>().ok().filter(|n| *n != u32::MAX)
}

/// A plain JavaScript object used as a record (`Record<string, V>`): array-index keys come first
/// in ascending order, the rest in insertion order, as `Object.keys` and `JSON.stringify` list them.
#[derive(Clone, PartialEq)]
pub struct JsMap<V>(IndexMap<String, V>);

impl<V> Default for JsMap<V> {
    fn default() -> Self {
        JsMap(IndexMap::new())
    }
}

impl<V: fmt::Debug> fmt::Debug for JsMap<V> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_map().entries(self.0.iter()).finish()
    }
}

impl<V> JsMap<V> {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn len(&self) -> usize {
        self.0.len()
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    pub fn get(&self, key: &str) -> Option<&V> {
        self.0.get(key)
    }
    pub fn get_mut(&mut self, key: &str) -> Option<&mut V> {
        self.0.get_mut(key)
    }
    pub fn contains_key(&self, key: &str) -> bool {
        self.0.contains_key(key)
    }
    /// `obj[key] = value`: an existing key keeps its place.
    pub fn insert(&mut self, key: impl Into<String>, value: V) -> Option<V> {
        let key = key.into();
        if let Some(slot) = self.0.get_mut(&key) {
            return Some(std::mem::replace(slot, value));
        }
        match array_index(&key) {
            Some(n) => {
                let at = self
                    .0
                    .keys()
                    .position(|k| array_index(k).is_none_or(|m| m > n))
                    .unwrap_or(self.0.len());
                self.0.shift_insert(at, key, value);
            }
            None => {
                self.0.insert(key, value);
            }
        }
        None
    }
    /// `obj[key] ??= make()`.
    pub fn entry_or_insert_with(&mut self, key: &str, make: impl FnOnce() -> V) -> &mut V {
        if !self.0.contains_key(key) {
            self.insert(key.to_string(), make());
        }
        self.0.get_mut(key).expect("just inserted")
    }
    /// `delete obj[key]`: the others keep their order.
    pub fn remove(&mut self, key: &str) -> Option<V> {
        self.0.shift_remove(key)
    }
    pub fn keys(&self) -> impl Iterator<Item = &String> {
        self.0.keys()
    }
    pub fn values(&self) -> impl Iterator<Item = &V> {
        self.0.values()
    }
    pub fn values_mut(&mut self) -> impl Iterator<Item = &mut V> {
        self.0.values_mut()
    }
    pub fn iter(&self) -> impl Iterator<Item = (&String, &V)> {
        self.0.iter()
    }
    pub fn iter_mut(&mut self) -> impl Iterator<Item = (&String, &mut V)> {
        self.0.iter_mut()
    }
    pub fn retain(&mut self, keep: impl FnMut(&String, &mut V) -> bool) {
        self.0.retain(keep);
    }
}

impl<V> FromIterator<(String, V)> for JsMap<V> {
    fn from_iter<I: IntoIterator<Item = (String, V)>>(iter: I) -> Self {
        let mut map = JsMap::new();
        for (k, v) in iter {
            map.insert(k, v);
        }
        map
    }
}

impl<'a, V> IntoIterator for &'a JsMap<V> {
    type Item = (&'a String, &'a V);
    type IntoIter = indexmap::map::Iter<'a, String, V>;
    fn into_iter(self) -> Self::IntoIter {
        self.0.iter()
    }
}

impl<V> IntoIterator for JsMap<V> {
    type Item = (String, V);
    type IntoIter = indexmap::map::IntoIter<String, V>;
    fn into_iter(self) -> Self::IntoIter {
        self.0.into_iter()
    }
}

impl<V: Serialize> Serialize for JsMap<V> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (k, v) in &self.0 {
            map.serialize_entry(k, v)?;
        }
        map.end()
    }
}

impl<'de, V: Deserialize<'de>> Deserialize<'de> for JsMap<V> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct MapVisitor<V>(std::marker::PhantomData<V>);
        impl<'de, V: Deserialize<'de>> Visitor<'de> for MapVisitor<V> {
            type Value = JsMap<V>;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("an object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut access: A) -> Result<Self::Value, A::Error> {
                let mut map = JsMap::new();
                while let Some((k, v)) = access.next_entry::<String, V>()? {
                    // JSON.parse keeps the last of a repeated key, in the first one's place.
                    map.insert(k, v);
                }
                Ok(map)
            }
        }
        deserializer.deserialize_map(MapVisitor(std::marker::PhantomData))
    }
}
