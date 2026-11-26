//! Port of `@formatjs/icu-messageformat-parser`: apostrophes quote only where needed, `#` is
//! special only directly inside `plural`/`selectordinal`, every plural/select needs an `other`
//! branch. `tFor` parses with `ignoreTag: true` (`<tags>` are text); `formatRich` parses tags.

use crate::number::NumberOptions;

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Element {
    Literal(String),
    Argument(String),
    Number {
        name: String,
        style: NumberStyle,
    },
    /// `{x, date}` / `{x, time}`: parsed, but formatting them is unsupported (no catalog uses them).
    DateTime(String),
    Select {
        name: String,
        options: Vec<(String, Vec<Element>)>,
    },
    Plural {
        name: String,
        offset: i64,
        ordinal: bool,
        options: Vec<(String, Vec<Element>)>,
    },
    Pound,
    /// `<name>children</name>`, only when tags are parsed.
    Tag {
        name: String,
        children: Vec<Element>,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum NumberStyle {
    Options(NumberOptions),
    /// `{x, number, currency}` without a currency code: a RangeError when formatted.
    Currency,
}

#[derive(Clone, Copy, PartialEq)]
enum Parent {
    None,
    Plural,
    Select,
}

/// The parser's error kind name (`ErrorKind[...]`), the SyntaxError message.
pub(crate) type ParseError = &'static str;

/// `parse(message, { ignoreTag: true })`.
pub(crate) fn parse(message: &str) -> Result<Vec<Element>, ParseError> {
    Parser::new(message, true).parse_message(0, Parent::None, false)
}

/// `parse(message)` with tags.
pub(crate) fn parse_rich(message: &str) -> Result<Vec<Element>, ParseError> {
    Parser::new(message, false).parse_message(0, Parent::None, false)
}

struct Parser {
    chars: Vec<char>,
    pos: usize,
    ignore_tag: bool,
}

fn is_alpha(c: Option<char>) -> bool {
    c.is_some_and(|c| c.is_ascii_alphabetic())
}

/// `_isPotentialElementNameChar`.
fn is_tag_name_char(c: char) -> bool {
    matches!(c,
        '-' | '.' | '0'..='9' | '_' | 'a'..='z' | 'A'..='Z' | '\u{b7}' | '\u{c0}'..='\u{d6}' | '\u{d8}'..='\u{f6}'
        | '\u{f8}'..='\u{37d}' | '\u{37f}'..='\u{1fff}' | '\u{200c}'..='\u{200d}' | '\u{203f}'..='\u{2040}'
        | '\u{2070}'..='\u{218f}' | '\u{2c00}'..='\u{2fef}' | '\u{3001}'..='\u{d7ff}' | '\u{f900}'..='\u{fdcf}'
        | '\u{fdf0}'..='\u{fffd}' | '\u{10000}'..='\u{effff}')
}

/// `\p{White_Space}`.
fn is_white_space(c: char) -> bool {
    matches!(c, '\u{9}'..='\u{d}' | ' ' | '\u{85}' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}')
}

/// `\p{Pattern_Syntax}`.
fn is_pattern_syntax(c: char) -> bool {
    matches!(c,
        '\u{21}'..='\u{2f}' | '\u{3a}'..='\u{40}' | '\u{5b}'..='\u{5e}' | '\u{60}' | '\u{7b}'..='\u{7e}'
        | '\u{a1}'..='\u{a7}' | '\u{a9}' | '\u{ab}' | '\u{ac}' | '\u{ae}' | '\u{b0}' | '\u{b1}' | '\u{b6}'
        | '\u{bb}' | '\u{bf}' | '\u{d7}' | '\u{f7}' | '\u{2010}'..='\u{2027}' | '\u{2030}'..='\u{203e}'
        | '\u{2041}'..='\u{2053}' | '\u{2055}'..='\u{205e}' | '\u{2190}'..='\u{245f}' | '\u{2500}'..='\u{2775}'
        | '\u{2794}'..='\u{2bff}' | '\u{2e00}'..='\u{2e7f}' | '\u{3001}'..='\u{3003}' | '\u{3008}'..='\u{3020}'
        | '\u{3030}' | '\u{fd3e}' | '\u{fd3f}' | '\u{fe45}' | '\u{fe46}')
}

/// The parser's `_isWhiteSpace` (Pattern_White_Space), used between tokens.
fn is_pattern_white_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}'..='\u{d}' | ' ' | '\u{85}' | '\u{200e}' | '\u{200f}' | '\u{2028}' | '\u{2029}'
    )
}

