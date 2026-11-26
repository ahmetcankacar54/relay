//! The slice of `Intl.NumberFormat` and JavaScript number conversion the messages need: decimal
//! and percent styles with integer/fraction digits and grouping, for Relay's 15 format locales.
//! Digits come from the shortest round-trip form of the double, as ICU does, then round half
//! away from zero.

use crate::Locale;

/// Separators and affixes per format locale (CLDR data as Node's ICU prints it).
struct Symbols {
    group: &'static str,
    decimal: &'static str,
    /// Integer digits before grouping starts beyond 3 + this - 1 (`es`, `it`, `pl` print 1234).
    min_grouping: usize,
    percent_prefix: &'static str,
    percent_suffix: &'static str,
    nan: &'static str,
}

const NBSP: &str = "\u{a0}";
const NNBSP: &str = "\u{202f}";

const fn symbols(
    group: &'static str,
    decimal: &'static str,
    min_grouping: usize,
    suffix: &'static str,
) -> Symbols {
    Symbols {
        group,
        decimal,
        min_grouping,
        percent_prefix: "",
        percent_suffix: suffix,
        nan: "NaN",
    }
}

fn symbols_for(locale: Locale) -> Symbols {
    match locale {
        Locale::En | Locale::Ja | Locale::Ko | Locale::ZhHans => symbols(",", ".", 1, "%"),
        Locale::ZhHant => Symbols {
            nan: "非數值",
            ..symbols(",", ".", 1, "%")
        },
        Locale::Tr => Symbols {
            percent_prefix: "%",
            ..symbols(".", ",", 1, "")
        },
        Locale::De => symbols(".", ",", 1, "\u{a0}%"),
        Locale::Fr => symbols(NNBSP, ",", 1, "\u{a0}%"),
        Locale::Es => symbols(".", ",", 2, "\u{a0}%"),
        Locale::PtBr | Locale::Nl => symbols(".", ",", 1, "%"),
        Locale::It => symbols(".", ",", 2, "%"),
        Locale::Ru => Symbols {
            nan: "не\u{a0}число",
            ..symbols(NBSP, ",", 1, "\u{a0}%")
        },
        Locale::Uk => symbols(NBSP, ",", 1, "%"),
        Locale::Pl => symbols(NBSP, ",", 2, "%"),
    }
}

/// Resolved `Intl.NumberFormat` options (only the ones Relay's messages can reach).
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct NumberOptions {
    pub percent: bool,
    pub min_integer: usize,
    pub min_fraction: Option<usize>,
    pub max_fraction: Option<usize>,
    pub grouping: bool,
    /// Multiplier applied to the value first (`::scale/n`, `::%x100`).
    pub scale: Option<f64>,
}

impl Default for NumberOptions {
    fn default() -> Self {
        Self {
            percent: false,
            min_integer: 1,
            min_fraction: None,
            max_fraction: None,
            grouping: true,
            scale: None,
        }
    }
}

/// A finite decimal: `digits` (no leading or trailing zeros; empty for zero) times 10^(point - len).
struct Decimal {
    negative: bool,
    digits: Vec<u8>,
    point: i32,
}

