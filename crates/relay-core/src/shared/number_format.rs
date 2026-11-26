//! Port of `shared/number-format.ts`: the number formats shared by the renderer and main (the
//! widget file), in the reader's language. A port of the `Intl.NumberFormat` output for Relay's 15
//! format locales (`FORMAT_LOCALE`, CLDR data as Node's ICU prints it) for the patterns used here:
//! compact token counts, US-dollar amounts and signed percent changes. Digits come from the
//! shortest round-trip form of the double, as ICU does, rounded half away from zero.

use relay_i18n::Locale;

const NBSP: &str = "\u{a0}";
const NNBSP: &str = "\u{202f}";

/// A finite decimal: `digits` (no trailing zeros; empty for zero) times 10^(point - len).
#[derive(Clone, Debug)]
pub(crate) struct Decimal {
    pub negative: bool,
    digits: Vec<u8>,
    point: i32,
}

impl Decimal {
    /// The shortest digits that read back as `value`.
    pub fn from_f64(value: f64) -> Self {
        let negative = value.is_sign_negative();
        if value == 0.0 {
            return Self {
                negative,
                digits: Vec::new(),
                point: 0,
            };
        }
        let text = format!("{:e}", value.abs());
        let (mantissa, exponent) = text.split_once('e').unwrap_or((&text, "0"));
        let digits = mantissa
            .bytes()
            .filter(u8::is_ascii_digit)
            .map(|b| b - b'0')
            .collect();
        let mut decimal = Self {
            negative,
            digits,
            point: exponent.parse::<i32>().unwrap_or(0) + 1,
        };
        decimal.trim();
        decimal
    }

    fn trim(&mut self) {
        while self.digits.last() == Some(&0) {
            self.digits.pop();
        }
        if self.digits.is_empty() {
            self.point = 0;
        }
    }

    pub fn is_zero(&self) -> bool {
        self.digits.is_empty()
    }

    /// The power of ten of the leading digit (`floor(log10 |x|)`); `None` for zero.
    pub fn magnitude(&self) -> Option<i32> {
        (!self.is_zero()).then_some(self.point - 1)
    }

    /// Multiplies by 10^`by`.
    pub fn shift(&mut self, by: i32) {
        if !self.is_zero() {
            self.point += by;
        }
    }

    /// Rounds half away from zero to `fraction` digits after the point.
    pub fn round(&mut self, fraction: usize) {
        let keep = self.point + fraction as i32;
        if keep >= self.digits.len() as i32 {
            return;
        }
        let up = keep >= 0 && self.digits[keep as usize] >= 5;
        self.digits.truncate(keep.max(0) as usize);
        if up {
            if self.digits.is_empty() {
                self.digits.push(1);
                self.point = 1 - fraction as i32;
            } else if let Some(i) = self.digits.iter().rposition(|&d| d != 9) {
                self.digits[i] += 1;
                self.digits.truncate(i + 1);
            } else {
                self.digits = vec![1];
                self.point += 1;
            }
        }
        self.trim();
    }

    /// The digits before and after the point, without padding.
    pub fn split(&self) -> (String, String) {
        let all: String = self.digits.iter().map(|d| char::from(b'0' + d)).collect();
        let point = self.point;
        if point <= 0 {
            (
                String::new(),
                format!("{}{all}", "0".repeat(point.unsigned_abs() as usize)),
            )
        } else if (point as usize) < all.len() {
            (
                all[..point as usize].to_string(),
                all[point as usize..].to_string(),
            )
        } else {
            (
                format!("{all}{}", "0".repeat(point as usize - all.len())),
                String::new(),
            )
        }
    }
}

/// Separators per format locale.
pub(crate) struct Symbols {
    pub group: &'static str,
    pub decimal: &'static str,
    /// 2 where a four-digit integer is not grouped (`es`, `it`, `pl`).
    pub min_grouping: usize,
    pub percent_prefix: &'static str,
    pub percent_suffix: &'static str,
}

