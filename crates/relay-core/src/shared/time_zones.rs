//! Port of `shared/time-zones.ts`: the time zone picker's data. Zones are IANA identities
//! resolved with `chrono-tz`, accepted case-insensitively with their aliases as `Intl` does.

use chrono::{Offset, TimeZone};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use unicode_normalization::UnicodeNormalization;
use unicode_normalization::char::is_combining_mark;

use super::types::js;

/// Picker data uses IANA identities; offsets are a dated display, never storage.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimeZoneOption {
    pub zone: String,
    pub city: String,
    pub offset: String,
    pub common: bool,
}

pub const COMMON_TIME_ZONES: [&str; 8] = [
    "Europe/Istanbul",
    "Europe/London",
    "Europe/Berlin",
    "America/New_York",
    "America/Los_Angeles",
    "Asia/Dubai",
    "Asia/Tokyo",
    "UTC",
];

/// The catalog without `Intl.supportedValuesOf`: representative half/quarter-hour zones too.
const FALLBACK_EXTRA: [&str; 27] = [
    "Africa/Cairo",
    "Africa/Johannesburg",
    "Africa/Lagos",
    "America/Anchorage",
    "America/Chicago",
    "America/Denver",
    "America/Mexico_City",
    "America/Sao_Paulo",
    "America/Toronto",
    "Asia/Bangkok",
    "Asia/Hong_Kong",
    "Asia/Kathmandu",
    "Asia/Kolkata",
    "Asia/Seoul",
    "Asia/Shanghai",
    "Asia/Singapore",
    "Asia/Tehran",
    "Australia/Adelaide",
    "Australia/Perth",
    "Australia/Sydney",
    "Europe/Amsterdam",
    "Europe/Athens",
    "Europe/Madrid",
    "Europe/Paris",
    "Europe/Rome",
    "Pacific/Auckland",
    "Pacific/Honolulu",
];

fn shape_ok(zone: &str) -> bool {
    let mut chars = zone.chars();
    !zone.is_empty()
        && zone.len() <= 100
        && chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '+' | '.' | '/' | '-'))
}

/// ICU's legacy ids that `Intl` accepts beyond the tz database (Java's three-letter ids and a few
/// removed links), with the zone each resolves to.
const ICU_LEGACY_ZONES: [(&str, Tz); 33] = [
    ("ACT", Tz::Australia__Darwin),
    ("AET", Tz::Australia__Sydney),
    ("AGT", Tz::America__Argentina__Buenos_Aires),
    ("ART", Tz::Africa__Cairo),
    ("AST", Tz::America__Anchorage),
    ("BET", Tz::America__Sao_Paulo),
    ("BST", Tz::Asia__Dhaka),
    ("CAT", Tz::Africa__Maputo),
    ("CNT", Tz::America__St_Johns),
    ("CST", Tz::America__Chicago),
    ("CTT", Tz::Asia__Shanghai),
    ("EAT", Tz::Africa__Nairobi),
    ("ECT", Tz::Europe__Paris),
    ("IET", Tz::America__Indiana__Indianapolis),
    ("IST", Tz::Asia__Kolkata),
    ("JST", Tz::Asia__Tokyo),
    ("MIT", Tz::Pacific__Apia),
    ("NET", Tz::Asia__Yerevan),
    ("NST", Tz::Pacific__Auckland),
    ("PLT", Tz::Asia__Karachi),
    ("PNT", Tz::America__Phoenix),
    ("PRT", Tz::America__Puerto_Rico),
    ("PST", Tz::America__Los_Angeles),
    ("SST", Tz::Pacific__Guadalcanal),
    ("VST", Tz::Asia__Ho_Chi_Minh),
    ("US/Pacific-New", Tz::America__Los_Angeles),
    ("Canada/East-Saskatchewan", Tz::America__Regina),
    ("SystemV/AST4", Tz::Etc__GMTPlus4),
    ("SystemV/CST6", Tz::Etc__GMTPlus6),
    ("SystemV/EST5", Tz::Etc__GMTPlus5),
    ("SystemV/HST10", Tz::Etc__GMTPlus10),
    ("SystemV/MST7", Tz::Etc__GMTPlus7),
    ("SystemV/PST8", Tz::Etc__GMTPlus8),
];

