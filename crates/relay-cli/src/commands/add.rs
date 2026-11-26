use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use relay_core::desktop_files::read_object;
use relay_core::shared::types::{Account, AccountKind, CreateAccount};
use relay_core::sign_in_wait::{SignInReading, read_sign_in};
use relay_i18n::Args;
use serde_json::Value;

use crate::CommandRun;
use crate::accounts::{assert_free_name, fold_name};
use crate::confirm::confirm;
use crate::context::{CliContext, Needs, open_context};
use crate::desktop_op::{assert_can_quit_claude, quit_lines, run_desktop_operation};
use crate::errors::CliResult;
use crate::inside_desktop::{detach, inside_desktop, session_ends_line};
use crate::io::{CliError, exit};
use crate::output::js_len;
use crate::util::js_number;

/// `/^local_[0-9a-f-]{36}\.json$/i`.
fn session_file(name: &str) -> bool {
    let Some(id) = name
        .strip_prefix("local_")
        .and_then(|r| r.strip_suffix(".json"))
    else {
        return false;
    };
    id.len() == 36 && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}

/// `text.slice(0, 60)` in UTF-16 units.
fn slice60(text: &str) -> String {
    String::from_utf16_lossy(&text.encode_utf16().take(60).collect::<Vec<_>>())
}

/// A workspace of the signed-in account, as the user is shown it to pick one.
fn describe_org(ctx: &CliContext, account_uuid: &str, org: &str) -> String {
    let dir = ctx
        .paths
        .claude
        .join("claude-code-sessions")
        .join(account_uuid)
        .join(org);
    let mut count = 0;
    let mut newest: Option<(f64, String)> = None;
    // An unreadable folder shows no conversations.
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !session_file(&name) {
                continue;
            }
            count += 1;
            let relative = format!("claude-code-sessions/{account_uuid}/{org}/{name}");
            let record = read_object(&ctx.paths.claude, &relative).ok().flatten();
            if let Some(record) = record {
                let at = match record.get("lastActivityAt") {
                    Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
                    Some(Value::String(s)) => js_number(s),
                    Some(Value::Bool(b)) => f64::from(u8::from(*b)),
                    Some(Value::Null) => 0.0,
                    _ => f64::NAN,
                };
                if at.is_finite() && newest.as_ref().is_none_or(|(n, _)| at > *n) {
                    let title = record
                        .get("title")
                        .and_then(Value::as_str)
                        .map(slice60)
                        .unwrap_or_default();
                    newest = Some((at, title));
                }
            }
        }
    }
    let t = ctx.t;
    let title = match newest {
        Some((_, title)) if !title.is_empty() => format!(" · “{title}”"),
        _ => String::new(),
    };
    format!(
        "{org}  {}{title}",
        t.f("add.conversationS", Args::new().set("count", count))
    )
}

/// The workspace (Code organization) to save: --org, the only one, or a numbered pick.
fn pick_org(
    ctx: &CliContext,
    account_uuid: &str,
    orgs: &[String],
    preferred: Option<&str>,
) -> CliResult<String> {
    let (t, io) = (ctx.t, &ctx.io);
    if let Some(flag) = ctx.flags.str("org").filter(|f| !f.is_empty()) {
        return orgs
            .iter()
            .find(|org| org.to_lowercase() == flag.to_lowercase())
            .cloned()
            .ok_or_else(|| {
                CliError::new(
                    t.f(
                        "add.thisAccountHasNoWorkspace",
                        Args::new().set("flag", flag),
                    ),
                    exit::USAGE,
                )
                .into()
            });
    }
    if orgs.is_empty() {
        return Err(CliError::new(t.t("add.thisAccountHasNoCodeWorkspace"), exit::FAILED).into());
    }
    if orgs.len() == 1 {
        return Ok(orgs[0].clone());
    }
    if let Some(preferred) = preferred.filter(|p| !p.is_empty() && orgs.iter().any(|o| o == p)) {
        return Ok(preferred.to_owned());
    }
    if !io.is_tty {
        return Err(CliError::new(
            t.f(
                "add.thisAccountHasSeveralWorkspacesPick",
                Args::new().set("join", orgs.join(", ")),
            ),
            exit::USAGE,
        )
        .into());
    }
    io.out(&t.t("add.whichWorkspaceShouldBeSaved"));
    for (i, org) in orgs.iter().enumerate() {
        io.out(&format!(
            "  {}) {}",
            i + 1,
            describe_org(ctx, account_uuid, org)
        ));
    }
    let answer = (io.prompt)(&format!("[1-{}] ", orgs.len())).map_or(f64::NAN, |a| js_number(&a));
    if answer.fract() != 0.0 || !(1.0..=orgs.len() as f64).contains(&answer) {
        return Err(CliError::new(t.t("add.cancelledNothingChanged"), exit::FAILED).into());
    }
    Ok(orgs[answer as usize - 1].clone())
}

