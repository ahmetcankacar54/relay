//! Port of `tests/cli-core.test.ts`: the CLI's own plumbing (arguments, language, confirmation,
//! output, the context's guards, signals and error wording).

mod common;

use std::sync::Arc;

use common::{Options, cli_fixture};
use relay_cli::accounts::{fold_name, resolve_account_en};
use relay_cli::args::parse_command;
#[cfg(target_os = "macos")]
use relay_cli::args::{FlagValue, Flags};
use relay_cli::confirm::confirm;
#[cfg(target_os = "macos")]
use relay_cli::context::{Needs, open_context};
use relay_cli::errors::{Failure, describe_error};
use relay_cli::i18n::{T, pick_lang};
use relay_cli::io::{CliIo, Env, Signal, exit};
use relay_cli::output::{Style, paint, table};
use relay_cli::shield::shielded;
use relay_core::shared::types::Account;
use relay_i18n::Locale;

fn acct(name: &str) -> Account {
    Account::new(uuid::Uuid::new_v4().to_string(), name)
}

fn args(argv: &[&str]) -> Vec<String> {
    argv.iter().map(|a| (*a).to_owned()).collect()
}

fn env(pairs: &[(&str, &str)]) -> Env {
    pairs
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect()
}

/// A terminal that answers every prompt with `answer` and drops its output.
fn answering(tty: bool, answer: Option<&str>) -> CliIo {
    let answer = answer.map(str::to_owned);
    CliIo {
        stdout: Arc::new(|_| {}),
        stderr: Arc::new(|_| {}),
        is_tty: tty,
        prompt: Arc::new(move |_| answer.clone()),
        read_input: None,
        env: Env::new(),
        cwd: std::env::temp_dir(),
        now: Arc::new(relay_core::clock::now_ms),
        pid: std::process::id(),
        on_signal: Arc::new(|_| {}),
    }
}

#[cfg(target_os = "macos")]
fn en_flags() -> Flags {
    let mut flags = Flags::default();
    flags.set("lang", FlagValue::Str("en".into()));
    flags
}

#[cfg(target_os = "macos")]
const WRITE_DESKTOP: Needs = Needs {
    write: true,
    desktop: true,
    mac_os: false,
};
#[cfg(target_os = "macos")]
const READ_ONLY: Needs = Needs {
    write: false,
    desktop: false,
    mac_os: false,
};

/// The message and exit code a context refusal ends the CLI with.
#[cfg(target_os = "macos")]
fn refusal<T>(result: Result<T, Failure>) -> (String, i32) {
    match result {
        Ok(_) => panic!("the context opened"),
        Err(failure) => describe_error(&failure, Locale::En, 0),
    }
}

/// `"text".indexOf(needle)` in UTF-16 units, as JS counts.
fn js_index(text: &str, needle: &str) -> usize {
    text[..text.find(needle).unwrap()].encode_utf16().count()
}

#[test]
fn version_help_and_an_unknown_command() {
    let f = cli_fixture(Options::default());
    assert_eq!(f.run(&["--version"]), 0);
    assert!(f.out().starts_with("0.2.0"));
    f.clear();
    assert_eq!(f.run(&["help"]), 0);
    assert!(f.out().contains("relay switch <name>"));
    f.clear();
    assert_eq!(f.run(&[]), 0);
    assert!(f.out().contains("Usage"));
    assert_eq!(f.run(&["frobnicate"]), 2);
    assert!(f.err().contains("frobnicate"));
    assert_eq!(f.run(&["--frob"]), 2);
}

#[test]
fn help_follows_the_language() {
    let f = cli_fixture(Options {
        env: vec![("LANG", "tr_TR.UTF-8".into())],
        ..Options::default()
    });
    f.run(&["help"]);
    assert!(f.out().contains("Kullanım"));
}

#[test]
fn lang_takes_every_locale_and_help_lists_them() {
    let f = cli_fixture(Options::default());
    assert_eq!(f.run(&["--lang", "ja", "help"]), 0);
    let out = f.out();
    let line = out
        .split('\n')
        .find(|l| l.contains("--lang <code> "))
        .unwrap();
    let after = &line[line.find("--lang <code> ").unwrap()..];
    assert!(
        after.contains("en, tr, de, fr, es, pt-BR, it, ja, ko, zh-Hans, zh-Hant, ru, uk, pl, nl")
    );
}

