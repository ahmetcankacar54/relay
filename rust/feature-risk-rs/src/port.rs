//! The Rust port of `shared/feature-risk.ts`, delegating to `relay_core::shared::feature_risk`.
//!
//! `requireRiskAck` (it takes a callback) and `RiskNotAcknowledged` (a class) stay in TypeScript;
//! `relay_core::shared::feature_risk::require_risk_ack` is covered by relay-core's own tests.
//!
//! relay-core takes typed values (`FeatureRiskId`, `PoolAccount`, `MeterProvider`, ...). The
//! functions here take whatever JSON the caller sends and turn it into those types the way the TS
//! source reads it: a property of `null` or `undefined` throws, `x.includes` is
//! `Array.prototype.includes` (SameValueZero) on an array and a substring test on a string,
//! `for…of` and spreads walk an array or a string's code points, and a value is read only when the
//! TS source gets to it. Two kinds of value do not fit relay-core's types and are carried around
//! it: account ids that are not strings (a private key stands for each and maps back to it), and
//! meters that are not providers (`meter-${m}` and `pending.includes` are applied as JS does).

#![forbid(unsafe_code)]

use std::collections::HashMap;

use relay_core::shared::feature_risk::{
    self as fr, FEATURE_RISK_IDS, FeatureRiskId, FeaturesInUse, GatewayInUse, GatewayRiskConfig,
    PoolAccount, ProxyRiskConfig, ProxyRiskPatch, RiskAcknowledgements, TurnOffStep,
};
use relay_core::shared::meters::{METER_PROVIDERS, MeterProvider};
use relay_core::shared::proxy_types::ProxyClientId;
use relay_core::shared::types::js::{number_string, number_value};
use serde_json::{Map, Value};

use crate::js;

// ---- JS values ------------------------------------------------------------------------------

/// A value received from JS, with `index.cjs`'s markers (`undefined`, `NaN`, lone surrogates) read.
enum Js<'a> {
    Undefined,
    Null,
    Bool(bool),
    Num(f64),
    Str(Vec<u16>),
    Array(&'a [Value]),
    Object(&'a Map<String, Value>),
}

/// `None` is a missing property: `undefined`.
fn js_of(value: Option<&Value>) -> Js<'_> {
    let Some(value) = value else {
        return Js::Undefined;
    };
    if js::is_undefined(value) {
        return Js::Undefined;
    }
    if let Some(n) = js::as_number(value) {
        return Js::Num(n);
    }
    if let Some(units) = js::string_units(value) {
        return Js::Str(units);
    }
    match value {
        Value::Bool(b) => Js::Bool(*b),
        Value::Array(items) => Js::Array(items),
        Value::Object(o) => Js::Object(o),
        _ => Js::Null,
    }
}

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

fn read_error(value: Option<&Value>, key: &str) -> String {
    let what = if matches!(js_of(value), Js::Null) {
        "null"
    } else {
        "undefined"
    };
    format!("TypeError: Cannot read properties of {what} (reading '{key}')")
}

/// `value.key` for a property name that is not an array index: an object's own property, else
/// `undefined`; on `null` or `undefined` it throws.
fn prop<'a>(value: Option<&'a Value>, key: &str) -> Result<Option<&'a Value>, String> {
    match js_of(value) {
        Js::Undefined | Js::Null => Err(read_error(value, key)),
        Js::Object(o) => Ok(o.get(key).filter(|v| !js::is_undefined(v))),
        _ => Ok(None),
    }
}