impl Parser {
    fn new(message: &str, ignore_tag: bool) -> Self {
        Self {
            chars: message.chars().collect(),
            pos: 0,
            ignore_tag,
        }
    }

    fn eof(&self) -> bool {
        self.pos >= self.chars.len()
    }

    fn char(&self) -> char {
        self.chars[self.pos]
    }

    fn peek(&self) -> Option<char> {
        self.chars.get(self.pos + 1).copied()
    }

    fn bump(&mut self) {
        if !self.eof() {
            self.pos += 1;
        }
    }

    fn bump_if(&mut self, prefix: &str) -> bool {
        let len = prefix.chars().count();
        let matches = self.chars.len() >= self.pos + len
            && prefix
                .chars()
                .zip(&self.chars[self.pos..])
                .all(|(a, &b)| a == b);
        if matches {
            self.pos += len;
        }
        matches
    }

    fn bump_space(&mut self) {
        while !self.eof() && is_pattern_white_space(self.char()) {
            self.bump();
        }
    }

    fn slice(&self, start: usize) -> String {
        self.chars[start..self.pos].iter().collect()
    }

    fn parse_identifier(&mut self) -> String {
        let start = self.pos;
        while !self.eof() && !is_white_space(self.char()) && !is_pattern_syntax(self.char()) {
            self.bump();
        }
        self.slice(start)
    }

    /// `closing`: inside a tag, so a `</` ends this message.
    fn parse_message(
        &mut self,
        nesting: usize,
        parent: Parent,
        closing: bool,
    ) -> Result<Vec<Element>, ParseError> {
        let mut elements = Vec::new();
        while !self.eof() {
            match self.char() {
                '{' => elements.push(self.parse_argument(nesting, closing)?),
                '}' if nesting > 0 => break,
                '#' if parent == Parent::Plural => {
                    self.bump();
                    elements.push(Element::Pound);
                }
                '<' if !self.ignore_tag && self.peek() == Some('/') => {
                    if closing {
                        break;
                    }
                    return Err("UNMATCHED_CLOSING_TAG");
                }
                '<' if !self.ignore_tag && is_alpha(self.peek()) => {
                    elements.push(self.parse_tag(nesting, parent)?)
                }
                _ => elements.push(Element::Literal(self.parse_literal(nesting, parent))),
            }
        }
        Ok(elements)
    }

    fn parse_tag(&mut self, nesting: usize, parent: Parent) -> Result<Element, ParseError> {
        self.bump();
        let name = self.parse_tag_name();
        self.bump_space();
        if self.bump_if("/>") {
            return Ok(Element::Literal(format!("<{name}/>")));
        }
        if !self.bump_if(">") {
            return Err("INVALID_TAG");
        }
        let children = self.parse_message(nesting + 1, parent, true)?;
        if !self.bump_if("</") {
            return Err("UNCLOSED_TAG");
        }
        if self.eof() || !self.char().is_ascii_alphabetic() {
            return Err("INVALID_TAG");
        }
        if self.parse_tag_name() != name {
            return Err("UNMATCHED_CLOSING_TAG");
        }
        self.bump_space();
        if !self.bump_if(">") {
            return Err("INVALID_TAG");
        }
        Ok(Element::Tag { name, children })
    }

    fn parse_tag_name(&mut self) -> String {
        let start = self.pos;
        self.bump();
        while !self.eof() && is_tag_name_char(self.char()) {
            self.bump();
        }
        self.slice(start)
    }