pub(crate) fn symbols(locale: Locale) -> Symbols {
    let s = |group, decimal, min_grouping, percent_prefix, percent_suffix| Symbols {
        group,
        decimal,
        min_grouping,
        percent_prefix,
        percent_suffix,
    };
    match locale {
        Locale::En | Locale::Ja | Locale::Ko | Locale::ZhHans | Locale::ZhHant => {
            s(",", ".", 1, "", "%")
        }
        Locale::Tr => s(".", ",", 1, "%", ""),
        Locale::De => s(".", ",", 1, "", "\u{a0}%"),
        Locale::Fr => s(NNBSP, ",", 1, "", "\u{a0}%"),
        Locale::Es => s(".", ",", 2, "", "\u{a0}%"),
        Locale::PtBr | Locale::Nl => s(".", ",", 1, "", "%"),
        Locale::It => s(".", ",", 2, "", "%"),
        Locale::Ru => s(NBSP, ",", 1, "", "\u{a0}%"),
        Locale::Uk => s(NBSP, ",", 1, "", "%"),
        Locale::Pl => s(NBSP, ",", 2, "", "%"),
    }
}

/// The integer digits grouped by three when there are at least `3 + min_grouping` of them.
pub(crate) fn group(integer: &str, grouping: bool, min_grouping: usize, separator: &str) -> String {
    if !grouping || integer.len() < 3 + min_grouping {
        return integer.to_string();
    }
    let mut out = String::new();
    for (i, c) in integer.chars().enumerate() {
        if i > 0 && (integer.len() - i) % 3 == 0 {
            out.push_str(separator);
        }
        out.push(c);
    }
    out
}

/// The unsigned digits of a rounded decimal: grouped integer, then the fraction padded to `min_fraction`.
pub(crate) fn body(
    decimal: &Decimal,
    min_fraction: usize,
    grouping: bool,
    min_grouping: usize,
    symbols: &Symbols,
) -> String {
    let (mut integer, mut fraction) = decimal.split();
    if integer.is_empty() {
        integer.push('0');
    }
    while fraction.len() < min_fraction {
        fraction.push('0');
    }
    let mut out = group(&integer, grouping, min_grouping, symbols.group);
    if !fraction.is_empty() {
        out.push_str(symbols.decimal);
        out.push_str(&fraction);
    }
    out
}