/// `value[key]` for any key, as `riskAcknowledged?.[id]` reads it: `undefined` on `null` or
/// `undefined`, array and string elements by index, and their `length`.
fn element(value: Option<&Value>, key: &[u16]) -> Option<Value> {
    let index = String::from_utf16(key).ok().filter(|k| {
        k.bytes().all(|b| b.is_ascii_digit())
            && (k == "0" || (!k.is_empty() && !k.starts_with('0')))
    });
    let index = index.and_then(|k| k.parse::<u32>().ok().filter(|&i| i != u32::MAX));
    let index = index.and_then(|i| usize::try_from(i).ok());
    let length = key == units("length").as_slice();
    match js_of(value) {
        Js::Object(o) => String::from_utf16(key)
            .ok()
            .and_then(|k| o.get(&k))
            .filter(|v| !js::is_undefined(v))
            .cloned(),
        Js::Array(items) if length => Some(Value::from(items.len())),
        Js::Array(items) => index
            .and_then(|i| items.get(i))
            .filter(|v| !js::is_undefined(v))
            .cloned(),
        Js::Str(text) if length => Some(Value::from(text.len())),
        Js::Str(text) => index
            .and_then(|i| text.get(i))
            .map(|u| js::utf16_string(&[*u])),
        _ => None,
    }
}

fn truthy(value: Option<&Value>) -> bool {
    match js_of(value) {
        Js::Undefined | Js::Null => false,
        Js::Bool(b) => b,
        Js::Num(n) => n != 0.0 && !n.is_nan(),
        Js::Str(text) => !text.is_empty(),
        Js::Array(_) | Js::Object(_) => true,
    }
}

/// `String(value)`, as a template literal or a property key prints it.
fn to_string_units(value: Option<&Value>) -> Vec<u16> {
    match js_of(value) {
        Js::Undefined => units("undefined"),
        Js::Null => units("null"),
        Js::Bool(b) => units(if b { "true" } else { "false" }),
        Js::Num(n) => units(&number_string(n)),
        Js::Str(text) => text,
        Js::Array(items) => {
            let mut out = Vec::new();
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(u16::from(b','));
                }
                if !matches!(js_of(Some(item)), Js::Undefined | Js::Null) {
                    out.extend(to_string_units(Some(item)));
                }
            }
            out
        }
        Js::Object(_) => units("[object Object]"),
    }
}

/// `Number(value)`, as `accepted < textVersion` compares it.
fn to_number(value: &Value) -> f64 {
    match js_of(Some(value)) {
        Js::Undefined => f64::NAN,
        Js::Null => 0.0,
        Js::Bool(b) => f64::from(u8::from(b)),
        Js::Num(n) => n,
        _ => number_value(&String::from_utf16_lossy(&to_string_units(Some(value)))),
    }
}

/// SameValueZero, as `Array.prototype.includes` compares. Every JSON object or array is a
/// distinct JS object, so none equals another.
fn same_value_zero(a: &Value, b: &Value) -> bool {
    match (js_of(Some(a)), js_of(Some(b))) {
        (Js::Undefined, Js::Undefined) | (Js::Null, Js::Null) => true,
        (Js::Bool(x), Js::Bool(y)) => x == y,
        (Js::Num(x), Js::Num(y)) => x == y || (x.is_nan() && y.is_nan()),
        (Js::Str(x), Js::Str(y)) => x == y,
        _ => false,
    }
}

fn contains_units(haystack: &[u16], needle: &[u16]) -> bool {
    needle.is_empty() || haystack.windows(needle.len()).any(|w| w == needle)
}

/// The receiver of `x.includes(…)`: an array (SameValueZero) or a string (a substring test).
enum Includes<'a> {
    Array(&'a [Value]),
    Str(Vec<u16>),
}

impl<'a> Includes<'a> {
    fn of(value: Option<&'a Value>, name: &str) -> Result<Self, String> {
        match js_of(value) {
            Js::Array(items) => Ok(Includes::Array(items)),
            Js::Str(text) => Ok(Includes::Str(text)),
            Js::Undefined | Js::Null => Err(read_error(value, "includes")),
            _ => Err(format!("TypeError: {name}.includes is not a function")),
        }
    }

    fn has(&self, needle: &Value) -> bool {
        match self {
            Includes::Array(items) => items.iter().any(|x| same_value_zero(x, needle)),
            Includes::Str(text) => contains_units(text, &to_string_units(Some(needle))),
        }
    }

