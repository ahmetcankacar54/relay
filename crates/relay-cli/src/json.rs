//! `JSON.stringify(value, null, 2)` with JavaScript's number text (`1`, not `1.0`; `1e+21`).

use std::fmt::Write;

use serde_json::Value;

pub fn stringify_pretty(value: &Value) -> String {
    let mut out = String::new();
    write_value(&mut out, value, 0);
    out
}

fn indent(out: &mut String, depth: usize) {
    for _ in 0..depth {
        out.push_str("  ");
    }
}

fn write_value(out: &mut String, value: &Value, depth: usize) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => match (n.as_i64(), n.as_u64()) {
            (Some(i), _) => {
                let _ = write!(out, "{i}");
            }
            (_, Some(u)) => out.push_str(&number_text(u as f64)),
            _ => out.push_str(&number_text(n.as_f64().unwrap_or(f64::NAN))),
        },
        Value::String(s) => out.push_str(&serde_json::to_string(s).unwrap_or_default()),
        Value::Array(items) => {
            if items.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push_str("[\n");
            for (i, item) in items.iter().enumerate() {
                indent(out, depth + 1);
                write_value(out, item, depth + 1);
                if i + 1 < items.len() {
                    out.push(',');
                }
                out.push('\n');
            }
            indent(out, depth);
            out.push(']');
        }
        Value::Object(map) => {
            if map.is_empty() {
                out.push_str("{}");
                return;
            }
            out.push_str("{\n");
            let len = map.len();
            for (i, (key, item)) in map.iter().enumerate() {
                indent(out, depth + 1);
                out.push_str(&serde_json::to_string(key).unwrap_or_default());
                out.push_str(": ");
                write_value(out, item, depth + 1);
                if i + 1 < len {
                    out.push(',');
                }
                out.push('\n');
            }
            indent(out, depth);
            out.push('}');
        }
    }
}

/// `String(n)` for a finite number (`Number.prototype.toString`); NaN and infinities are
/// `null` in JSON.
pub fn number_text(n: f64) -> String {
    if !n.is_finite() {
        return "null".into();
    }
    if n == 0.0 {
        return "0".into();
    }
    if n < 0.0 {
        return format!("-{}", number_text(-n));
    }
    // The shortest digits that read back as `n`, and the exponent of the first one.
    let exp_form = format!("{n:e}");
    let (mantissa, exponent) = exp_form.split_once('e').unwrap_or((&exp_form, "0"));
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let k = digits.len() as i64;
    let n_exp = exponent.parse::<i64>().unwrap_or(0) + 1;
    if k <= n_exp && n_exp <= 21 {
        let mut s = digits;
        for _ in 0..(n_exp - k) {
            s.push('0');
        }
        s
    } else if 0 < n_exp && n_exp <= 21 {
        format!(
            "{}.{}",
            &digits[..n_exp as usize],
            &digits[n_exp as usize..]
        )
    } else if -6 < n_exp && n_exp <= 0 {
        format!("0.{}{}", "0".repeat((-n_exp) as usize), digits)
    } else {
        let e = n_exp - 1;
        let sign = if e < 0 { '-' } else { '+' };
        if k == 1 {
            format!("{digits}e{sign}{}", e.abs())
        } else {
            format!("{}.{}e{sign}{}", &digits[..1], &digits[1..], e.abs())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::number_text;

    #[test]
    fn numbers_read_as_in_javascript() {
        for (n, text) in [
            (1.0, "1"),
            (0.5, "0.5"),
            (123.456, "123.456"),
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (0.000001, "0.000001"),
            (1.5e-7, "1.5e-7"),
            (-2.25, "-2.25"),
            (0.1 + 0.2, "0.30000000000000004"),
        ] {
            assert_eq!(number_text(n), text);
        }
    }
}