#[test]
fn language_lang_then_relay_lang_then_lc_all_lc_messages_lang_else_english() {
    assert_eq!(
        pick_lang(None, &env(&[("LANG", "tr_TR.UTF-8")])),
        Locale::Tr
    );
    assert_eq!(
        pick_lang(
            None,
            &env(&[("LC_ALL", "en_US.UTF-8"), ("LANG", "tr_TR.UTF-8")])
        ),
        Locale::En
    );
    assert_eq!(
        pick_lang(
            None,
            &env(&[("LC_MESSAGES", "tr_TR.UTF-8"), ("LANG", "en_US.UTF-8")])
        ),
        Locale::Tr
    );
    assert_eq!(
        pick_lang(None, &env(&[("RELAY_LANG", "tr"), ("LANG", "en_US.UTF-8")])),
        Locale::Tr
    );
    assert_eq!(
        pick_lang(Some("en"), &env(&[("RELAY_LANG", "tr")])),
        Locale::En
    );
    assert_eq!(pick_lang(None, &Env::new()), Locale::En);
    // Every locale, by code or by POSIX locale; C/POSIX and unknown ones fall through.
    assert_eq!(
        pick_lang(Some("zh-Hant"), &env(&[("LANG", "tr_TR.UTF-8")])),
        Locale::ZhHant
    );
    assert_eq!(
        pick_lang(Some("xx"), &env(&[("LANG", "de_DE.UTF-8")])),
        Locale::De
    );
    assert_eq!(
        pick_lang(
            None,
            &env(&[("RELAY_LANG", "system"), ("LANG", "ja_JP.UTF-8")])
        ),
        Locale::Ja
    );
    assert_eq!(
        pick_lang(None, &env(&[("LC_ALL", "C"), ("LANG", "pt_PT.UTF-8")])),
        Locale::PtBr
    );
    assert_eq!(
        pick_lang(None, &env(&[("LANG", "zh_TW.UTF-8")])),
        Locale::ZhHant
    );
    assert_eq!(T(Locale::Tr).t("confirm.yYes"), "e evet y yes");
}

#[test]
fn arguments_global_flags_command_flags_positionals_and_passthrough() {
    let p = parse_command(&args(&[
        "--lang", "tr", "run", "Work", "--", "--resume", "x",
    ]))
    .unwrap();
    assert_eq!(p.command.as_deref(), Some("run"));
    assert_eq!(p.positionals, vec!["Work"]);
    assert_eq!(p.rest, vec!["--resume", "x"]);
    assert_eq!(p.flags.str("lang"), Some("tr"));
    assert!(
        parse_command(&args(&["switch", "B", "-y"]))
            .unwrap()
            .flags
            .is_true("yes")
    );
    assert_eq!(
        parse_command(&args(&["switch", "--days", "7"]))
            .unwrap_err()
            .code,
        2
    );
    assert_eq!(
        parse_command(&args(&["list", "--nope"])).unwrap_err().code,
        2
    );
}

#[test]
fn turkish_names_fold_dotted_and_dotless_i_to_i_and_keep_s_cedilla() {
    let accounts = vec![acct("İş"), acct("Kişisel")];
    for q in ["iş", "IŞ", "İŞ", "ış", "İş"] {
        assert_eq!(resolve_account_en(&accounts, q).unwrap().name, "İş", "{q}");
    }
    assert_eq!(resolve_account_en(&accounts, "is").unwrap_err().code, 2);
    assert_eq!(fold_name("  İSTANBUL "), "istanbul");
    let work = vec![acct("Work"), acct("Workshop")];
    assert!(
        resolve_account_en(&work, "wor")
            .unwrap_err()
            .message
            .contains("Work, Workshop")
    );
    assert_eq!(resolve_account_en(&work, "work").unwrap().name, "Work");
    let by_id = Account::new("abcdef12-0000-4000-8000-000000000000", "Same");
    let same = vec![acct("Same"), by_id.clone()];
    assert_eq!(resolve_account_en(&same, "abcdef12").unwrap().id, by_id.id);
}