    fn has_units(&self, needle: &[u16]) -> bool {
        match self {
            Includes::Array(items) => items
                .iter()
                .any(|x| matches!(js_of(Some(x)), Js::Str(text) if text == needle)),
            Includes::Str(text) => contains_units(text, needle),
        }
    }

    fn has_str(&self, needle: &str) -> bool {
        self.has_units(&units(needle))
    }

    /// The risk ids this `includes` answers true for, in relay-core's order.
    fn risk_ids(&self) -> Vec<FeatureRiskId> {
        FEATURE_RISK_IDS
            .into_iter()
            .filter(|id| self.has_str(id.as_str()))
            .collect()
    }
}

/// `[...value]` or `for (const x of value)`: an array's elements or a string's code points.
fn iterate(value: Option<&Value>, name: &str) -> Result<Vec<Value>, String> {
    match js_of(value) {
        Js::Array(items) => Ok(items.to_vec()),
        Js::Str(text) => {
            let mut out = Vec::new();
            let mut i = 0;
            while i < text.len() {
                let pair = (0xd800..0xdc00).contains(&text[i])
                    && text
                        .get(i + 1)
                        .is_some_and(|u| (0xdc00..0xe000).contains(u));
                let n = if pair { 2 } else { 1 };
                out.push(js::utf16_string(&text[i..i + n]));
                i += n;
            }
            Ok(out)
        }
        _ => Err(format!("TypeError: {name} is not iterable")),
    }
}

/// `value.filter`, `.some` or `.map`: arrays have them, nothing else sent here does.
fn array<'a>(value: Option<&'a Value>, name: &str) -> Result<&'a [Value], String> {
    match js_of(value) {
        Js::Array(items) => Ok(items),
        Js::Undefined | Js::Null => Err(read_error(value, name)),
        _ => Err(format!("TypeError: {name} is not a function")),
    }
}

/// `host.trim()`: only a string has it.
fn host_of(value: Option<&Value>) -> Result<String, String> {
    match js_of(value) {
        Js::Str(text) => Ok(String::from_utf16_lossy(&text)),
        Js::Undefined | Js::Null => Err(read_error(value, "trim")),
        _ => Err("TypeError: host.trim is not a function".into()),
    }
}

// ---- conversions to relay-core's types ------------------------------------------------------

fn names(ids: Vec<FeatureRiskId>) -> Vec<Value> {
    ids.into_iter().map(|id| Value::from(id.as_str())).collect()
}

/// `FEATURE_RISKS[id]` exists only for a risk id (the key is `String(id)`).
fn risk_id(value: &Value) -> Option<FeatureRiskId> {
    String::from_utf16(&to_string_units(Some(value)))
        .ok()
        .and_then(|key| FeatureRiskId::parse(&key))
}

/// An accepted text version as relay-core holds it (`i64`). `floor` keeps `accepted < v` for
/// every integer `v`; `NaN` (never less) and `+∞` become `i64::MAX`, `-∞` `i64::MIN`.
fn text_version(accepted: &Value) -> i64 {
    let n = to_number(accepted);
    if n.is_nan() {
        i64::MAX
    } else {
        // `as` saturates the infinities.
        n.floor() as i64
    }
}

/// The meter a value is, when it is exactly a provider's name.
fn meter_provider(value: &Value) -> Option<MeterProvider> {
    value.as_str().and_then(MeterProvider::parse)
}

/// `meter-${value}` for a value that is not a provider: no `FeatureRiskId` holds it.
fn meter_risk_units(value: &Value) -> Vec<u16> {
    [units("meter-"), to_string_units(Some(value))].concat()
}

/// `clientRisks` tells `"omp"` and `"codex"` apart and reads anything else as Claude Code.
fn client_id(value: &Value) -> ProxyClientId {
    match value.as_str() {
        Some("omp") => ProxyClientId::Omp,
        Some("codex") => ProxyClientId::Codex,
        _ => ProxyClientId::ClaudeCode,
    }
}

