//! Port of `shared/cli-package.ts`.

/// The relay CLI's npm package (cli/package.json `name`; a test keeps them equal).
pub const RELAY_CLI_PACKAGE: &str = "@ahmetcankacar/relay";
/// The command that installs it, as Settings offers to copy it.
pub const RELAY_CLI_INSTALL: &str = "npm i -g @ahmetcankacar/relay";