/// The zone `Intl.DateTimeFormat` would accept for `zone`, if any: a tz database name or link,
/// or one of ICU's legacy ids, in any case.
pub fn parse_time_zone(zone: &str) -> Option<Tz> {
    if !shape_ok(zone) || zone.eq_ignore_ascii_case("factory") {
        return None;
    }
    Tz::from_str_insensitive(zone).ok().or_else(|| {
        ICU_LEGACY_ZONES
            .iter()
            .find(|(id, _)| id.eq_ignore_ascii_case(zone))
            .map(|(_, tz)| *tz)
    })
}

pub fn valid_time_zone(zone: &str) -> bool {
    parse_time_zone(zone).is_some()
}

pub fn time_zone_city(zone: &str) -> String {
    if !valid_time_zone(zone) {
        return "—".into();
    }
    zone.rsplit('/').next().unwrap_or(zone).replace('_', " ")
}

/// The zone's offset from UTC in seconds at `ms` (epoch ms), as ICU applies it. chrono-tz lists
/// transitions only up to 2100, so a later instant is read at the same moment of the year before
/// 2100 with the same calendar (leap year, weekday of January 1): the zone's recurring rule then
/// falls on the same days. Years past chrono's range first move back by 400-year cycles.
pub(crate) fn offset_seconds(tz: Tz, ms: f64) -> Option<i32> {
    use chrono::{Datelike, NaiveDate};
    if !ms.is_finite() || ms.abs() > 8.64e15 {
        return None;
    }
    const CYCLE_MS: f64 = 146_097.0 * 86_400_000.0;
    let mut ms = ms.trunc();
    while ms.abs() > 8.0e15 {
        ms -= CYCLE_MS * ms.signum() * ((ms.abs() - 8.0e15) / CYCLE_MS).ceil().max(1.0);
    }
    let mut at = chrono::Utc
        .timestamp_millis_opt(ms as i64)
        .single()?
        .naive_utc();
    if at.year() >= 2100 {
        let leap = |y: i32| NaiveDate::from_ymd_opt(y, 2, 29).is_some();
        let jan1 = |y: i32| NaiveDate::from_ymd_opt(y, 1, 1).map(|d| d.weekday());
        let year = at.year();
        let same = (2072..2100).find(|y| leap(*y) == leap(year) && jan1(*y) == jan1(year))?;
        at = at.with_year(same)?;
    }
    Some(tz.offset_from_utc_datetime(&at).fix().local_minus_utc())
}

/// `UTC+03:00` at `now`; `—` for an invalid zone or time.
pub fn time_zone_offset(zone: &str, now: f64) -> String {
    let Some(tz) = parse_time_zone(zone) else {
        return "—".into();
    };
    let Some(seconds) = offset_seconds(tz, now) else {
        return "—".into();
    };
    if seconds == 0 {
        return "UTC+00:00".into();
    }
    // `shortOffset` prints seconds of a historical offset, which the TS pattern refuses.
    if seconds % 60 != 0 {
        return "—".into();
    }
    let sign = if seconds < 0 { '-' } else { '+' };
    let minutes = seconds.abs() / 60;
    format!("UTC{sign}{:02}:{:02}", minutes / 60, minutes % 60)
}

/// The picker's catalog from `supported` (the fallback list when empty): the common zones first
/// in their order, then the rest sorted.
pub fn build_time_zone_catalog(supported: Option<&[&str]>) -> Vec<String> {
    let mut all: Vec<String> = COMMON_TIME_ZONES.iter().map(|z| z.to_string()).collect();
    let fallback: Vec<&str> = COMMON_TIME_ZONES
        .iter()
        .chain(FALLBACK_EXTRA.iter())
        .copied()
        .collect();
    let source = match supported {
        Some(list) if !list.is_empty() => list,
        _ => &fallback[..],
    };
    for zone in source {
        if valid_time_zone(zone) && !all.iter().any(|z| z == zone) {
            all.push(zone.to_string());
        }
    }
    let common: Vec<String> = COMMON_TIME_ZONES
        .iter()
        .filter(|z| all.iter().any(|a| a == *z))
        .map(|z| z.to_string())
        .collect();
    let mut rest: Vec<String> = all.into_iter().filter(|z| !common.contains(z)).collect();
    js::sort_by(&mut rest, |a, b| js::compare_str(a, b));
    common.into_iter().chain(rest).collect()
}

