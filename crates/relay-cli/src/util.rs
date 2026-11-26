//! JavaScript conversions the TS relies on.

/// `Number(text)`: trimmed; empty is 0; decimal, `0x`/`0o`/`0b` integers and `Infinity`;
/// anything else NaN.
pub fn js_number(text: &str) -> f64 {
    let s = relay_core::store::schema::js_trim(text);
    if s.is_empty() {
        return 0.0;
    }
    let radix = |prefix: [&str; 2], radix: u32| {
        prefix.iter().find_map(|p| s.strip_prefix(p)).map(|digits| {
            match u128::from_str_radix(digits, radix) {
                Ok(n) if !digits.is_empty() => n as f64,
                _ => f64::NAN,
            }
        })
    };
    if let Some(n) = radix(["0x", "0X"], 16)
        .or_else(|| radix(["0o", "0O"], 8))
        .or_else(|| radix(["0b", "0B"], 2))
    {
        return n;
    }
    let (sign, body) = match s.as_bytes()[0] {
        b'-' => (-1.0, &s[1..]),
        b'+' => (1.0, &s[1..]),
        _ => (1.0, s),
    };
    if body == "Infinity" {
        return sign * f64::INFINITY;
    }
    // Only digits, one dot and an exponent: Rust's parser also takes "inf" and "nan".
    let valid = !body.is_empty()
        && body
            .bytes()
            .all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'e' | b'E' | b'+' | b'-'))
        && body.bytes().any(|b| b.is_ascii_digit());
    if !valid {
        return f64::NAN;
    }
    body.parse::<f64>().map(|n| sign * n).unwrap_or(f64::NAN)
}

#[cfg(test)]
mod tests {
    use super::js_number;

    #[test]
    fn reads_as_number_does() {
        assert_eq!(js_number(""), 0.0);
        assert_eq!(js_number(" 7 "), 7.0);
        assert_eq!(js_number("0x10"), 16.0);
        assert_eq!(js_number("1e3"), 1000.0);
        assert_eq!(js_number(".5"), 0.5);
        assert_eq!(js_number("-Infinity"), f64::NEG_INFINITY);
        assert!(js_number("inf").is_nan());
        assert!(js_number("7d").is_nan());
        assert!(js_number("-").is_nan());
    }
}