#[test]
fn a_confirmation_without_a_tty_and_without_yes_exits_4() {
    let io = answering(false, Some("y"));
    let en = T(Locale::En);
    assert_eq!(
        confirm(&io, en, &["Claude will quit.".into()], false)
            .unwrap_err()
            .code,
        exit::CONFIRM
    );
    confirm(&io, en, &[], true).unwrap();
}

#[test]
fn a_tty_confirmation_accepts_y_yes_and_e_evet_in_turkish_anything_else_or_ctrl_c_cancels() {
    let ask = |answer: Option<&str>| answering(true, answer);
    let (en, tr) = (T(Locale::En), T(Locale::Tr));
    confirm(&ask(Some("y")), en, &[], false).unwrap();
    confirm(&ask(Some(" YES ")), en, &[], false).unwrap();
    confirm(&ask(Some("evet")), tr, &[], false).unwrap();
    confirm(&ask(Some("e")), tr, &[], false).unwrap();
    assert_eq!(
        confirm(&ask(Some("e")), en, &[], false).unwrap_err().code,
        exit::FAILED
    );
    assert_eq!(
        confirm(&ask(Some("h")), tr, &[], false).unwrap_err().code,
        exit::FAILED
    );
    assert!(
        confirm(&ask(None), en, &[], false)
            .unwrap_err()
            .message
            .contains("Cancelled")
    );
}

#[test]
fn piped_output_has_no_ansi_codes() {
    assert_eq!(paint(false, Style::Green, "ok"), "ok");
    assert!(paint(true, Style::Green, "ok").contains("\x1b["));
    let text = table(
        &["Name".into(), "Kind".into()],
        &[
            vec!["İş".into(), "work".into()],
            vec!["Kişisel".into(), "personal".into()],
        ],
    );
    assert!(!text.contains('\x1b'));
    let lines: Vec<&str> = text.split('\n').collect();
    assert_eq!(js_index(lines[1], "work"), js_index(lines[0], "Kind"));
}