fn time_zone_catalog() -> &'static [String] {
    static CATALOG: std::sync::LazyLock<Vec<String>> =
        std::sync::LazyLock::new(|| build_time_zone_catalog(Some(&SUPPORTED_TIME_ZONES)));
    &CATALOG
}

/// `String.prototype.trim`: JavaScript's white space and line terminators.
pub(crate) fn js_trim(text: &str) -> &str {
    js::trim(text)
}

pub fn fold_time_zone_search(value: &str) -> String {
    // Both Turkish I forms first; English lowercasing otherwise treats ı as distinct.
    let mapped: String = value
        .chars()
        .map(|c| {
            if matches!(c, 'İ' | 'ı' | 'I') {
                'i'
            } else {
                c
            }
        })
        .collect();
    let stripped: String = mapped.nfd().filter(|c| !is_combining_mark(*c)).collect();
    js_trim(&stripped.to_lowercase().replace('_', " ")).to_string()
}

fn offset_search(value: &str) -> String {
    let folded = fold_time_zone_search(value);
    let folded = match folded.strip_prefix("gmt") {
        Some(rest) => format!("utc{rest}"),
        None => folded,
    };
    // `/([+-])0(\d)/g` → `$1$2`.
    let chars: Vec<char> = folded.chars().collect();
    let mut out = String::with_capacity(folded.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if (c == '+' || c == '-')
            && chars.get(i + 1) == Some(&'0')
            && chars.get(i + 2).is_some_and(|d| d.is_ascii_digit())
        {
            out.push(c);
            out.push(chars[i + 2]);
            i += 3;
        } else {
            out.push(c);
            i += 1;
        }
    }
    out
}

fn option(zone: &str, now: f64, common: bool) -> TimeZoneOption {
    TimeZoneOption {
        zone: zone.to_string(),
        city: time_zone_city(zone),
        offset: time_zone_offset(zone, now),
        common,
    }
}

/// The picker's options at `now`; a saved alias missing from the catalog stays visible first.
pub fn time_zone_options(
    current: &str,
    now: f64,
    catalog: Option<&[String]>,
) -> Vec<TimeZoneOption> {
    let mut zones: Vec<String> = catalog.unwrap_or_else(|| time_zone_catalog()).to_vec();
    if valid_time_zone(current) && !zones.iter().any(|z| z == current) {
        zones.insert(0, current.to_string());
    }
    zones
        .iter()
        .map(|z| option(z, now, COMMON_TIME_ZONES.contains(&z.as_str())))
        .collect()
}

pub fn filter_time_zones(options: &[TimeZoneOption], query: &str, now: f64) -> Vec<TimeZoneOption> {
    let trimmed = js_trim(query);
    let folded = fold_time_zone_search(trimmed);
    if folded.is_empty() {
        return options.to_vec();
    }
    let wanted_offset = offset_search(trimmed);
    let mut matches: Vec<TimeZoneOption> = options
        .iter()
        .filter(|o| {
            fold_time_zone_search(&format!("{} {}", o.city, o.zone)).contains(&folded)
                || offset_search(&o.offset).contains(&wanted_offset)
        })
        .cloned()
        .collect();
    // An exact valid identifier missing from the catalog is selectable; partial text never is.
    if valid_time_zone(trimmed)
        && !matches
            .iter()
            .any(|o| o.zone.to_lowercase() == trimmed.to_lowercase())
    {
        matches.insert(0, option(trimmed, now, false));
    }
    matches
}

