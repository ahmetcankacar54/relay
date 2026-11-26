//! `relay`: switch the Claude desktop app between saved accounts from the terminal.

fn main() {
    let args: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
    // Claude Code runs `relay statusline` on every prompt: before any other set-up.
    if args.first().is_some_and(|a| a == "statusline")
        && let Some(code) = relay_cli::statusline::fast_path(&args[1..])
    {
        std::process::exit(code);
    }
    // Relay.app's gateway sidecar: newline-delimited JSON on stdin and stdout.
    if args.first().is_some_and(|a| a == "__gateway") {
        std::process::exit(gateway());
    }
    relay_cli::process_io::install_signals();
    let argv: Vec<String> = args
        .iter()
        .map(|a| a.to_string_lossy().into_owned())
        .collect();
    let io = relay_cli::process_io::process_io();
    let code = relay_cli::run_cli(&argv, &io, &relay_cli::deps::default_deps());
    std::process::exit(code);
}

fn gateway() -> i32 {
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("relay: {error}");
            return 1;
        }
    };
    runtime.block_on(relay_gateway::sidecar::run_sidecar(
        tokio::io::BufReader::new(tokio::io::stdin()),
        tokio::io::stdout(),
    ))
}
