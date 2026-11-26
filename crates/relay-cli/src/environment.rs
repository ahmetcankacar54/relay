//! Port of `cli/src/environment.ts`.

use relay_core::environment::profile_environment;

use crate::io::{Env, env_get};

/// The environment for the official CLI started from this terminal: the account's isolated
/// profile, without inherited credentials or routing (profileEnvironment), but with the user's
/// own TERM and COLORTERM. profileEnvironment sets those for the app's xterm.js terminals.
pub fn cli_environment(profile: &str, env: &Env) -> Env {
    let source = env.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    let mut result: Env = profile_environment(profile, &source).into_iter().collect();
    result.remove("TERM");
    result.remove("COLORTERM");
    for name in ["TERM", "COLORTERM"] {
        if let Some(value) = env_get(env, name).filter(|v| !v.is_empty()) {
            result.insert(name.to_owned(), value.to_owned());
        }
    }
    result
}
