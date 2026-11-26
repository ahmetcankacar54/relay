//! Port of intl-messageformat's `formatToParts` for string and number values.

use std::sync::OnceLock;

use intl_pluralrules::operands::PluralOperands;
use intl_pluralrules::{PluralCategory, PluralRuleType, PluralRules};
use unic_langid::LanguageIdentifier;

use crate::message::{Element, NumberStyle};
use crate::number::{
    NumberOptions, format_number, js_number_to_string, js_string_to_number, plural_operand_text,
};
use crate::{Error, Locale};

/// One placeholder value: what `Params` holds once `undefined` became `""`.
#[derive(Clone, Debug, PartialEq)]
pub enum Arg {
    Str(String),
    Num(f64),
}

impl Arg {
    /// `String(value)`.
    fn text(&self) -> String {
        match self {
            Arg::Str(s) => s.clone(),
            Arg::Num(n) => js_number_to_string(*n),
        }
    }

    /// `Number(value)`, as the arithmetic in plural selection and Intl.NumberFormat see it.
    fn number(&self) -> f64 {
        match self {
            Arg::Str(s) => js_string_to_number(s),
            Arg::Num(n) => *n,
        }
    }
}

impl From<&str> for Arg {
    fn from(value: &str) -> Self {
        Arg::Str(value.to_string())
    }
}

impl From<String> for Arg {
    fn from(value: String) -> Self {
        Arg::Str(value)
    }
}

impl From<&String> for Arg {
    fn from(value: &String) -> Self {
        Arg::Str(value.clone())
    }
}

macro_rules! numeric_arg {
    ($($ty:ty),*) => {$(
        impl From<$ty> for Arg {
            fn from(value: $ty) -> Self {
                Arg::Num(value as f64)
            }
        }
    )*};
}
numeric_arg!(f64, f32, i8, i16, i32, i64, isize, u8, u16, u32, u64, usize);

impl From<&serde_json::Value> for Arg {
    /// `null` is the TS `undefined` (formats as `""`); booleans, arrays and objects, which `Params`
    /// never holds, become their JSON text.
    fn from(value: &serde_json::Value) -> Self {
        match value {
            serde_json::Value::Null => Arg::Str(String::new()),
            serde_json::Value::String(s) => Arg::Str(s.clone()),
            serde_json::Value::Number(n) => Arg::Num(n.as_f64().unwrap_or(f64::NAN)),
            other => Arg::Str(other.to_string()),
        }
    }
}

/// A message's placeholder values, by name. Later `set`s of a name win.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Args(Vec<(String, Arg)>);

impl Args {
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds or replaces `name`.
    pub fn set(mut self, name: impl Into<String>, value: impl Into<Arg>) -> Self {
        self.insert(name, value);
        self
    }

    pub fn insert(&mut self, name: impl Into<String>, value: impl Into<Arg>) {
        let name = name.into();
        let value = value.into();
        match self.0.iter_mut().find(|(n, _)| *n == name) {
            Some(slot) => slot.1 = value,
            None => self.0.push((name, value)),
        }
    }

    pub fn get(&self, name: &str) -> Option<&Arg> {
        self.0.iter().find(|(n, _)| n == name).map(|(_, v)| v)
    }

    /// The values of a JSON object (`{}` for anything else).
    pub fn from_json(value: &serde_json::Value) -> Self {
        let mut args = Self::new();
        if let Some(map) = value.as_object() {
            for (name, v) in map {
                args.insert(name.clone(), v);
            }
        }
        args
    }
}

impl<K: Into<String>, V: Into<Arg>> FromIterator<(K, V)> for Args {
    fn from_iter<I: IntoIterator<Item = (K, V)>>(iter: I) -> Self {
        let mut args = Self::new();
        for (k, v) in iter {
            args.insert(k, v);
        }
        args
    }
}

/// A `<tag>` renderer for rich messages: the tag name and what renders its formatted children.
pub type Tag<'a> = (&'a str, &'a dyn Fn(&str) -> String);

pub(crate) struct Context<'a> {
    pub locale: Locale,
    pub args: &'a Args,
    pub tags: &'a [Tag<'a>],
}