/// `Intl.supportedValuesOf("timeZone")` in Node 24 (ICU), the picker catalog.
pub const SUPPORTED_TIME_ZONES: [&str; 418] = [
    "Africa/Abidjan",
    "Africa/Accra",
    "Africa/Addis_Ababa",
    "Africa/Algiers",
    "Africa/Asmera",
    "Africa/Bamako",
    "Africa/Bangui",
    "Africa/Banjul",
    "Africa/Bissau",
    "Africa/Blantyre",
    "Africa/Brazzaville",
    "Africa/Bujumbura",
    "Africa/Cairo",
    "Africa/Casablanca",
    "Africa/Ceuta",
    "Africa/Conakry",
    "Africa/Dakar",
    "Africa/Dar_es_Salaam",
    "Africa/Djibouti",
    "Africa/Douala",
    "Africa/El_Aaiun",
    "Africa/Freetown",
    "Africa/Gaborone",
    "Africa/Harare",
    "Africa/Johannesburg",
    "Africa/Juba",
    "Africa/Kampala",
    "Africa/Khartoum",
    "Africa/Kigali",
    "Africa/Kinshasa",
    "Africa/Lagos",
    "Africa/Libreville",
    "Africa/Lome",
    "Africa/Luanda",
    "Africa/Lubumbashi",
    "Africa/Lusaka",
    "Africa/Malabo",
    "Africa/Maputo",
    "Africa/Maseru",
    "Africa/Mbabane",
    "Africa/Mogadishu",
    "Africa/Monrovia",
    "Africa/Nairobi",
    "Africa/Ndjamena",
    "Africa/Niamey",
    "Africa/Nouakchott",
    "Africa/Ouagadougou",
    "Africa/Porto-Novo",
    "Africa/Sao_Tome",
    "Africa/Tripoli",
    "Africa/Tunis",
    "Africa/Windhoek",
    "America/Adak",
    "America/Anchorage",
    "America/Anguilla",
    "America/Antigua",
    "America/Araguaina",
    "America/Argentina/La_Rioja",
    "America/Argentina/Rio_Gallegos",
    "America/Argentina/Salta",
    "America/Argentina/San_Juan",
    "America/Argentina/San_Luis",
    "America/Argentina/Tucuman",
    "America/Argentina/Ushuaia",
    "America/Aruba",
    "America/Asuncion",
    "America/Bahia",
    "America/Bahia_Banderas",
    "America/Barbados",
    "America/Belem",
    "America/Belize",
    "America/Blanc-Sablon",
    "America/Boa_Vista",
    "America/Bogota",
    "America/Boise",
    "America/Buenos_Aires",
    "America/Cambridge_Bay",
    "America/Campo_Grande",
    "America/Cancun",
    "America/Caracas",
    "America/Catamarca",
    "America/Cayenne",
    "America/Cayman",
    "America/Chicago",
    "America/Chihuahua",
    "America/Ciudad_Juarez",
    "America/Coral_Harbour",
    "America/Cordoba",
    "America/Costa_Rica",
    "America/Coyhaique",
    "America/Creston",
    "America/Cuiaba",
    "America/Curacao",
    "America/Danmarkshavn",
    "America/Dawson",
    "America/Dawson_Creek",
    "America/Denver",
    "America/Detroit",
    "America/Dominica",
    "America/Edmonton",
    "America/Eirunepe",
    "America/El_Salvador",
    "America/Fort_Nelson",
    "America/Fortaleza",
    "America/Glace_Bay",
    "America/Godthab",
    "America/Goose_Bay",
    "America/Grand_Turk",
    "America/Grenada",
    "America/Guadeloupe",
    "America/Guatemala",
    "America/Guayaquil",
    "America/Guyana",
    "America/Halifax",
    "America/Havana",
    "America/Hermosillo",
    "America/Indiana/Knox",
    "America/Indiana/Marengo",
    "America/Indiana/Petersburg",
    "America/Indiana/Tell_City",
    "America/Indiana/Vevay",
    "America/Indiana/Vincennes",
    "America/Indiana/Winamac",
    "America/Indianapolis",
    "America/Inuvik",
    "America/Iqaluit",
    "America/Jamaica",
    "America/Jujuy",
    "America/Juneau",
    "America/Kentucky/Monticello",
    "America/Kralendijk",
    "America/La_Paz",
    "America/Lima",
    "America/Los_Angeles",
    "America/Louisville",
    "America/Lower_Princes",
    "America/Maceio",
    "America/Managua",
    "America/Manaus",
    "America/Marigot",
    "America/Martinique",
    "America/Matamoros",
    "America/Mazatlan",
    "America/Mendoza",
    "America/Menominee",
    "America/Merida",
    "America/Metlakatla",
    "America/Mexico_City",
    "America/Miquelon",
    "America/Moncton",
    "America/Monterrey",
    "America/Montevideo",
    "America/Montserrat",
    "America/Nassau",
    "America/New_York",
    "America/Nome",
    "America/Noronha",
    "America/North_Dakota/Beulah",
    "America/North_Dakota/Center",
    "America/North_Dakota/New_Salem",
    "America/Ojinaga",
    "America/Panama",
    "America/Paramaribo",
    "America/Phoenix",
    "America/Port-au-Prince",
    "America/Port_of_Spain",
    "America/Porto_Velho",
    "America/Puerto_Rico",
    "America/Punta_Arenas",
    "America/Rankin_Inlet",
    "America/Recife",
    "America/Regina",
    "America/Resolute",
    "America/Rio_Branco",
    "America/Santarem",
    "America/Santiago",
    "America/Santo_Domingo",
    "America/Sao_Paulo",
    "America/Scoresbysund",
    "America/Sitka",
    "America/St_Barthelemy",
    "America/St_Johns",
    "America/St_Kitts",
    "America/St_Lucia",
    "America/St_Thomas",
    "America/St_Vincent",
    "America/Swift_Current",
    "America/Tegucigalpa",
    "America/Thule",
    "America/Tijuana",
    "America/Toronto",
    "America/Tortola",
    "America/Vancouver",
    "America/Whitehorse",
    "America/Winnipeg",
    "America/Yakutat",
    "Antarctica/Casey",
    "Antarctica/Davis",
    "Antarctica/DumontDUrville",
    "Antarctica/Macquarie",
    "Antarctica/Mawson",
    "Antarctica/McMurdo",
    "Antarctica/Palmer",
    "Antarctica/Rothera",
    "Antarctica/Syowa",
    "Antarctica/Troll",
    "Antarctica/Vostok",
    "Arctic/Longyearbyen",
    "Asia/Aden",
    "Asia/Almaty",
    "Asia/Amman",
    "Asia/Anadyr",
    "Asia/Aqtau",
    "Asia/Aqtobe",
    "Asia/Ashgabat",
    "Asia/Atyrau",
    "Asia/Baghdad",
    "Asia/Bahrain",
    "Asia/Baku",
    "Asia/Bangkok",
    "Asia/Barnaul",
    "Asia/Beirut",
    "Asia/Bishkek",
    "Asia/Brunei",
    "Asia/Calcutta",
    "Asia/Chita",
    "Asia/Colombo",
    "Asia/Damascus",
    "Asia/Dhaka",
    "Asia/Dili",
    "Asia/Dubai",
    "Asia/Dushanbe",
    "Asia/Famagusta",
    "Asia/Gaza",
    "Asia/Hebron",
    "Asia/Hong_Kong",
    "Asia/Hovd",
    "Asia/Irkutsk",
    "Asia/Jakarta",
    "Asia/Jayapura",
    "Asia/Jerusalem",
    "Asia/Kabul",
    "Asia/Kamchatka",
    "Asia/Karachi",
    "Asia/Katmandu",
    "Asia/Khandyga",
    "Asia/Krasnoyarsk",
    "Asia/Kuala_Lumpur",
    "Asia/Kuching",
    "Asia/Kuwait",
    "Asia/Macau",
    "Asia/Magadan",
    "Asia/Makassar",
    "Asia/Manila",
    "Asia/Muscat",
    "Asia/Nicosia",
    "Asia/Novokuznetsk",
    "Asia/Novosibirsk",
    "Asia/Omsk",
    "Asia/Oral",
    "Asia/Phnom_Penh",
    "Asia/Pontianak",
    "Asia/Pyongyang",
    "Asia/Qatar",
    "Asia/Qostanay",
    "Asia/Qyzylorda",
    "Asia/Rangoon",
    "Asia/Riyadh",
    "Asia/Saigon",
    "Asia/Sakhalin",
    "Asia/Samarkand",
    "Asia/Seoul",
    "Asia/Shanghai",
    "Asia/Singapore",
    "Asia/Srednekolymsk",
    "Asia/Taipei",
    "Asia/Tashkent",
    "Asia/Tbilisi",
    "Asia/Tehran",
    "Asia/Thimphu",
    "Asia/Tokyo",
    "Asia/Tomsk",
    "Asia/Ulaanbaatar",
    "Asia/Urumqi",
    "Asia/Ust-Nera",
    "Asia/Vientiane",
    "Asia/Vladivostok",
    "Asia/Yakutsk",
    "Asia/Yekaterinburg",
    "Asia/Yerevan",
    "Atlantic/Azores",
    "Atlantic/Bermuda",
    "Atlantic/Canary",
    "Atlantic/Cape_Verde",
    "Atlantic/Faeroe",
    "Atlantic/Madeira",
    "Atlantic/Reykjavik",
    "Atlantic/South_Georgia",
    "Atlantic/St_Helena",
    "Atlantic/Stanley",
    "Australia/Adelaide",
    "Australia/Brisbane",
    "Australia/Broken_Hill",
    "Australia/Darwin",
    "Australia/Eucla",
    "Australia/Hobart",
    "Australia/Lindeman",
    "Australia/Lord_Howe",
    "Australia/Melbourne",
    "Australia/Perth",
    "Australia/Sydney",
    "Europe/Amsterdam",
    "Europe/Andorra",
    "Europe/Astrakhan",
    "Europe/Athens",
    "Europe/Belgrade",
    "Europe/Berlin",
    "Europe/Bratislava",
    "Europe/Brussels",
    "Europe/Bucharest",
    "Europe/Budapest",
    "Europe/Busingen",
    "Europe/Chisinau",
    "Europe/Copenhagen",
    "Europe/Dublin",
    "Europe/Gibraltar",
    "Europe/Guernsey",
    "Europe/Helsinki",
    "Europe/Isle_of_Man",
    "Europe/Istanbul",
    "Europe/Jersey",
    "Europe/Kaliningrad",
    "Europe/Kiev",
    "Europe/Kirov",
    "Europe/Lisbon",
    "Europe/Ljubljana",
    "Europe/London",
    "Europe/Luxembourg",
    "Europe/Madrid",
    "Europe/Malta",
    "Europe/Mariehamn",
    "Europe/Minsk",
    "Europe/Monaco",
    "Europe/Moscow",
    "Europe/Oslo",
    "Europe/Paris",
    "Europe/Podgorica",
    "Europe/Prague",
    "Europe/Riga",
    "Europe/Rome",
    "Europe/Samara",
    "Europe/San_Marino",
    "Europe/Sarajevo",
    "Europe/Saratov",
    "Europe/Simferopol",
    "Europe/Skopje",
    "Europe/Sofia",
    "Europe/Stockholm",
    "Europe/Tallinn",
    "Europe/Tirane",
    "Europe/Ulyanovsk",
    "Europe/Vaduz",
    "Europe/Vatican",
    "Europe/Vienna",
    "Europe/Vilnius",
    "Europe/Volgograd",
    "Europe/Warsaw",
    "Europe/Zagreb",
    "Europe/Zurich",
    "Indian/Antananarivo",
    "Indian/Chagos",
    "Indian/Christmas",
    "Indian/Cocos",
    "Indian/Comoro",
    "Indian/Kerguelen",
    "Indian/Mahe",
    "Indian/Maldives",
    "Indian/Mauritius",
    "Indian/Mayotte",
    "Indian/Reunion",
    "Pacific/Apia",
    "Pacific/Auckland",
    "Pacific/Bougainville",
    "Pacific/Chatham",
    "Pacific/Easter",
    "Pacific/Efate",
    "Pacific/Enderbury",
    "Pacific/Fakaofo",
    "Pacific/Fiji",
    "Pacific/Funafuti",
    "Pacific/Galapagos",
    "Pacific/Gambier",
    "Pacific/Guadalcanal",
    "Pacific/Guam",
    "Pacific/Honolulu",
    "Pacific/Kiritimati",
    "Pacific/Kosrae",
    "Pacific/Kwajalein",
    "Pacific/Majuro",
    "Pacific/Marquesas",
    "Pacific/Midway",
    "Pacific/Nauru",
    "Pacific/Niue",
    "Pacific/Norfolk",
    "Pacific/Noumea",
    "Pacific/Pago_Pago",
    "Pacific/Palau",
    "Pacific/Pitcairn",
    "Pacific/Ponape",
    "Pacific/Port_Moresby",
    "Pacific/Rarotonga",
    "Pacific/Saipan",
    "Pacific/Tahiti",
    "Pacific/Tarawa",
    "Pacific/Tongatapu",
    "Pacific/Truk",
    "Pacific/Wake",
    "Pacific/Wallis",
];