/// The short compact pattern for a power of ten from 3 to 14: the divisor's exponent and the
/// suffix; `None` where the locale writes the number out.
fn compact_pattern(locale: Locale, magnitude: i32) -> Option<(i32, &'static str)> {
    if magnitude < 3 {
        return None;
    }
    // Japanese goes on to 京 (10^16); the other locales stay on their last unit.
    if locale == Locale::Ja && magnitude >= 16 {
        return Some((16, "\u{4eac}"));
    }
    let table: [Option<(i32, &'static str)>; 12] = match locale {
        Locale::En => [
            Some((3, "k")),
            Some((3, "k")),
            Some((3, "k")),
            Some((6, "m")),
            Some((6, "m")),
            Some((6, "m")),
            Some((9, "bn")),
            Some((9, "bn")),
            Some((9, "bn")),
            Some((12, "tn")),
            Some((12, "tn")),
            Some((12, "tn")),
        ],
        Locale::Tr => [
            Some((3, "\u{a0}B")),
            Some((3, "\u{a0}B")),
            Some((3, "\u{a0}B")),
            Some((6, "\u{a0}Mn")),
            Some((6, "\u{a0}Mn")),
            Some((6, "\u{a0}Mn")),
            Some((9, "\u{a0}Mr")),
            Some((9, "\u{a0}Mr")),
            Some((9, "\u{a0}Mr")),
            Some((12, "\u{a0}Tn")),
            Some((12, "\u{a0}Tn")),
            Some((12, "\u{a0}Tn")),
        ],
        Locale::De => [
            None,
            None,
            None,
            Some((6, "\u{a0}Mio.")),
            Some((6, "\u{a0}Mio.")),
            Some((6, "\u{a0}Mio.")),
            Some((9, "\u{a0}Mrd.")),
            Some((9, "\u{a0}Mrd.")),
            Some((9, "\u{a0}Mrd.")),
            Some((12, "\u{a0}Bio.")),
            Some((12, "\u{a0}Bio.")),
            Some((12, "\u{a0}Bio.")),
        ],
        Locale::Fr => [
            Some((3, "\u{a0}k")),
            Some((3, "\u{a0}k")),
            Some((3, "\u{a0}k")),
            Some((6, "\u{a0}M")),
            Some((6, "\u{a0}M")),
            Some((6, "\u{a0}M")),
            Some((9, "\u{a0}Md")),
            Some((9, "\u{a0}Md")),
            Some((9, "\u{a0}Md")),
            Some((12, "\u{a0}Bn")),
            Some((12, "\u{a0}Bn")),
            Some((12, "\u{a0}Bn")),
        ],
        Locale::Es => [
            Some((3, "\u{a0}mil")),
            Some((3, "\u{a0}mil")),
            Some((3, "\u{a0}mil")),
            Some((6, "\u{a0}M")),
            Some((6, "\u{a0}M")),
            Some((6, "\u{a0}M")),
            Some((6, "\u{a0}M")),
            Some((9, "\u{a0}mil\u{a0}M")),
            Some((9, "\u{a0}mil\u{a0}M")),
            Some((12, "\u{a0}B")),
            Some((12, "\u{a0}B")),
            Some((12, "\u{a0}B")),
        ],
        Locale::PtBr => [
            Some((3, "\u{a0}mil")),
            Some((3, "\u{a0}mil")),
            Some((3, "\u{a0}mil")),
            Some((6, "\u{a0}mi")),
            Some((6, "\u{a0}mi")),
            Some((6, "\u{a0}mi")),
            Some((9, "\u{a0}bi")),
            Some((9, "\u{a0}bi")),
            Some((9, "\u{a0}bi")),
            Some((12, "\u{a0}tri")),
            Some((12, "\u{a0}tri")),
            Some((12, "\u{a0}tri")),
        ],
        Locale::It => [
            Some((3, "K")),
            Some((3, "K")),
            Some((3, "K")),
            Some((6, "\u{a0}Mln")),
            Some((6, "\u{a0}Mln")),
            Some((6, "\u{a0}Mln")),
            Some((9, "\u{a0}Mld")),
            Some((9, "\u{a0}Mld")),
            Some((9, "\u{a0}Mld")),
            Some((12, "\u{a0}Bln")),
            Some((12, "\u{a0}Bln")),
            Some((12, "\u{a0}Bln")),
        ],
        Locale::Ja => [
            None,
            Some((4, "\u{4e07}")),
            Some((4, "\u{4e07}")),
            Some((4, "\u{4e07}")),
            Some((4, "\u{4e07}")),
            Some((8, "\u{5104}")),
            Some((8, "\u{5104}")),
            Some((8, "\u{5104}")),
            Some((8, "\u{5104}")),
            Some((12, "\u{5146}")),
            Some((12, "\u{5146}")),
            Some((12, "\u{5146}")),
        ],
        Locale::Ko => [
            Some((3, "\u{cc9c}")),
            Some((4, "\u{b9cc}")),
            Some((4, "\u{b9cc}")),
            Some((4, "\u{b9cc}")),
            Some((4, "\u{b9cc}")),
            Some((8, "\u{c5b5}")),
            Some((8, "\u{c5b5}")),
            Some((8, "\u{c5b5}")),
            Some((8, "\u{c5b5}")),
            Some((12, "\u{c870}")),
            Some((12, "\u{c870}")),
            Some((12, "\u{c870}")),
        ],
        Locale::ZhHans => [
            None,
            Some((4, "\u{4e07}")),
            Some((4, "\u{4e07}")),
            Some((4, "\u{4e07}")),
            Some((4, "\u{4e07}")),
            Some((8, "\u{4ebf}")),
            Some((8, "\u{4ebf}")),
            Some((8, "\u{4ebf}")),
            Some((8, "\u{4ebf}")),
            Some((12, "\u{4e07}\u{4ebf}")),
            Some((12, "\u{4e07}\u{4ebf}")),
            Some((12, "\u{4e07}\u{4ebf}")),
        ],
        Locale::ZhHant => [
            None,
            Some((4, "\u{842c}")),
            Some((4, "\u{842c}")),
            Some((4, "\u{842c}")),
            Some((4, "\u{842c}")),
            Some((8, "\u{5104}")),
            Some((8, "\u{5104}")),
            Some((8, "\u{5104}")),
            Some((8, "\u{5104}")),
            Some((12, "\u{5146}")),
            Some((12, "\u{5146}")),
            Some((12, "\u{5146}")),
        ],
        Locale::Ru => [
            Some((3, "\u{a0}\u{442}\u{44b}\u{441}.")),
            Some((3, "\u{a0}\u{442}\u{44b}\u{441}.")),
            Some((3, "\u{a0}\u{442}\u{44b}\u{441}.")),
            Some((6, "\u{a0}\u{43c}\u{43b}\u{43d}")),
            Some((6, "\u{a0}\u{43c}\u{43b}\u{43d}")),
            Some((6, "\u{a0}\u{43c}\u{43b}\u{43d}")),
            Some((9, "\u{a0}\u{43c}\u{43b}\u{440}\u{434}")),
            Some((9, "\u{a0}\u{43c}\u{43b}\u{440}\u{434}")),
            Some((9, "\u{a0}\u{43c}\u{43b}\u{440}\u{434}")),
            Some((12, "\u{a0}\u{442}\u{440}\u{43b}\u{43d}")),
            Some((12, "\u{a0}\u{442}\u{440}\u{43b}\u{43d}")),
            Some((12, "\u{a0}\u{442}\u{440}\u{43b}\u{43d}")),
        ],
        Locale::Uk => [
            Some((3, "\u{a0}\u{442}\u{438}\u{441}.")),
            Some((3, "\u{a0}\u{442}\u{438}\u{441}.")),
            Some((3, "\u{a0}\u{442}\u{438}\u{441}.")),
            Some((6, "\u{a0}\u{43c}\u{43b}\u{43d}")),
            Some((6, "\u{a0}\u{43c}\u{43b}\u{43d}")),
            Some((6, "\u{a0}\u{43c}\u{43b}\u{43d}")),
            Some((9, "\u{a0}\u{43c}\u{43b}\u{440}\u{434}")),
            Some((9, "\u{a0}\u{43c}\u{43b}\u{440}\u{434}")),
            Some((9, "\u{a0}\u{43c}\u{43b}\u{440}\u{434}")),
            Some((12, "\u{a0}\u{442}\u{440}\u{43b}\u{43d}")),
            Some((12, "\u{a0}\u{442}\u{440}\u{43b}\u{43d}")),
            Some((12, "\u{a0}\u{442}\u{440}\u{43b}\u{43d}")),
        ],
        Locale::Pl => [
            Some((3, "\u{a0}tys.")),
            Some((3, "\u{a0}tys.")),
            Some((3, "\u{a0}tys.")),
            Some((6, "\u{a0}mln")),
            Some((6, "\u{a0}mln")),
            Some((6, "\u{a0}mln")),
            Some((9, "\u{a0}mld")),
            Some((9, "\u{a0}mld")),
            Some((9, "\u{a0}mld")),
            Some((12, "\u{a0}bln")),
            Some((12, "\u{a0}bln")),
            Some((12, "\u{a0}bln")),
        ],
        Locale::Nl => [
            Some((3, "K")),
            Some((3, "K")),
            Some((3, "K")),
            Some((6, "\u{a0}mln.")),
            Some((6, "\u{a0}mln.")),
            Some((6, "\u{a0}mln.")),
            Some((9, "\u{a0}mld.")),
            Some((9, "\u{a0}mld.")),
            Some((9, "\u{a0}mld.")),
            Some((12, "\u{a0}bln.")),
            Some((12, "\u{a0}bln.")),
            Some((12, "\u{a0}bln.")),
        ],
    };
    table[(magnitude.min(14) - 3) as usize]
}

/// `notation: "compact", maximumFractionDigits: 1`: the rounded digits and the suffix. A value
/// that rounds up to the next power of ten takes that power's pattern, as ICU does.
fn compact(value: f64, locale: Locale) -> (Decimal, &'static str) {
    let original = Decimal::from_f64(value);
    let Some(magnitude) = original.magnitude() else {
        return (original, "");
    };
    let apply = |pattern: Option<(i32, &'static str)>| {
        let mut d = original.clone();
        d.shift(-pattern.map_or(0, |p| p.0));
        d.round(1);
        d
    };
    let pattern = compact_pattern(locale, magnitude);
    let mut rounded = apply(pattern);
    let divisor = pattern.map_or(0, |p| p.0);
    if rounded.magnitude().map(|m| m + divisor) == Some(magnitude + 1) {
        let next = compact_pattern(locale, magnitude + 1);
        if next.map(|p| p.0) != pattern.map(|p| p.0) {
            rounded = apply(next);
            return (rounded, next.map_or("", |p| p.1));
        }
    }
    (rounded, pattern.map_or("", |p| p.1))
}

/// The sign `signDisplay: "auto"` prints: `-` for any negative value, also one rounding to `-0`.
fn minus(decimal: &Decimal) -> &'static str {
    if decimal.negative { "-" } else { "" }
}