impl Decimal {
    /// The shortest digits that read back as `value`, like ICU's double conversion.
    fn from_f64(value: f64) -> Self {
        let negative = value.is_sign_negative();
        if value == 0.0 {
            return Self {
                negative,
                digits: Vec::new(),
                point: 0,
            };
        }
        let text = format!("{:e}", value.abs());
        let (mantissa, exponent) = text.split_once('e').expect("{:e} prints an exponent");
        let digits: Vec<u8> = mantissa
            .bytes()
            .filter(u8::is_ascii_digit)
            .map(|b| b - b'0')
            .collect();
        let exponent: i32 = exponent.parse().expect("{:e} prints an integer exponent");
        let mut decimal = Self {
            negative,
            digits,
            point: exponent + 1,
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

    /// Rounds half away from zero to `fraction` digits after the point.
    fn round(&mut self, fraction: usize) {
        let keep = self.point + fraction as i32;
        if keep >= self.digits.len() as i32 {
            return;
        }
        let up = keep >= 0 && self.digits[keep as usize] >= 5;
        self.digits.truncate(keep.max(0) as usize);
        if up {
            if self.digits.is_empty() {
                // 0.0005 to 3 digits: one unit in the last kept place.
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
    fn split(&self) -> (String, String) {
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
            let zeros = "0".repeat(point as usize - all.len());
            (format!("{all}{zeros}"), String::new())
        }
    }
}

/// `Intl.NumberFormat(FORMAT_LOCALE[locale], options).format(value)`; `Err` is its RangeError.
pub(crate) fn format_number(
    locale: Locale,
    value: f64,
    options: &NumberOptions,
) -> Result<String, String> {
    let (default_min, default_max) = if options.percent { (0, 0) } else { (0, 3) };
    let (min_fraction, max_fraction) = match (options.min_fraction, options.max_fraction) {
        (Some(min), Some(max)) if min > max => {
            return Err("maximumFractionDigits value is out of range.".into());
        }
        (Some(min), Some(max)) => (min, max),
        (Some(min), None) => (min, min.max(default_max)),
        (None, Some(max)) => (default_min.min(max), max),
        (None, None) => (default_min, default_max),
    };
    let symbols = symbols_for(locale);
    let negative = value.is_sign_negative() && !value.is_nan();
    let (prefix, suffix) = if options.percent {
        (symbols.percent_prefix, symbols.percent_suffix)
    } else {
        ("", "")
    };
    let body = if value.is_nan() {
        symbols.nan.to_string()
    } else if value.is_infinite() {
        "∞".to_string()
    } else {
        let mut decimal = Decimal::from_f64(value);
        if options.percent && !decimal.digits.is_empty() {
            decimal.point += 2;
        }
        decimal.round(max_fraction);
        let (mut integer, mut fraction) = decimal.split();
        while integer.len() < options.min_integer.max(1) {
            integer.insert(0, '0');
        }
        while fraction.len() < min_fraction {
            fraction.push('0');
        }
        let mut out = group(&integer, options.grouping, &symbols);
        if !fraction.is_empty() {
            out.push_str(symbols.decimal);
            out.push_str(&fraction);
        }
        out
    };
    let sign = if negative { "-" } else { "" };
    Ok(format!("{sign}{prefix}{body}{suffix}"))
}

fn group(integer: &str, grouping: bool, symbols: &Symbols) -> String {
    if !grouping || integer.len() < 3 + symbols.min_grouping {
        return integer.to_string();
    }
    let mut out = String::new();
    for (i, c) in integer.chars().enumerate() {
        if i > 0 && (integer.len() - i) % 3 == 0 {
            out.push_str(symbols.group);
        }
        out.push(c);
    }
    out
}

/// The decimal `Intl.PluralRules` sees for `value`: rounded to 3 fraction digits, no grouping.
pub(crate) fn plural_operand_text(value: f64) -> String {
    let mut decimal = Decimal::from_f64(value);
    decimal.round(3);
    let (integer, fraction) = decimal.split();
    let integer = if integer.is_empty() {
        "0".to_string()
    } else {
        integer
    };
    let sign = if decimal.negative && !decimal.digits.is_empty() {
        "-"
    } else {
        ""
    };
    if fraction.is_empty() {
        format!("{sign}{integer}")
    } else {
        format!("{sign}{integer}.{fraction}")
    }
}

/// JavaScript's `String(number)`.
pub(crate) fn js_number_to_string(value: f64) -> String {
    if value.is_nan() {
        return "NaN".into();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    if value == 0.0 {
        return "0".into();
    }
    let decimal = Decimal::from_f64(value);
    let sign = if decimal.negative { "-" } else { "" };
    let digits: String = decimal
        .digits
        .iter()
        .map(|d| char::from(b'0' + d))
        .collect();
    let k = digits.len() as i32;
    let n = decimal.point;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let exponent = n - 1;
        let exponent = if exponent >= 0 {
            format!("+{exponent}")
        } else {
            exponent.to_string()
        };
        if k == 1 {
            format!("{digits}e{exponent}")
        } else {
            format!("{}.{}e{exponent}", &digits[..1], &digits[1..])
        }
    };
    format!("{sign}{body}")
}

/// JavaScript's `Number(string)` (StringToNumber).
pub(crate) fn js_string_to_number(text: &str) -> f64 {
    let trimmed = text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    if trimmed.is_empty() {
        return 0.0;
    }
    match trimmed {
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
        if let Some(rest) = trimmed.strip_prefix(prefix) {
            if rest.is_empty() || !rest.chars().all(|c| c.is_digit(radix)) {
                return f64::NAN;
            }
            return rest.chars().fold(0.0, |acc, c| {
                acc * f64::from(radix) + f64::from(c.to_digit(radix).unwrap_or(0))
            });
        }
    }
    let unsigned = trimmed.strip_prefix(['+', '-']).unwrap_or(trimmed);
    let mantissa = unsigned.split(['e', 'E']).next().unwrap_or("");
    let valid = unsigned
        .chars()
        .all(|c| c.is_ascii_digit() || matches!(c, '.' | 'e' | 'E' | '+' | '-'))
        && mantissa.chars().any(|c| c.is_ascii_digit());
    if !valid {
        return f64::NAN;
    }
    trimmed.parse().unwrap_or(f64::NAN)
}
