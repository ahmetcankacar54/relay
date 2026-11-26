//! `relay __gateway` on its own: the sidecar protocol on this process's stdin and stdout.
//! A leading `__gateway` argument is accepted and ignored, so the app's tests can run this build
//! where the app would run `relay __gateway` (`RELAY_GATEWAY_BIN`).

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    if let Some(arg) = args.next() {
        if arg != "__gateway" {
            eprintln!("relay: unexpected argument '{arg}'");
            std::process::exit(2);
        }
    }
    let input = tokio::io::BufReader::new(tokio::io::stdin());
    let code = relay_gateway::sidecar::run_sidecar(input, tokio::io::stdout()).await;
    std::process::exit(code);
}
