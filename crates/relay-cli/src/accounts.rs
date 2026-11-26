//! Port of `cli/src/accounts.ts`: accounts by the name the user types.

use relay_core::shared::types::Account;
use relay_core::store::schema::js_trim;
use relay_i18n::{Args, Locale};
use unicode_normalization::UnicodeNormalization;

use crate::i18n::T;
use crate::io::{CliError, exit};

/// A name as the CLI compares it: NFC, trimmed, with İ, I and ı all as i, lowercase.
pub fn fold_name(name: &str) -> String {
    let nfc: String = name.nfc().collect();
    js_trim(&nfc)
        .chars()
        .map(|c| {
            if matches!(c, 'İ' | 'I' | 'ı') {
                'i'
            } else {
                c
            }
        })
        .collect::<String>()
        .to_lowercase()
}

/// The account `query` names: its exact name, else the one name it begins, else the one id it
/// begins. No match, or several, is a usage error that lists the names.
pub fn resolve_account<'a>(
    accounts: &'a [Account],
    query: &str,
    t: T,
) -> Result<&'a Account, CliError> {
    let q = fold_name(query);
    let exact: Vec<&Account> = accounts
        .iter()
        .filter(|a| fold_name(&a.name) == q)
        .collect();
    if exact.len() == 1 {
        return Ok(exact[0]);
    }
    let pick = |found: Vec<&'a Account>| -> Result<Option<&'a Account>, CliError> {
        match found.len() {
            1 => Ok(Some(found[0])),
            0 => Ok(None),
            _ => Err(CliError::new(
                t.f(
                    "accounts.matchesSeveralAccountsTypeMoreOf",
                    Args::new().set("query", query).set(
                        "join",
                        found
                            .iter()
                            .map(|a| a.name.as_str())
                            .collect::<Vec<_>>()
                            .join(", "),
                    ),
                ),
                exit::USAGE,
            )),
        }
    };
    if !q.is_empty() {
        let candidates = if exact.is_empty() {
            accounts
                .iter()
                .filter(|a| fold_name(&a.name).starts_with(&q))
                .collect()
        } else {
            exact
        };
        if let Some(named) = pick(candidates)? {
            return Ok(named);
        }
        if let Some(by_id) = pick(
            accounts
                .iter()
                .filter(|a| a.id.to_lowercase().starts_with(&q))
                .collect(),
        )? {
            return Ok(by_id);
        }
    }
    let names = accounts
        .iter()
        .map(|a| a.name.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    Err(CliError::new(
        if names.is_empty() {
            t.t("accounts.noAccountsAreSavedYetAdd")
        } else {
            t.f(
                "accounts.noAccountNamedAccounts",
                Args::new().set("query", query).set("names", names),
            )
        },
        exit::USAGE,
    ))
}

/// [`resolve_account`] in English, the TS default.
pub fn resolve_account_en<'a>(
    accounts: &'a [Account],
    query: &str,
) -> Result<&'a Account, CliError> {
    resolve_account(accounts, query, T(Locale::En))
}

/// Refuses a name another account already has, compared folded.
pub fn assert_free_name(
    accounts: &[Account],
    name: &str,
    t: T,
    except: Option<&str>,
) -> Result<(), CliError> {
    let folded = fold_name(name);
    if accounts
        .iter()
        .any(|a| Some(a.id.as_str()) != except && fold_name(&a.name) == folded)
    {
        return Err(CliError::new(
            t.f(
                "accounts.anAccountNamedAlreadyExists",
                Args::new().set("name", name),
            ),
            exit::USAGE,
        ));
    }
    Ok(())
}