#[cfg(target_os = "macos")]
#[test]
fn a_format_1_vault_a_newer_marker_and_an_old_relay_app_refuse_writes_with_exit_5_reads_still_work()
{
    use relay_core::desktop_files::write_bytes;
    use relay_core::vault_migration::VaultState;
    let f = cli_fixture(Options::default());
    write_bytes(
        &f.vault(),
        "accounts/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.bin",
        Some(b"v10old"),
    )
    .unwrap();
    let flags = en_flags();
    let (message, code) = refusal(open_context(&f.io, &f.deps, &flags, WRITE_DESKTOP));
    assert_eq!(code, exit::ENVIRONMENT);
    assert!(message.contains("0.12"), "{message}");
    let read = open_context(&f.io, &f.deps, &flags, READ_ONLY)
        .ok()
        .unwrap();
    assert!(matches!(read.vault, VaultState::Legacy { .. }));
    let g = cli_fixture(Options::default());
    write_bytes(&g.vault(), "format.json", Some(br#"{"version":3}"#)).unwrap();
    assert_eq!(
        refusal(open_context(&g.io, &g.deps, &flags, WRITE_DESKTOP)).1,
        exit::ENVIRONMENT
    );
    let h = cli_fixture(Options {
        app_version: Some("0.11.0".into()),
        ..Options::default()
    });
    let (message, code) = refusal(open_context(&h.io, &h.deps, &flags, WRITE_DESKTOP));
    assert_eq!(code, exit::ENVIRONMENT);
    assert!(message.contains("0.12"), "{message}");
    assert!(open_context(&h.io, &h.deps, &flags, READ_ONLY).is_ok());
}

/// state.json without its `schema` key, as Relay 0.11 wrote it.
#[cfg(target_os = "macos")]
fn drop_schema(home: &std::path::Path) {
    let file = home.join("state.json");
    let mut raw: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    raw.as_object_mut().unwrap().remove("schema");
    std::fs::write(&file, serde_json::to_string(&raw).unwrap()).unwrap();
}

#[cfg(target_os = "macos")]
#[test]
fn a_schema_less_registry_next_to_an_installed_relay_app_refuses_writes_without_an_app_it_is_adopted()
 {
    let f = cli_fixture(Options {
        app_version: Some("0.12.0".into()),
        ..Options::default()
    });
    f.saved("A", None);
    drop_schema(&f.home);
    assert_eq!(
        refusal(open_context(&f.io, &f.deps, &en_flags(), WRITE_DESKTOP)).1,
        exit::ENVIRONMENT
    );
    let g = cli_fixture(Options::default());
    g.saved("A", None);
    drop_schema(&g.home);
    let ctx = open_context(&g.io, &g.deps, &en_flags(), WRITE_DESKTOP)
        .ok()
        .unwrap();
    ctx.store.update(|_| {}).unwrap();
    let raw: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(g.home.join("state.json")).unwrap()).unwrap();
    assert_eq!(raw["schema"], relay_core::store::STATE_SCHEMA);
}

#[cfg(target_os = "macos")]
#[test]
fn a_missing_key_with_format_2_files_exits_5_and_never_creates_a_key() {
    let f = cli_fixture(Options::default());
    f.saved("A", None);
    f.security.remove_item("Relay Vault Key");
    let stdin_before = f.security.stdin_log();
    let (message, code) = refusal(open_context(&f.io, &f.deps, &en_flags(), WRITE_DESKTOP));
    assert_eq!(code, exit::ENVIRONMENT);
    assert!(message.contains("Relay Vault Key"), "{message}");
    assert_eq!(f.security.stdin_log(), stdin_before);
}

#[cfg(target_os = "macos")]
#[test]
fn an_empty_vault_gets_a_key_and_the_marker_on_the_first_writing_command() {
    let f = cli_fixture(Options::default());
    assert!(open_context(&f.io, &f.deps, &en_flags(), WRITE_DESKTOP).is_ok());
    assert_ne!(f.security.stored(), "");
    assert!(f.vault().join("format.json").exists());
}

#[test]
fn shielded_ignores_signals_during_the_operation_and_prints_one_wait_line() {
    let f = cli_fixture(Options::default());
    let result = shielded(&f.io, T(Locale::En), || {
        f.signal(Signal::Int);
        f.signal(Signal::Term);
        42
    });
    assert_eq!(result, 42);
    assert_eq!(
        f.err()
            .split('\n')
            .filter(|l| l.to_lowercase().contains("wait"))
            .count(),
        1
    );
    assert!(!f.has_signal_handler());
}

#[cfg(target_os = "macos")]
#[test]
fn a_registry_this_relay_cannot_read_names_state_json_instead_of_printing_raw_schema_errors() {
    let f = cli_fixture(Options::default());
    f.saved("A", None);
    let file = f.home.join("state.json");
    let mut raw: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    raw["settings"]["desktopHistoryTransfer"] = "sometimes".into();
    std::fs::write(&file, serde_json::to_string(&raw).unwrap()).unwrap();
    assert_eq!(f.run(&["list"]), 1);
    assert!(f.err().contains("state.json"));
    assert!(!f.err().contains("relay: ["));
}

#[cfg(target_os = "macos")]
#[test]
fn a_legacy_vault_next_to_relay_app_0_12_points_to_the_app_s_keychain_prompt_not_to_an_update() {
    use relay_core::desktop_files::write_bytes;
    let f = cli_fixture(Options {
        app_version: Some("0.12.0".into()),
        ..Options::default()
    });
    write_bytes(
        &f.vault(),
        "accounts/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.bin",
        Some(b"v10old"),
    )
    .unwrap();
    let (message, code) = refusal(open_context(&f.io, &f.deps, &en_flags(), WRITE_DESKTOP));
    assert_eq!(code, exit::ENVIRONMENT);
    assert!(message.contains("Keychain prompt"), "{message}");
    assert!(!message.contains("Update Relay.app"), "{message}");
}

#[test]
fn a_core_error_the_app_knows_in_both_languages_is_shown_in_the_cli_s_language() {
    let core = Failure::other("Connect this account in Claude Desktop first.");
    assert_eq!(
        describe_error(&core, Locale::Tr, 0).0,
        "Önce bu hesabı Claude uygulamasında bağla."
    );
    assert_eq!(
        describe_error(&core, Locale::En, 0).0,
        "Connect this account in the Claude app first."
    );
    // The blocked ones keep their own words, with the relay command that clears them.
    assert!(
        describe_error(
            &Failure::other("Finish or cancel the current Desktop sign-in first."),
            Locale::Tr,
            0
        )
        .0
        .contains("relay add --resume ile bitir")
    );
}
