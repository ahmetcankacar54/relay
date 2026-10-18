# Relay CLI

[Türkçe](README.tr.md)

Relay switches the official Claude desktop app between saved accounts from the terminal. It does
the same switch as the Relay menu-bar app:
1. it quits Claude Desktop;
2. it swaps Claude's sign-in files;
3. it carries Code tab history between accounts;
4. it reopens Claude.

It can also show each account's remaining limits and run Claude Code as a given account.

Relay is unofficial and is not affiliated with or endorsed by Anthropic. It changes Claude
Desktop's local files, so a Claude Desktop update can break it.

> **Warning:** some commands quit Claude Desktop:
> - `relay switch`
> - `relay add`
> - `relay recover`
> - `relay history sync`
>
> Quitting Claude stops every Code session running inside it, including this terminal when it runs
> inside Claude Desktop. Relay asks first. In scripts, add `--yes`.

## Requirements

- macOS
- Node.js 22.12 or newer
- Claude Desktop (`/Applications/Claude.app` or `~/Applications/Claude.app`)
- For limits and `relay run`: the Claude Code CLI, version 2.1.296 or newer

## Install

```bash
npm i -g @ahmetcankacar/relay
```

## First account

Open Claude Desktop, sign in, and open the Code tab once. Then save that account:

```bash
relay add Personal
```

Claude quits for a moment and reopens. If the account has several Code workspaces, Relay asks
which one to save, or takes `--org <id>`. For a work account, add `--work`. To share its Code
history with your other work accounts of the same company, add `--group <name>`.

## More accounts

```bash
relay add Work --new --work --group Acme
```

Relay reopens Claude on its sign-in screen and waits:
1. Sign in with the other account.
2. Open the Code tab once.
3. Relay saves the account.

Ctrl+C stops waiting but leaves the sign-in pending. Then:
- `relay add --resume` finishes it;
- `relay add --cancel` puts the previous account back.

## Switching

```bash
relay switch Work
```

Code history is carried as the history mode says:
- `same-group` (the default) shares within each group, and personal accounts with each other;
- `all` shares between every account;
- `selected` shares between the accounts you pick;
- `off` shares nothing.

Unsent drafts in Claude are not carried by the CLI. Claude may clear them when it reopens.

## Limits

Each account needs its own Claude Code login once:

```bash
relay connect Work      # opens the Claude Code sign-in in your browser
relay usage             # remaining 5-hour and weekly limits
```

Percentages are what is left: `6% left · resets in 2 h 10 min`. A Team seat that reports no weekly
limit shows "no limit reported".

## Running Claude Code as an account

```bash
relay run Work -- --resume
```

This starts `claude` with the account's own profile (`CLAUDE_CONFIG_DIR`) in the current folder.
Claude Desktop is not touched. Everything after `--` goes to `claude`.

## Token usage

```bash
relay tokens --days 30
```

This shows daily token usage per account. Relay.app records it while the app is open; the CLI only
reads it. Values marked `≈` were estimated from limit samples.

## Commands

| Command | What it does |
|---|---|
| `relay status [--json]` | Claude Desktop, the active account, pending work, Relay.app and the lock. |
| `relay list [--json]` (`ls`) | Saved accounts; `*` marks the active one. |
| `relay add <name> [--work [--group <g>]] [--org <id>] [--new] [--yes]` | Save the signed-in account, or sign a new one in. |
| `relay add --resume` / `--cancel` | Finish or cancel a pending sign-in. |
| `relay switch <name> [--yes]` | Quit Claude Desktop and reopen it signed in as `<name>`. |
| `relay remove <name> [--yes]` | Forget an account. Claude Desktop's own data is not touched. |
| `relay rename <name> <new-name>` | Rename an account. |
| `relay recover [--yes]` | Restore an interrupted switch from its backup. |
| `relay history [<name>] [--json]` | What Code history an account gets, and from whom. |
| `relay history mode <all\|same-group\|selected\|off> [--accounts a,b]` | Set how Code history is shared. |
| `relay history sync [<name>] [--yes]` | Bring Code history into the active account now. |
| `relay connect <name>` | Sign the account's Claude Code profile in, for limits and `run`. |
| `relay usage [<name>] [--json]` | Remaining limits. |
| `relay run <name> [-- <claude args>]` | Run Claude Code as `<name>`. |
| `relay tokens [--days 7\|30\|90] [--account <name>] [--json]` | Daily token usage recorded by Relay.app. |
| `relay doctor [--json]` | Check the setup. |

Accounts can be named by any case. `İ`, `I` and `ı` count as the same letter. A unique prefix of
the name or of the account id also works.

These options work with every command:
- `--yes` (`-y`)
- `--lang tr|en`. Without it, Relay follows `RELAY_LANG`, then the system locale.
- `--no-color`
- `--version`
- `--help`

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Done, or nothing to do |
| 1 | The operation failed |
| 2 | Wrong usage, or an unknown or ambiguous account name |
| 3 | Busy or blocked: another Relay is switching, a sign-in is pending, or a switch must be recovered |
| 4 | Confirmation needed: no terminal and no `--yes` |
| 5 | Environment: not macOS, an old Relay.app, the Keychain item unreadable, a sandbox, or no Automation permission |

## Living with Relay.app

The CLI and Relay.app share one data folder (`~/Library/Application Support/Relay`) and one
account list.

- Relay.app must be 0.12 or newer. Open it once after updating, so it moves its vault to the format
  the CLI reads.
- Next to an older Relay.app, the CLI only reads.
- Both take the same lock, so they never quit Claude at the same time. When one is busy, the other
  says so and exits 3.

## Running from inside Claude Desktop

You can run `relay switch` in a terminal inside a Claude Desktop Code session, or ask Claude to run
it. Relay notices this and asks first, because the session will end too. It then hands the switch
to a separate process that survives Claude's quit. After Claude reopens, `relay status` shows how
it went.

In a sandboxed session Relay cannot do this, and asks you to use a normal terminal.

## The Automation permission

The first time a terminal app quits Claude, macOS asks whether that app may control Claude. If you
refused, allow it here: System Settings → Privacy & Security → Automation → your terminal app →
Claude.

Over SSH there is no desktop session, so Relay cannot quit or open Claude from there.

## Security

**Saved Claude Desktop sign-ins and switch backups** are kept in
`~/Library/Application Support/Relay/desktop-vault`.
- They are encrypted with AES-256-GCM.
- The key is in your login Keychain, as the item "Relay Vault Key".
- Relay reads the key through `/usr/bin/security`. That is how the Claude Code CLI protects its own
  login: other macOS users and a stolen, powered-off disk cannot read it, but any program running
  as you can.

**Folders and files** are private to you (0700 and 0600), and symbolic links are refused.

**What is never printed or logged:** tokens, cookies, auth-key values and Keychain output. That
holds in `--json` too.

**Network:** Relay contacts only `api.anthropic.com`, to read limits. It sends no telemetry and
does no update check.

## Uninstall

```bash
npm rm -g @ahmetcankacar/relay
```

If Relay.app is not installed either, you can also remove the data. This deletes every saved
sign-in:

```bash
security delete-generic-password -s "Relay Vault Key"
```

```bash
rm -rf ~/Library/Application\ Support/Relay
```

## License

MIT