/// How long a worker (no terminal, nobody to press Ctrl+C) waits for a sign-in.
const WORKER_SIGNIN_LIMIT_MS: f64 = 15.0 * 60_000.0;

struct Signed {
    account_uuid: String,
    orgs: Vec<String>,
    preferred: Option<String>,
}

/// Waits for a new, unsaved account to be signed in to Claude Desktop with a Code workspace.
/// It stops, returning `None`, on Ctrl+C or a worker's time limit (the sign-in stays pending),
/// and when the sign-in stops being pending for `account_id` (finished or cancelled elsewhere,
/// in Relay.app for example).
fn wait_for_sign_in(ctx: &CliContext, account_id: &str) -> CliResult<Option<Signed>> {
    let (t, io) = (ctx.t, &ctx.io);
    let limit = io.var("RELAY_SIGNIN_LIMIT_MS").map_or(f64::NAN, js_number);
    let until = if io.var("RELAY_WORKER") == Some("1") {
        io.now() as f64
            + if limit.is_finite() && limit > 0.0 {
                limit
            } else {
                WORKER_SIGNIN_LIMIT_MS
            }
    } else {
        f64::INFINITY
    };
    let still_pending = t.t("add.stoppedWaitingTheSignInIs");
    let poll = ctx.flags.str("poll-ms").map_or(2000.0, js_number);
    let poll_ms = if poll.is_finite() && poll > 0.0 {
        poll
    } else {
        2000.0
    };
    let interrupted = Arc::new(AtomicBool::new(false));
    let (stop, stopped) = mpsc::channel::<()>();
    let stop = Mutex::new(stop);
    let flag = interrupted.clone();
    io.signal(Some(Arc::new(move |_| {
        flag.store(true, Ordering::SeqCst);
        let _ = stop.lock().unwrap_or_else(|e| e.into_inner()).send(());
    })));
    let result = (|| -> CliResult<Option<Signed>> {
        io.out(&t.t("add.signInToTheClaudeApp"));
        let mut told_of: Option<String> = None;
        loop {
            let state = ctx.desktop.snapshot().map_err(|e| ctx.desktop_failure(e))?;
            if state.pending_profile_id.as_deref() != Some(account_id) {
                io.out(&t.t("add.theSignInIsNoLonger"));
                return Ok(None);
            }
            if io.now() as f64 >= until {
                io.out(&still_pending);
                return Ok(None);
            }
            let accounts = ctx.store.state().accounts;
            match read_sign_in(&state, &accounts, account_id) {
                SignInReading::Ready {
                    account_uuid,
                    orgs,
                    preferred,
                    ..
                } => {
                    return Ok(Some(Signed {
                        account_uuid,
                        orgs,
                        preferred,
                    }));
                }
                // Signed back in with a saved account: say so once, and keep waiting for the new one.
                SignInReading::SavedElsewhere { account } => {
                    let uuid = account.desktop.as_ref().map(|d| d.account_uuid.clone());
                    if uuid != told_of {
                        told_of = uuid;
                        io.out(&t.f(
                            "add.theClaudeAppIsSignedIn",
                            Args::new().set("savedName", account.name.as_str()),
                        ));
                    }
                }
                _ => {}
            }
            let _ =
                stopped.recv_timeout(Duration::from_millis(poll_ms.min(u64::MAX as f64) as u64));
            if interrupted.load(Ordering::SeqCst) {
                io.out(&still_pending);
                return Ok(None);
            }
        }
    })();
    io.signal(None);
    result
}