/// `config.boundClients ?? []`, walked by `for…of`.
fn bound_clients(value: Option<&Value>) -> Result<Vec<ProxyClientId>, String> {
    Ok(match js_of(value) {
        Js::Undefined | Js::Null => Vec::new(),
        _ => iterate(value, "config.boundClients")?
            .iter()
            .map(client_id)
            .collect(),
    })
}

/// Account ids as relay-core's strings. JS compares ids with SameValueZero: a string id is its own
/// key; any other value (and a string that starts with the mark) gets a key that starts with the
/// mark, U+FFFF (a noncharacter), and maps back to the value sent.
#[derive(Default)]
struct Ids {
    values: HashMap<String, Value>,
    objects: usize,
}

const MARK: char = '\u{ffff}';

impl Ids {
    fn key(&mut self, value: Option<&Value>) -> String {
        let tag = match js_of(value) {
            Js::Str(text) => match String::from_utf16(&text) {
                Ok(s) if !s.starts_with(MARK) => return s,
                _ => format!("s{text:?}"),
            },
            // `number_string` prints `-0` as `0`: SameValueZero holds them equal, and NaN equal
            // to NaN.
            Js::Num(n) => format!("n{}", number_string(n)),
            Js::Bool(b) => format!("b{b}"),
            Js::Null => "null".into(),
            Js::Undefined => "undefined".into(),
            Js::Array(_) | Js::Object(_) => {
                self.objects += 1;
                format!("o{}", self.objects)
            }
        };
        let key = format!("{MARK}{tag}");
        self.values
            .entry(key.clone())
            .or_insert_with(|| value.cloned().unwrap_or_else(js::undefined));
        key
    }

    fn value(&self, key: &str) -> Value {
        self.values
            .get(key)
            .cloned()
            .unwrap_or_else(|| Value::from(key))
    }
}

/// `accounts` as relay-core's `PoolAccount`s. A `null` or `undefined` element stands in as an
/// empty account; `nullish` says where the first one is (JS throws once it reads it).
struct Accounts {
    pool: Vec<PoolAccount>,
    raw_ids: Vec<Value>,
    nullish: Option<usize>,
}

impl Accounts {
    fn read(value: Option<&Value>, name: &str, ids: &mut Ids) -> Result<Self, String> {
        let items = array(value, name)?;
        let mut accounts = Accounts {
            pool: Vec::with_capacity(items.len()),
            raw_ids: Vec::with_capacity(items.len()),
            nullish: None,
        };
        for (i, item) in items.iter().enumerate() {
            if matches!(js_of(Some(item)), Js::Undefined | Js::Null) {
                accounts.nullish.get_or_insert(i);
                accounts.pool.push(PoolAccount::default());
                accounts.raw_ids.push(js::undefined());
                continue;
            }
            let id = prop(Some(item), "id")?;
            // A provider that is not a string is not "antigravity", as `?? "claude"` and `===` read it.
            let provider = prop(Some(item), "provider")?.and_then(Value::as_str);
            accounts.pool.push(PoolAccount::new(ids.key(id), provider));
            accounts
                .raw_ids
                .push(id.cloned().unwrap_or_else(js::undefined));
        }
        Ok(accounts)
    }

    /// `accounts.filter(…)` reads every account: a `null` one throws.
    fn all(&self) -> Result<(), String> {
        match self.nullish {
            Some(i) => Err(format!(
                "TypeError: Cannot read properties of null (reading 'id') at accounts[{i}]"
            )),
            None => Ok(()),
        }
    }

    fn keys(&self) -> Vec<String> {
        self.pool.iter().map(|a| a.id.clone()).collect()
    }
}

/// An exclusion list as `poolProviders` reads it (`excluded.includes(a.id)` for each account):
/// the keys of the ids it answers true for, `None` for `undefined` (the default `[]`). Anything
/// without `includes` throws, but only once there is an account to ask about.
fn exclusion(
    excluded: Option<&Value>,
    accounts: &Accounts,
    ids: &mut Ids,
) -> Result<Option<Vec<String>>, String> {
    match js_of(excluded) {
        Js::Undefined => Ok(None),
        Js::Array(items) => Ok(Some(items.iter().map(|x| ids.key(Some(x))).collect())),
        Js::Str(text) => Ok(Some(
            accounts
                .pool
                .iter()
                .zip(&accounts.raw_ids)
                .filter(|(_, raw)| contains_units(&text, &to_string_units(Some(raw))))
                .map(|(a, _)| a.id.clone())
                .collect(),
        )),
        _ if accounts.pool.is_empty() => Ok(None),
        _ => Includes::of(excluded, "excluded").map(|_| None),
    }
}