/// How a locale prints `NaN`.
fn nan_symbol(locale: Locale) -> &'static str {
    match locale {
        Locale::ZhHant => "非數值",
        Locale::Ru => "не\u{a0}число",
        _ => "NaN",
    }
}

/// A token count in compact units: "1,2 Mn" / "1.2m", "326 B" / "326k".
pub fn format_tokens(value: f64, language: Locale) -> String {
    if value.is_nan() {
        return nan_symbol(language).into();
    }
    if value.is_infinite() {
        return if value > 0.0 {
            "∞".into()
        } else {
            "-∞".into()
        };
    }
    let symbols = symbols(language);
    let (rounded, suffix) = compact(value, language);
    format!(
        "{}{}{suffix}",
        minus(&rounded),
        body(&rounded, 0, true, 2, &symbols)
    )
}

/// Where the dollar sign goes in a locale's currency pattern.
fn currency_affixes(locale: Locale) -> (&'static str, &'static str) {
    match locale {
        Locale::En | Locale::Tr | Locale::Ja | Locale::Ko | Locale::ZhHans | Locale::ZhHant => {
            ("$", "")
        }
        Locale::PtBr | Locale::Nl => ("$\u{a0}", ""),
        Locale::De
        | Locale::Fr
        | Locale::Es
        | Locale::It
        | Locale::Ru
        | Locale::Uk
        | Locale::Pl => ("", "\u{a0}$"),
    }
}