    fn parse_literal(&mut self, nesting: usize, parent: Parent) -> String {
        let mut value = String::new();
        loop {
            if let Some(quoted) = self.try_parse_quote(parent) {
                value.push_str(&quoted);
                continue;
            }
            if self.eof() {
                break;
            }
            let c = self.char();
            let tag =
                c == '<' && !self.ignore_tag && (is_alpha(self.peek()) || self.peek() == Some('/'));
            if tag
                || c == '{'
                || (c == '#' && parent == Parent::Plural)
                || (c == '}' && nesting > 0)
            {
                break;
            }
            self.bump();
            value.push(c);
        }
        value
    }

    /// An apostrophe quotes only before `{`, `}`, `<`, `>` (and `#` in a plural); `''` is one `'`.
    fn try_parse_quote(&mut self, parent: Parent) -> Option<String> {
        if self.eof() || self.char() != '\'' {
            return None;
        }
        match self.peek() {
            Some('\'') => {
                self.bump();
                self.bump();
                return Some("'".into());
            }
            Some('{' | '<' | '>' | '}') => {}
            Some('#') if parent == Parent::Plural => {}
            _ => return None,
        }
        self.bump();
        let mut out = String::from(self.char());
        self.bump();
        while !self.eof() {
            let c = self.char();
            if c == '\'' {
                if self.peek() == Some('\'') {
                    out.push('\'');
                    self.bump();
                } else {
                    self.bump();
                    break;
                }
            } else {
                out.push(c);
            }
            self.bump();
        }
        Some(out)
    }

    fn parse_argument(&mut self, nesting: usize, closing: bool) -> Result<Element, ParseError> {
        self.bump();
        self.bump_space();
        if self.eof() {
            return Err("EXPECT_ARGUMENT_CLOSING_BRACE");
        }
        if self.char() == '}' {
            return Err("EMPTY_ARGUMENT");
        }
        let name = self.parse_identifier();
        if name.is_empty() {
            return Err("MALFORMED_ARGUMENT");
        }
        self.bump_space();
        if self.eof() {
            return Err("EXPECT_ARGUMENT_CLOSING_BRACE");
        }
        match self.char() {
            '}' => {
                self.bump();
                Ok(Element::Argument(name))
            }
            ',' => {
                self.bump();
                self.bump_space();
                if self.eof() {
                    return Err("EXPECT_ARGUMENT_CLOSING_BRACE");
                }
                self.parse_argument_options(nesting, closing, name)
            }
            _ => Err("MALFORMED_ARGUMENT"),
        }
    }

    fn parse_argument_options(
        &mut self,
        nesting: usize,
        closing: bool,
        name: String,
    ) -> Result<Element, ParseError> {
        let kind = self.parse_identifier();
        match kind.as_str() {
            "" => Err("EXPECT_ARGUMENT_TYPE"),
            "number" | "date" | "time" => {
                self.bump_space();
                let mut style = None;
                if self.bump_if(",") {
                    self.bump_space();
                    let text = self.parse_simple_arg_style()?;
                    let text = text.trim_end().to_string();
                    if text.is_empty() {
                        return Err("EXPECT_ARGUMENT_STYLE");
                    }
                    style = Some(text);
                }
                self.parse_argument_close()?;
                if kind != "number" {
                    if style
                        .as_deref()
                        .is_some_and(|s| s.starts_with("::") && s[2..].trim_start().is_empty())
                    {
                        return Err("EXPECT_DATE_TIME_SKELETON");
                    }
                    return Ok(Element::DateTime(name));
                }
                let style = match style {
                    Some(s) if s.starts_with("::") => number_skeleton(s[2..].trim_start())?,
                    Some(s) => match s.as_str() {
                        "integer" => NumberStyle::Options(NumberOptions {
                            max_fraction: Some(0),
                            ..Default::default()
                        }),
                        "percent" => NumberStyle::Options(NumberOptions {
                            percent: true,
                            ..Default::default()
                        }),
                        "currency" => NumberStyle::Currency,
                        _ => NumberStyle::Options(NumberOptions::default()),
                    },
                    None => NumberStyle::Options(NumberOptions::default()),
                };
                Ok(Element::Number { name, style })
            }
            "plural" | "selectordinal" | "select" => {
                self.bump_space();
                if !self.bump_if(",") {
                    return Err("EXPECT_SELECT_ARGUMENT_OPTIONS");
                }
                self.bump_space();
                let mut first = self.parse_identifier();
                let mut offset = 0;
                if kind != "select" && first == "offset" {
                    if !self.bump_if(":") {
                        return Err("EXPECT_PLURAL_ARGUMENT_OFFSET_VALUE");
                    }
                    self.bump_space();
                    offset = self.parse_decimal_integer(
                        "EXPECT_PLURAL_ARGUMENT_OFFSET_VALUE",
                        "INVALID_PLURAL_ARGUMENT_OFFSET_VALUE",
                    )?;
                    self.bump_space();
                    first = self.parse_identifier();
                }
                let select = kind == "select";
                let parent = if select {
                    Parent::Select
                } else {
                    Parent::Plural
                };
                let options = self.parse_options(nesting, parent, closing, first)?;
                self.parse_argument_close()?;
                Ok(if select {
                    Element::Select { name, options }
                } else {
                    Element::Plural {
                        name,
                        offset,
                        ordinal: kind == "selectordinal",
                        options,
                    }
                })
            }
            _ => Err("INVALID_ARGUMENT_TYPE"),
        }
    }