// ---- the functions --------------------------------------------------------------------------

/// Port of `needsRiskAck` (`shared/feature-risk.ts:194`).
pub fn needs_risk_ack(settings: Value, id: Value) -> Result<bool, String> {
    let acked = prop(Some(&settings), "riskAcknowledged")?;
    let key = to_string_units(Some(&id));
    let accepted = element(acked, &key);
    match risk_id(&id) {
        Some(id) => {
            let acks: Option<RiskAcknowledgements> =
                accepted.map(|v| [(id, text_version(&v))].into_iter().collect());
            Ok(fr::needs_risk_ack(acks.as_ref(), id))
        }
        // `FEATURE_RISKS[id]` is undefined: JS throws reading its `textVersion`, unless nothing
        // was accepted under that key.
        None if accepted.is_none() => Ok(true),
        None => {
            Err("TypeError: Cannot read properties of undefined (reading 'textVersion')".into())
        }
    }
}

/// Port of `pendingRisks` (`shared/feature-risk.ts:203`).
pub fn pending_risks(settings: Value, ids: Value) -> Result<Vec<Value>, String> {
    let asked = Includes::of(Some(&ids), "ids")?.risk_ids();
    // `settings` is read only for an id `ids` holds.
    let acks: Option<RiskAcknowledgements> = if asked.is_empty() {
        None
    } else {
        let acked = prop(Some(&settings), "riskAcknowledged")?;
        Some(
            asked
                .iter()
                .filter_map(|&id| {
                    element(acked, &units(id.as_str())).map(|v| (id, text_version(&v)))
                })
                .collect(),
        )
    };
    Ok(names(fr::pending_risks(acks.as_ref(), &asked)))
}