/// `formatToParts`. `original` is the message errors name: intl-messageformat passes it only at
/// the top level, so errors inside branches and tags read `"undefined"`.
pub(crate) fn format_elements(
    cx: &Context<'_>,
    elements: &[Element],
    plural_value: Option<f64>,
    original: Option<&str>,
    out: &mut String,
) -> Result<(), Error> {
    let locale = cx.locale;
    for element in elements {
        let name = match element {
            Element::Literal(text) => {
                out.push_str(text);
                continue;
            }
            Element::Pound => {
                if let Some(value) = plural_value {
                    out.push_str(
                        &format_number(locale, value, &NumberOptions::default())
                            .map_err(Error::Range)?,
                    );
                }
                continue;
            }
            Element::Argument(name)
            | Element::Number { name, .. }
            | Element::DateTime(name)
            | Element::Select { name, .. }
            | Element::Plural { name, .. }
            | Element::Tag { name, .. } => name,
        };
        let missing = || Error::MissingValue {
            name: name.clone(),
            message: original.map(str::to_string),
        };
        if let Element::Tag { children, .. } = element {
            let Some((_, render)) = cx.tags.iter().find(|(tag, _)| tag == name) else {
                return Err(match cx.args.get(name) {
                    Some(_) => Error::InvalidValue(format!(
                        "Value for \"{name}\" must be of type function"
                    )),
                    None => missing(),
                });
            };
            let mut inner = String::new();
            format_elements(cx, children, plural_value, None, &mut inner)?;
            out.push_str(&render(&inner));
            continue;
        }
        let value = cx.args.get(name).ok_or_else(missing)?;
        match element {
            Element::Argument(_) => out.push_str(&value.text()),
            Element::Number { style, .. } => {
                let NumberStyle::Options(options) = style else {
                    return Err(Error::Range(
                        "Currency code is required with currency style.".into(),
                    ));
                };
                let mut number = value.number();
                if let Some(scale) = options.scale {
                    number *= scale;
                }
                out.push_str(&format_number(locale, number, options).map_err(Error::Range)?);
            }
            Element::DateTime(_) => {
                return Err(Error::Unsupported(format!("date/time argument {name}")));
            }
            Element::Select { options, .. } => {
                let key = value.text();
                let branch = pick(options, &key).ok_or_else(|| invalid(name, &key, options))?;
                format_elements(cx, branch, None, None, out)?;
            }
            Element::Plural {
                offset,
                ordinal,
                options,
                ..
            } => {
                let exact = format!("={}", value.text());
                let shifted = value.number() - *offset as f64;
                let branch = match options.iter().find(|(k, _)| *k == exact) {
                    Some((_, branch)) => Some(branch),
                    None => pick(options, category(locale, *ordinal, shifted)),
                };
                let branch = branch.ok_or_else(|| invalid(name, &value.text(), options))?;
                format_elements(cx, branch, Some(shifted), None, out)?;
            }
            Element::Literal(_) | Element::Pound | Element::Tag { .. } => {
                unreachable!("handled above")
            }
        }
    }
    Ok(())
}

/// The branch for `key`, else `other` (always present: the parser requires it).
fn pick<'a>(options: &'a [(String, Vec<Element>)], key: &str) -> Option<&'a Vec<Element>> {
    let found = options
        .iter()
        .find(|(k, _)| k == key)
        .or_else(|| options.iter().find(|(k, _)| k == "other"));
    found.map(|(_, branch)| branch)
}

fn invalid(name: &str, value: &str, options: &[(String, Vec<Element>)]) -> Error {
    let keys: Vec<&str> = options.iter().map(|(k, _)| k.as_str()).collect();
    Error::InvalidValue(format!(
        "Invalid values for \"{name}\": \"{value}\". Options are \"{}\"",
        keys.join("\", \"")
    ))
}

/// `Intl.PluralRules(FORMAT_LOCALE[locale], {type}).select(value)`.
fn category(locale: Locale, ordinal: bool, value: f64) -> &'static str {
    if !value.is_finite() {
        return "other";
    }
    let text = plural_operand_text(value);
    let Ok(operands) = PluralOperands::try_from(text.as_str()) else {
        return "other";
    };
    // CLDR 38+ (Node's ICU): exact millions are `many` in these languages; the crate's data predates it.
    let millions = !ordinal
        && matches!(locale, Locale::Fr | Locale::Es | Locale::It | Locale::PtBr)
        && operands.v == 0
        && operands.i != 0
        && operands.i % 1_000_000 == 0;
    match plural_rules(locale, ordinal)
        .select(operands)
        .unwrap_or(PluralCategory::OTHER)
    {
        PluralCategory::OTHER if millions => "many",
        PluralCategory::ZERO => "zero",
        PluralCategory::ONE => "one",
        PluralCategory::TWO => "two",
        PluralCategory::FEW => "few",
        PluralCategory::MANY => "many",
        PluralCategory::OTHER => "other",
    }
}

fn plural_rules(locale: Locale, ordinal: bool) -> &'static PluralRules {
    static RULES: [[OnceLock<PluralRules>; 2]; 15] = [const { [const { OnceLock::new() }; 2] }; 15];
    RULES[locale as usize][usize::from(ordinal)].get_or_init(|| {
        // Rules are per language; the crate keys them by the bare language subtag.
        let language = locale.format_locale().split('-').next().unwrap_or("en");
        let langid: LanguageIdentifier = language
            .parse()
            .expect("format locales are valid language ids");
        let kind = if ordinal {
            PluralRuleType::ORDINAL
        } else {
            PluralRuleType::CARDINAL
        };
        PluralRules::create(langid, kind).expect("every Relay language has CLDR plural rules")
    })
}
