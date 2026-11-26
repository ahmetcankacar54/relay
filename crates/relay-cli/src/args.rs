//! Port of `cli/src/args.ts`, with Node's `util.parseArgs` (strict, positionals allowed) ported
//! alongside it so usage errors read exactly as Node words them.

use crate::io::{CliError, exit};

/// A flag's value: a string option's text, or a boolean option's `true`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FlagValue {
    Str(String),
    True,
}

/// The parsed flags, in the order they were first given (a JS object's key order).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Flags(Vec<(String, FlagValue)>);

impl Flags {
    pub fn get(&self, name: &str) -> Option<&FlagValue> {
        self.0.iter().find(|(n, _)| n == name).map(|(_, v)| v)
    }
    /// The flag's text when it is a string option.
    pub fn str(&self, name: &str) -> Option<&str> {
        match self.get(name) {
            Some(FlagValue::Str(s)) => Some(s),
            _ => None,
        }
    }
    /// `!!flags[name]`.
    pub fn truthy(&self, name: &str) -> bool {
        match self.get(name) {
            Some(FlagValue::True) => true,
            Some(FlagValue::Str(s)) => !s.is_empty(),
            None => false,
        }
    }
    /// `flags[name] === true`.
    pub fn is_true(&self, name: &str) -> bool {
        self.get(name) == Some(&FlagValue::True)
    }
    pub fn set(&mut self, name: &str, value: FlagValue) {
        match self.0.iter_mut().find(|(n, _)| n == name) {
            Some(slot) => slot.1 = value,
            None => self.0.push((name.to_owned(), value)),
        }
    }
    pub fn iter(&self) -> impl Iterator<Item = &(String, FlagValue)> {
        self.0.iter()
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ParsedCommand {
    pub command: Option<String>,
    pub positionals: Vec<String>,
    pub flags: Flags,
    /// What followed `--`, for `relay run`.
    pub rest: Vec<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Boolean,
    String,
}

/// `OPTIONS`: name, type, short alias.
const OPTIONS: &[(&str, Kind, Option<char>)] = &[
    ("yes", Kind::Boolean, Some('y')),
    ("json", Kind::Boolean, None),
    ("lang", Kind::String, None),
    ("no-color", Kind::Boolean, None),
    ("help", Kind::Boolean, Some('h')),
    ("version", Kind::Boolean, Some('v')),
    ("work", Kind::Boolean, None),
    ("group", Kind::String, None),
    ("org", Kind::String, None),
    ("new", Kind::Boolean, None),
    ("resume", Kind::Boolean, None),
    ("cancel", Kind::Boolean, None),
    ("poll-ms", Kind::String, None),
    ("accounts", Kind::String, None),
    ("days", Kind::String, None),
    ("account", Kind::String, None),
    ("port", Kind::String, None),
    ("host", Kind::String, None),
    ("provider", Kind::String, None),
    ("color", Kind::Boolean, None),
];

const GLOBAL: &[&str] = &["yes", "lang", "no-color", "help", "version"];

/// The flags each command takes, beside the global ones.
pub fn command_flags(command: &str) -> Option<&'static [&'static str]> {
    Some(match command {
        "status" | "list" | "ls" => &["json"],
        "add" => &[
            "work", "group", "org", "new", "resume", "cancel", "poll-ms", "provider",
        ],
        "switch" | "remove" | "rename" | "recover" | "connect" | "run" | "reset-vault" | "help"
        | "__worker" => &[],
        "history" => &["json", "accounts"],
        "usage" | "doctor" => &["json"],
        "tokens" => &["json", "days", "account"],
        "proxy" => &["json", "port", "host"],
        "statusline" => &["color"],
        _ => return None,
    })
}

fn option(name: &str) -> Option<Kind> {
    OPTIONS
        .iter()
        .find(|(n, _, _)| *n == name)
        .map(|(_, k, _)| *k)
}

fn long_for_short(short: &str) -> String {
    OPTIONS
        .iter()
        .find(|(_, _, s)| s.is_some_and(|c| short.chars().eq([c])))
        .map(|(n, _, _)| (*n).to_owned())
        .unwrap_or_else(|| short.to_owned())
}

fn short_of(name: &str) -> Option<char> {
    OPTIONS
        .iter()
        .find(|(n, _, _)| *n == name)
        .and_then(|(_, _, s)| *s)
}

struct Token {
    name: String,
    raw_name: String,
    value: Option<String>,
    inline_value: bool,
}

enum Parsed {
    Option(Token),
    Positional(String),
}

/// `JSON.stringify(text)`.
fn json_string(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_default()
}

fn usage(message: String) -> CliError {
    CliError::new(message, exit::USAGE)
}

/// The tokens `util.parseArgs` makes of `args`.
fn tokenize(args: &[String]) -> Vec<Parsed> {
    let mut tokens = Vec::new();
    let mut remaining: std::collections::VecDeque<String> = args.iter().cloned().collect();
    while let Some(arg) = remaining.pop_front() {
        let chars: Vec<char> = arg.chars().collect();
        let starts_dash = chars.first() == Some(&'-');
        if chars.len() == 2 && starts_dash && chars[1] != '-' {
            // A lone short option: `-f`.
            let short = chars[1].to_string();
            let name = long_for_short(&short);
            let mut value = None;
            if option(&name) == Some(Kind::String) && !remaining.is_empty() {
                value = remaining.pop_front();
            }
            tokens.push(Parsed::Option(Token {
                name,
                raw_name: arg,
                value,
                inline_value: false,
            }));
            continue;
        }
        if chars.len() > 2 && starts_dash && chars[1] != '-' {
            let name = long_for_short(&chars[1].to_string());
            if option(&name) != Some(Kind::String) {
                // A short group: `-abc` is `-a -b -c`; a string option in the middle takes the rest.
                let mut expanded = Vec::new();
                for index in 1..chars.len() {
                    let short = chars[index].to_string();
                    let long = long_for_short(&short);
                    if option(&long) != Some(Kind::String) || index == chars.len() - 1 {
                        expanded.push(format!("-{short}"));
                    } else {
                        expanded.push(format!("-{}", chars[index..].iter().collect::<String>()));
                        break;
                    }
                }
                for item in expanded.into_iter().rev() {
                    remaining.push_front(item);
                }
                continue;
            }
            // A short option and its value: `-fVALUE`.
            tokens.push(Parsed::Option(Token {
                name,
                raw_name: format!("-{}", chars[1]),
                value: Some(chars[2..].iter().collect()),
                inline_value: true,
            }));
            continue;
        }
        if chars.len() > 2 && arg.starts_with("--") {
            match arg.as_bytes()[3..].iter().position(|b| *b == b'=') {
                None => {
                    let name = arg[2..].to_owned();
                    let mut value = None;
                    if option(&name) == Some(Kind::String) && !remaining.is_empty() {
                        value = remaining.pop_front();
                    }
                    tokens.push(Parsed::Option(Token {
                        name,
                        raw_name: arg,
                        value,
                        inline_value: false,
                    }));
                }
                Some(_) => {
                    let equal = arg.find('=').unwrap_or(2);
                    let name = arg[2..equal].to_owned();
                    tokens.push(Parsed::Option(Token {
                        raw_name: format!("--{name}"),
                        name,
                        value: Some(arg[equal + 1..].to_owned()),
                        inline_value: true,
                    }));
                }
            }
            continue;
        }
        tokens.push(Parsed::Positional(arg));
    }
    tokens
}

/// `util.parseArgs({ args, options: OPTIONS, allowPositionals: true, strict: true })`.
fn parse_args(args: &[String]) -> Result<(Vec<String>, Flags), CliError> {
    let mut positionals = Vec::new();
    let mut flags = Flags::default();
    for token in tokenize(args) {
        match token {
            Parsed::Positional(value) => positionals.push(value),
            Parsed::Option(token) => {
                let Some(kind) = option(&token.name) else {
                    return Err(usage(format!(
                        "Unknown option '{}'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- {}",
                        token.raw_name,
                        json_string(&token.raw_name)
                    )));
                };
                let short_and_long = match short_of(&token.name) {
                    Some(short) => format!("-{short}, --{}", token.name),
                    None => format!("--{}", token.name),
                };
                if kind == Kind::String && token.value.is_none() {
                    return Err(usage(format!(
                        "Option '{short_and_long} <value>' argument missing"
                    )));
                }
                if kind == Kind::Boolean && token.value.is_some() {
                    return Err(usage(format!(
                        "Option '{short_and_long}' does not take an argument"
                    )));
                }
                if let Some(value) = &token.value
                    && !token.inline_value
                    && value.chars().count() > 1
                    && value.starts_with('-')
                {
                    let raw = &token.raw_name;
                    let example = if raw.starts_with("--") {
                        format!("'{raw}=-XYZ'")
                    } else {
                        format!("'--{}=-XYZ' or '{raw}-XYZ'", token.name)
                    };
                    return Err(usage(format!(
                        "Option '{raw}' argument is ambiguous.\nDid you forget to specify the option argument for '{raw}'?\nTo specify an option argument starting with a dash use {example}."
                    )));
                }
                flags.set(
                    &token.name,
                    match token.value {
                        Some(v) => FlagValue::Str(v),
                        None => FlagValue::True,
                    },
                );
            }
        }
    }
    Ok((positionals, flags))
}

pub fn parse_command(argv: &[String]) -> Result<ParsedCommand, CliError> {
    let split = argv.iter().position(|a| a == "--");
    let (own, rest) = match split {
        Some(at) => (&argv[..at], argv[at + 1..].to_vec()),
        None => (argv, Vec::new()),
    };
    let (mut positionals, flags) = parse_args(own)?;
    let command = if positionals.is_empty() {
        None
    } else {
        Some(positionals.remove(0))
    };
    if let Some(command) = &command
        && let Some(allowed) = command_flags(command)
    {
        for (name, _) in flags.iter() {
            if !GLOBAL.contains(&name.as_str()) && !allowed.contains(&name.as_str()) {
                return Err(usage(format!("relay {command} does not take --{name}.")));
            }
        }
    }
    if !rest.is_empty() && command.as_deref() != Some("run") {
        return Err(usage("Only relay run takes arguments after --.".into()));
    }
    Ok(ParsedCommand {
        command,
        positionals,
        flags,
        rest,
    })
}