/// Port of `acknowledgeRisks` (`shared/feature-risk.ts:213`): `{ ...acks }` keeps every key sent,
/// and relay-core's acknowledgements of `ids` are assigned over it.
pub fn acknowledge_risks(acks: Value, ids: Value) -> Result<Value, String> {
    let ids = iterate(Some(&ids), "ids")?
        .iter()
        .map(|id| {
            risk_id(id).ok_or_else(|| {
                "TypeError: Cannot read properties of undefined (reading 'textVersion')".to_string()
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut next: Map<String, Value> = match js_of(Some(&acks)) {
        Js::Object(o) => o.clone(),
        Js::Array(items) => items
            .iter()
            .enumerate()
            .map(|(i, x)| (i.to_string(), x.clone()))
            .collect(),
        Js::Str(text) => text
            .iter()
            .enumerate()
            .map(|(i, u)| (i.to_string(), js::utf16_string(&[*u])))
            .collect(),
        _ => Map::new(),
    };
    for (id, version) in fr::acknowledge_risks(None, &ids) {
        next.insert(id.as_str().into(), Value::from(version));
    }
    Ok(Value::Object(next))
}

/// Port of `gatewayRisks` (`shared/feature-risk.ts:244`).
pub fn gateway_risks(config: Value, accounts: Value) -> Result<Vec<Value>, String> {
    let mut ids = Ids::default();
    let excluded = prop(Some(&config), "excludedAccountIds")?;
    let accounts = Accounts::read(Some(&accounts), "accounts.filter", &mut ids)?;
    accounts.all()?;
    let excluded = exclusion(excluded, &accounts, &mut ids)?;
    let host = host_of(prop(Some(&config), "host")?)?;
    let bound = bound_clients(prop(Some(&config), "boundClients")?)?;
    let config = GatewayRiskConfig {
        host: &host,
        excluded_account_ids: excluded.as_deref(),
        bound_clients: Some(&bound),
    };
    Ok(names(fr::gateway_risks(&config, &accounts.pool)))
}

/// Port of `proxyPatchRisks` (`shared/feature-risk.ts:265`).
pub fn proxy_patch_risks(
    config: Value,
    patch: Value,
    accounts: Value,
) -> Result<Vec<Value>, String> {
    let patch_host = match prop(Some(&patch), "host")? {
        None => None,
        Some(host) => Some(host_of(Some(host))?),
    };
    let enabled = truthy(prop(Some(&config), "enabled")?);
    let patch_excluded = prop(Some(&patch), "excludedAccountIds")?;
    // `config.host` is never read.
    let run =
        |excluded: Option<&[String]>, patch_excluded: Option<&[String]>, pool: &[PoolAccount]| {
            let config = ProxyRiskConfig {
                enabled,
                host: "",
                excluded_account_ids: excluded,
            };
            let patch = ProxyRiskPatch {
                host: patch_host.as_deref(),
                excluded_account_ids: patch_excluded,
            };
            fr::proxy_patch_risks(&config, &patch, pool)
        };
    if !enabled || patch_excluded.is_none() {
        // The accounts and both exclusion lists are read only past these two.
        return Ok(names(run(None, None, &[])));
    }
    let mut ids = Ids::default();
    let accounts = Accounts::read(Some(&accounts), "accounts.filter", &mut ids)?;
    accounts.all()?;
    let patch_excluded = exclusion(patch_excluded, &accounts, &mut ids)?;
    let excluded = exclusion(
        prop(Some(&config), "excludedAccountIds")?,
        &accounts,
        &mut ids,
    );
    let risks = match excluded {
        Ok(excluded) => run(
            excluded.as_deref(),
            patch_excluded.as_deref(),
            &accounts.pool,
        ),
        Err(error) => {
            // The gateway's own list is read only once the patch's pool holds an Antigravity
            // account; with every account excluded from the current pool, that alone decides.
            let all = accounts.keys();
            let risks = run(Some(&all), patch_excluded.as_deref(), &accounts.pool);
            if risks.contains(&FeatureRiskId::AntigravityGateway) {
                return Err(error);
            }
            risks
        }
    };
    Ok(names(risks))
}

/// Port of `clientRisks` (`shared/feature-risk.ts:288`).
pub fn client_risks(id: String) -> Result<Vec<Value>, String> {
    Ok(names(fr::client_risks(client_id(&Value::from(id)))))
}

/// Port of `antigravityAccountRisks` (`shared/feature-risk.ts:294`).
pub fn antigravity_account_risks(gateway_on: bool) -> Result<Vec<Value>, String> {
    Ok(names(fr::antigravity_account_risks(gateway_on)))
}

/// Port of `planningRisks` (`shared/feature-risk.ts:300`).
pub fn planning_risks(before: Value, patch: Value) -> Result<Vec<Value>, String> {
    let turns_on = matches!(prop(Some(&patch), "autoStart")?, Some(Value::Bool(true)));
    // `before.autoStart` is read only after `patch.autoStart === true`.
    let before = turns_on && truthy(prop(Some(&before), "autoStart")?);
    Ok(names(fr::planning_risks(before, Some(turns_on))))
}

/// Port of `meterRisk` (`shared/feature-risk.ts:307`).
pub fn meter_risk(provider: Value) -> Result<Value, String> {
    Ok(match meter_provider(&provider) {
        Some(provider) => Value::from(fr::meter_risk(provider).as_str()),
        None => js::utf16_string(&meter_risk_units(&provider)),
    })
}

/// Port of `meterRisks` (`shared/feature-risk.ts:311`).
pub fn meter_risks(before: Value, after: Value) -> Result<Vec<Value>, String> {
    let after = match js_of(Some(&after)) {
        Js::Undefined | Js::Null => return Ok(Vec::new()),
        _ => array(Some(&after), "(after ?? []).filter")?,
    };
    if after.is_empty() {
        return Ok(Vec::new());
    }
    // `before?.includes(p)`, called for each meter of `after`.
    let before = match js_of(Some(&before)) {
        Js::Undefined | Js::Null => None,
        _ => Some(Includes::of(Some(&before), "before")?),
    };
    let before_providers: Option<Vec<MeterProvider>> = before.as_ref().map(|b| {
        METER_PROVIDERS
            .into_iter()
            .filter(|p| b.has_str(p.as_str()))
            .collect()
    });
    let mut out = Vec::new();
    for meter in after {
        match meter_provider(meter) {
            Some(provider) => out.extend(names(fr::meter_risks(
                before_providers.as_deref(),
                Some(&[provider]),
            ))),
            None if !before.as_ref().is_some_and(|b| b.has(meter)) => {
                out.push(js::utf16_string(&meter_risk_units(meter)));
            }
            None => {}
        }
    }
    Ok(out)
}

/// Port of `enabledRisks` (`shared/feature-risk.ts:337`).
pub fn enabled_risks(state: Value) -> Result<Vec<Value>, String> {
    let state = Some(&state);
    let mut ids = Ids::default();
    let early_start = truthy(prop(state, "earlyStart")?);
    // `meter-${m}` outlives the final filter only for a provider's name.
    let meters = match js_of(prop(state, "meters")?) {
        Js::Undefined | Js::Null => None,
        _ => Some(
            array(prop(state, "meters")?, "(state.meters ?? []).map")?
                .iter()
                .filter_map(|m| {
                    MeterProvider::parse(&String::from_utf16_lossy(&to_string_units(Some(m))))
                })
                .collect(),
        ),
    };
    let accounts = Accounts::read(prop(state, "accounts")?, "state.accounts.some", &mut ids)?;
    let gateway = prop(state, "gateway")?;
    let on = !matches!(js_of(gateway), Js::Undefined | Js::Null) && truthy(prop(gateway, "on")?);
    if let Some(bad) = accounts.nullish {
        // `accounts.some(…)` stops at the first Antigravity account; `gatewayRisks` reads them all.
        let stopped = accounts.pool[..bad]
            .iter()
            .any(|a| a.provider.as_deref() == Some("antigravity"));
        if on || !stopped {
            accounts.all()?;
        }
    }
    let gateway = if on {
        let excluded = exclusion(prop(gateway, "excludedAccountIds")?, &accounts, &mut ids)?;
        Some(GatewayInUse {
            on: true,
            host: host_of(prop(gateway, "host")?)?,
            excluded_account_ids: excluded,
            bound_clients: bound_clients(prop(gateway, "boundClients")?)?,
        })
    } else {
        None
    };
    let state = FeaturesInUse {
        early_start,
        accounts: accounts.pool,
        gateway,
        meters,
    };
    Ok(names(fr::enabled_risks(&state)))
}

/// Port of `turnOffSteps` (`shared/feature-risk.ts:365`).
pub fn turn_off_steps(pending: Value, state: Value) -> Result<Vec<Value>, String> {
    let state = Some(&state);
    let mut ids = Ids::default();
    let gateway = prop(state, "gateway")?;
    let accounts = Accounts::read(prop(state, "accounts")?, "state.accounts.filter", &mut ids)?;
    accounts.all()?;
    let on = !matches!(js_of(gateway), Js::Undefined | Js::Null) && truthy(prop(gateway, "on")?);
    // `pending.includes("early-start")` runs whatever else does.
    let pending = Includes::of(Some(&pending), "pending")?;
    let pending_ids = pending.risk_ids();
    let meters = match js_of(prop(state, "meters")?) {
        Js::Undefined | Js::Null => &[][..],
        _ => array(prop(state, "meters")?, "meters.some")?,
    };

    let mut clients_raw = Vec::new();
    let mut excluded_text = None;
    let gateway = if on {
        clients_raw = iterate(prop(gateway, "boundClients")?, "gateway.boundClients")?;
        let declined = |id| pending_ids.contains(&id);
        // `gateway.excludedAccountIds ?? []` is read only for this step.
        let reads_excluded = !declined(FeatureRiskId::GatewayClaude)
            && !declined(FeatureRiskId::GatewayCodex)
            && declined(FeatureRiskId::AntigravityGateway);
        let excluded_value = prop(gateway, "excludedAccountIds")?;
        let excluded = match js_of(excluded_value) {
            _ if !reads_excluded => None,
            Js::Undefined | Js::Null => None,
            Js::Str(text) => {
                excluded_text = Some(text);
                Some(Vec::new())
            }
            _ => Some(
                iterate(excluded_value, "gateway.excludedAccountIds")?
                    .iter()
                    .map(|x| ids.key(Some(x)))
                    .collect(),
            ),
        };
        Some(GatewayInUse {
            on: true,
            // `turnOffSteps` moves the gateway to the default host; it never reads this one.
            host: String::new(),
            excluded_account_ids: excluded,
            bound_clients: clients_raw.iter().map(client_id).collect(),
        })
    } else {
        None
    };
    let providers: Option<Vec<MeterProvider>> = meters.iter().map(meter_provider).collect();
    let in_use = FeaturesInUse {
        early_start: false,
        accounts: accounts.pool.clone(),
        gateway,
        meters: providers.clone(),
    };
    let steps = fr::turn_off_steps(&pending_ids, &in_use);

    let mut clients = clients_raw.iter();
    let mut kept = meters.iter();
    let mut out = Vec::with_capacity(steps.len() + 1);
    for step in &steps {
        let mut value = serde_json::to_value(step).map_err(|e| e.to_string())?;
        match step {
            // relay-core walks the clients and meters in order: the next one of that id is it.
            TurnOffStep::Unbind { client } => {
                value["client"] = clients
                    .find(|raw| client_id(raw) == *client)
                    .cloned()
                    .unwrap_or_else(js::undefined);
            }
            TurnOffStep::Meters { keep } => {
                value["keep"] = Value::Array(
                    keep.iter()
                        .filter_map(|p| kept.find(|raw| meter_provider(raw) == Some(*p)).cloned())
                        .collect(),
                );
            }
            TurnOffStep::Exclude { account_ids } => {
                value["accountIds"] = match &excluded_text {
                    // A string spreads into its code points and `includes` tests substrings.
                    Some(text) => {
                        let spread = iterate(Some(&js::utf16_string(text)), "excluded")?;
                        let excluded = Includes::Str(text.clone());
                        let antigravity = accounts
                            .pool
                            .iter()
                            .zip(&accounts.raw_ids)
                            .filter(|(a, _)| a.provider.as_deref() == Some("antigravity"))
                            .map(|(_, raw)| raw)
                            .filter(|raw| !excluded.has(raw))
                            .cloned();
                        Value::Array(spread.into_iter().chain(antigravity).collect())
                    }
                    None => account_ids.iter().map(|id| ids.value(id)).collect(),
                };
            }
            TurnOffStep::RemoveAccount { account_id } => {
                value["accountId"] = ids.value(account_id);
            }
            _ => {}
        }
        out.push(value);
    }
    if providers.is_none() {
        // Meters that are not providers: relay-core's types cannot hold them, so the meters step
        // is `pending.includes(`meter-${m}`)` as JS runs it, where relay-core puts it (before the
        // accounts' removal).
        let pending_meter = |m: &Value| match meter_provider(m) {
            Some(p) => pending_ids.contains(&fr::meter_risk(p)),
            None => pending.has_units(&meter_risk_units(m)),
        };
        if meters.iter().any(pending_meter) {
            let keep: Vec<Value> = meters
                .iter()
                .filter(|m| !pending_meter(m))
                .cloned()
                .collect();
            let step = serde_json::json!({ "kind": "meters", "keep": keep });
            let at = out
                .iter()
                .position(|s| s["kind"] == "remove-account")
                .unwrap_or(out.len());
            out.insert(at, step);
        }
    }
    Ok(out)
}