    fn parse_argument_close(&mut self) -> Result<(), ParseError> {
        if self.eof() || self.char() != '}' {
            return Err("EXPECT_ARGUMENT_CLOSING_BRACE");
        }
        self.bump();
        Ok(())
    }

    /// ICU's simple argument style: up to the `}` that closes the argument. Like formatjs, a `}`
    /// that closes a nested `{` is re-read without advancing.
    fn parse_simple_arg_style(&mut self) -> Result<String, ParseError> {
        let start = self.pos;
        let mut nested = 0usize;
        while !self.eof() {
            match self.char() {
                '\'' => {
                    self.bump();
                    match self.chars[self.pos..].iter().position(|&c| c == '\'') {
                        Some(i) => self.pos += i,
                        None => {
                            self.pos = self.chars.len();
                            return Err("UNCLOSED_QUOTE_IN_ARGUMENT_STYLE");
                        }
                    }
                    self.bump();
                }
                '{' => {
                    nested += 1;
                    self.bump();
                }
                '}' if nested > 0 => nested -= 1,
                '}' => return Ok(self.slice(start)),
                _ => self.bump(),
            }
        }
        Ok(self.slice(start))
    }

    fn parse_options(
        &mut self,
        nesting: usize,
        parent: Parent,
        closing: bool,
        first: String,
    ) -> Result<Vec<(String, Vec<Element>)>, ParseError> {
        let select = parent == Parent::Select;
        let mut options: Vec<(String, Vec<Element>)> = Vec::new();
        let mut selector = first;
        loop {
            if selector.is_empty() {
                let start = self.pos;
                if !select && self.bump_if("=") {
                    self.parse_decimal_integer(
                        "EXPECT_PLURAL_ARGUMENT_SELECTOR",
                        "INVALID_PLURAL_ARGUMENT_SELECTOR",
                    )?;
                    selector = self.slice(start);
                } else {
                    break;
                }
            }
            if options.iter().any(|(key, _)| *key == selector) {
                return Err(if select {
                    "DUPLICATE_SELECT_ARGUMENT_SELECTOR"
                } else {
                    "DUPLICATE_PLURAL_ARGUMENT_SELECTOR"
                });
            }
            self.bump_space();
            if !self.bump_if("{") {
                return Err(if select {
                    "EXPECT_SELECT_ARGUMENT_SELECTOR_FRAGMENT"
                } else {
                    "EXPECT_PLURAL_ARGUMENT_SELECTOR_FRAGMENT"
                });
            }
            let fragment = self.parse_message(nesting + 1, parent, closing)?;
            self.parse_argument_close()?;
            options.push((selector, fragment));
            self.bump_space();
            selector = self.parse_identifier();
        }
        if options.is_empty() {
            return Err(if select {
                "EXPECT_SELECT_ARGUMENT_SELECTOR"
            } else {
                "EXPECT_PLURAL_ARGUMENT_SELECTOR"
            });
        }
        if !options.iter().any(|(key, _)| key == "other") {
            return Err("MISSING_OTHER_CLAUSE");
        }
        Ok(options)
    }