/// Waits for the sign-in, then saves it into `account`.
fn finish_sign_in(ctx: &CliContext, account: &Account) -> CliResult<i32> {
    let Some(signed) = wait_for_sign_in(ctx, &account.id)? else {
        return Ok(exit::FAILED);
    };
    let org = pick_org(
        ctx,
        &signed.account_uuid,
        &signed.orgs,
        signed.preferred.as_deref(),
    )?;
    run_desktop_operation(ctx, || ctx.desktop.capture(&account.id, &org))?;
    ctx.io.out(&ctx.t.f(
        "add.saved",
        Args::new().set("accountName", account.name.as_str()),
    ));
    Ok(exit::OK)
}

fn forget(ctx: &CliContext, id: &str) -> CliResult<()> {
    ctx.store.update(|s| s.accounts.retain(|a| a.id != id))?;
    Ok(())
}

pub fn add(run: &CommandRun<'_>) -> CliResult<i32> {
    let (io, t, flags) = (run.io, run.t, &run.parsed.flags);
    // The CLI adds Claude accounts only; Codex and Antigravity are connected in Relay.app,
    // which checks their sign-in. Checked first, so a mistyped provider never quits Claude.
    if let Some(provider) = flags.str("provider")
        && provider.to_lowercase() != "claude"
    {
        return Err(CliError::new(t.t("add.relayAddOnlyAddsClaudeAccounts"), exit::USAGE).into());
    }
    let ctx = open_context(io, run.deps, flags, Needs::DESKTOP)?;
    let accounts = ctx.store.state().accounts;
    if flags.truthy("cancel") || flags.truthy("resume") {
        let state = assert_can_quit_claude(&ctx, true)?;
        let inside = inside_desktop(&ctx);
        let ends: Vec<String> = if inside {
            vec![session_ends_line(&ctx)]
        } else {
            Vec::new()
        };
        let Some(pending_id) = state
            .pending_profile_id
            .as_deref()
            .filter(|p| !p.is_empty())
        else {
            io.out(&t.t("add.noSignInIsPending"));
            return Ok(if flags.truthy("cancel") {
                exit::OK
            } else {
                exit::FAILED
            });
        };
        let pending = accounts.iter().find(|a| a.id == pending_id);
        if flags.truthy("resume") {
            let Some(pending) = pending else {
                return Err(
                    CliError::new(t.t("add.thePendingSignInSAccount"), exit::FAILED).into(),
                );
            };
            let mut lines = vec![t.f(
                "add.theSignInWillBeSaved",
                Args::new().set("pendingName", pending.name.as_str()),
            )];
            lines.extend(quit_lines(&ctx));
            lines.extend(ends);
            confirm(io, t, &lines, ctx.yes)?;
            if inside {
                return detach(&ctx, run.argv);
            }
            return finish_sign_in(&ctx, pending);
        }
        let mut lines = vec![t.t("add.thePendingSignInWillBe")];
        lines.extend(quit_lines(&ctx));
        lines.extend(ends);
        confirm(io, t, &lines, ctx.yes)?;
        if inside {
            return detach(&ctx, run.argv);
        }
        run_desktop_operation(&ctx, || ctx.desktop.cancel_login())?;
        if let Some(pending) = pending
            && pending.desktop.is_none()
            && pending.auth.is_none()
        {
            forget(&ctx, &pending.id)?;
        }
        io.out(&t.t("add.theSignInWasCancelled"));
        return Ok(exit::OK);
    }
    let positionals = &run.parsed.positionals;
    let name = positionals
        .first()
        .map(|n| relay_core::store::schema::js_trim(n).to_owned())
        .unwrap_or_default();
    if name.is_empty() || positionals.len() > 1 || js_len(&name) > 64 {
        return Err(CliError::new(t.t("add.usageRelayAddNameWorkGroup"), exit::USAGE).into());
    }
    // An account of that name without a Desktop link (made in Relay.app) is linked instead.
    let existing = accounts
        .iter()
        .find(|a| fold_name(&a.name) == fold_name(&name) && a.desktop.is_none())
        .cloned();
    if existing.is_none() {
        assert_free_name(&accounts, &name, t, None)?;
    }
    let state = assert_can_quit_claude(&ctx, false)?;
    let inside = inside_desktop(&ctx);
    let ends: Vec<String> = if inside {
        vec![session_ends_line(&ctx)]
    } else {
        Vec::new()
    };
    let current = state.current_account_uuid.clone().filter(|c| !c.is_empty());
    let current_saved = current.as_deref().is_some_and(|c| {
        accounts
            .iter()
            .any(|a| a.desktop.as_ref().is_some_and(|d| d.account_uuid == c))
    });
    let work = flags.truthy("work");
    let create = || -> CliResult<Account> {
        if let Some(existing) = &existing {
            return Ok(existing.clone());
        }
        Ok(ctx.store.create(&CreateAccount {
            name: name.clone(),
            kind: if work {
                AccountKind::Work
            } else {
                AccountKind::Personal
            },
            group: if work {
                flags.str("group").map(str::to_owned)
            } else {
                None
            },
            provider: None,
        })?)
    };
    if let Some(current) = current
        .as_deref()
        .filter(|_| !current_saved && !flags.truthy("new"))
    {
        let org = pick_org(&ctx, current, &state.organizations, None)?;
        let slice = String::from_utf16_lossy(&current.encode_utf16().take(8).collect::<Vec<_>>());
        let mut lines = vec![t.f(
            "add.theAccountSignedInToThe",
            Args::new().set("slice", slice).set("name", name.as_str()),
        )];
        lines.extend(quit_lines(&ctx));
        lines.extend(ends);
        confirm(io, t, &lines, ctx.yes)?;
        // The worker has no terminal to pick a workspace in: it gets the one picked here.
        if inside {
            let mut argv = run.argv.to_vec();
            if !ctx.flags.truthy("org") {
                argv.extend(["--org".to_owned(), org]);
            }
            return detach(&ctx, &argv);
        }
        let account = create()?;
        if let Err(error) = run_desktop_operation(&ctx, || ctx.desktop.capture(&account.id, &org)) {
            if existing.is_none() {
                forget(&ctx, &account.id)?;
            }
            return Err(error);
        }
        io.out(&t.f("add.saved2", Args::new().set("name", name.as_str())));
        return Ok(exit::OK);
    }
    if current.is_some() && !current_saved {
        return Err(CliError::new(t.t("add.theAccountSignedInToThe2"), exit::FAILED).into());
    }
    let mut lines = vec![t.t("add.theClaudeAppWillQuitAnd")];
    lines.extend(quit_lines(&ctx));
    lines.extend(ends);
    confirm(io, t, &lines, ctx.yes)?;
    if inside {
        return detach(&ctx, run.argv);
    }
    let account = create()?;
    if let Err(error) = run_desktop_operation(&ctx, || ctx.desktop.begin_login(&account.id)) {
        if existing.is_none() {
            forget(&ctx, &account.id)?;
        }
        return Err(error);
    }
    let account = ctx.store.account(&account.id)?;
    finish_sign_in(&ctx, &account)
}