/// An API value in US dollars: "$444,56" / "$444.56", compact from $10,000 ("$12,3 B").
pub fn format_cost(value: f64, language: Locale) -> String {
    let symbols = symbols(language);
    let (prefix, suffix) = currency_affixes(language);
    if !value.is_finite() {
        let body = if value.is_nan() {
            nan_symbol(language)
        } else {
            "∞"
        };
        let sign = if value < 0.0 { "-" } else { "" };
        // Dutch puts the minus after the dollar sign: "$ -∞".
        if language == Locale::Nl {
            return format!("{prefix}{sign}{body}{suffix}");
        }
        return format!("{sign}{prefix}{body}{suffix}");
    }
    if value.abs() >= 10_000.0 {
        let (rounded, compact_suffix) = compact(value, language);
        let digits = body(&rounded, 0, true, 2, &symbols);
        return format!(
            "{}{prefix}{digits}{compact_suffix}{suffix}",
            minus(&rounded)
        );
    }
    let mut decimal = Decimal::from_f64(value);
    decimal.round(2);
    let digits = body(&decimal, 2, true, symbols.min_grouping, &symbols);
    // Dutch puts the minus after the dollar sign: "$ -3,46".
    if language == Locale::Nl {
        return format!("{prefix}{}{digits}{suffix}", minus(&decimal));
    }
    format!("{}{prefix}{digits}{suffix}", minus(&decimal))
}

/// A signed change: "+%57,2" / "+57.2%", "-%3" / "-3%"; no sign when it rounds to zero.
pub fn format_change(change: f64, language: Locale) -> String {
    let symbols = symbols(language);
    if !change.is_finite() {
        let body = if change.is_nan() {
            nan_symbol(language)
        } else {
            "∞"
        };
        let sign = if change > 0.0 {
            "+"
        } else if change < 0.0 {
            "-"
        } else {
            ""
        };
        return format!(
            "{sign}{}{body}{}",
            symbols.percent_prefix, symbols.percent_suffix
        );
    }
    let mut decimal = Decimal::from_f64(change);
    decimal.shift(2);
    decimal.round(1);
    let sign = if decimal.is_zero() {
        ""
    } else if decimal.negative {
        "-"
    } else {
        "+"
    };
    let digits = body(&decimal, 0, true, symbols.min_grouping, &symbols);
    format!(
        "{sign}{}{digits}{}",
        symbols.percent_prefix, symbols.percent_suffix
    )
}