    fn parse_decimal_integer(
        &mut self,
        expect: ParseError,
        invalid: ParseError,
    ) -> Result<i64, ParseError> {
        let mut sign = 1;
        if !self.bump_if("+") && self.bump_if("-") {
            sign = -1;
        }
        let mut value: i64 = 0;
        let mut digits = false;
        while !self.eof() && self.char().is_ascii_digit() {
            digits = true;
            value = value
                .saturating_mul(10)
                .saturating_add(i64::from(self.char() as u8 - b'0'));
            self.bump();
        }
        if !digits {
            return Err(expect);
        }
        // Number.isSafeInteger
        if value > (1 << 53) - 1 {
            return Err(invalid);
        }
        Ok(value * sign)
    }
}

/// A `::` number skeleton, for the stems Relay can format. Stems formatjs would format
/// differently (currency, units, compact, scientific, significant digits, sign and rounding
/// modes) are rejected so the message falls back to English rather than reading wrong.
fn number_skeleton(skeleton: &str) -> Result<NumberStyle, ParseError> {
    const INVALID: ParseError = "INVALID_NUMBER_SKELETON";
    if skeleton.is_empty() {
        return Err(INVALID);
    }
    let mut options = NumberOptions::default();
    for token in skeleton
        .split(is_pattern_white_space)
        .filter(|t| !t.is_empty())
    {
        let mut parts = token.split('/');
        let stem = parts.next().unwrap_or("");
        let args: Vec<&str> = parts.collect();
        if args.iter().any(|a| a.is_empty()) {
            return Err(INVALID);
        }
        match stem {
            "percent" | "%" => options.percent = true,
            "%x100" => {
                options.percent = true;
                options.scale = Some(100.0);
            }
            "group-off" | ",_" => options.grouping = false,
            "precision-integer" | "." => options.max_fraction = Some(0),
            "notation-simple" => {}
            "scale" => {
                options.scale = args
                    .first()
                    .map(|a| parse_float(a))
                    .filter(|s| *s != 0.0 && !s.is_nan())
            }
            "integer-width" => {
                let [width] = args.as_slice() else {
                    return Err(INVALID);
                };
                let zeros = width
                    .strip_prefix('*')
                    .filter(|z| !z.is_empty() && z.chars().all(|c| c == '0'));
                options.min_integer = zeros.ok_or(INVALID)?.len();
            }
            _ if stem.chars().all(|c| c == '0') && !stem.is_empty() => {
                options.min_integer = stem.len()
            }
            _ if stem.starts_with('.') => {
                if !args.is_empty() {
                    return Err(INVALID);
                }
                let body = &stem[1..];
                let zeros = body.chars().take_while(|&c| c == '0').count();
                let rest = &body[zeros..];
                if zeros > 0 && rest == "*" {
                    options.min_fraction = Some(zeros);
                } else if zeros > 0 && rest.is_empty() {
                    options.min_fraction = Some(zeros);
                    options.max_fraction = Some(zeros);
                } else if !rest.is_empty() && rest.chars().all(|c| c == '#') {
                    if zeros > 0 {
                        options.min_fraction = Some(zeros);
                    }
                    options.max_fraction = Some(zeros + rest.len());
                } else {
                    return Err(INVALID);
                }
            }
            "currency" | "measure-unit" | "unit" | "compact-short" | "K" | "compact-long"
            | "KK" | "scientific" | "engineering" => return Err(INVALID),
            _ if stem.starts_with("unit-width-")
                || stem.starts_with("rounding-mode-")
                || stem.starts_with("sign-")
                || stem.starts_with(['@', '#', '+', '(', 'E'])
                || matches!(stem, "r" | "s") =>
            {
                return Err(INVALID);
            }
            _ => {}
        }
    }
    Ok(NumberStyle::Options(options))
}

/// JavaScript's `parseFloat`: the longest decimal prefix.
fn parse_float(text: &str) -> f64 {
    let text = text.trim_start();
    (1..=text.len())
        .rev()
        .filter(|&i| text.is_char_boundary(i))
        .find_map(|i| text[..i].parse().ok())
        .unwrap_or(f64::NAN)
}
