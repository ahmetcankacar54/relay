//! Port of the `shared/cli-package` case of `tests/statusline.test.ts`; the file's other cases are
//! in `statusline.rs` and `shared_statusline.rs`.

use relay_core::shared::cli_package::{RELAY_CLI_INSTALL, RELAY_CLI_PACKAGE};

#[test]
fn the_npm_package_settings_offers_is_cli_package_jsons() {
    let file = concat!(env!("CARGO_MANIFEST_DIR"), "/../../cli/package.json");
    let pkg: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap();
    let name = pkg["name"].as_str().unwrap();
    assert_eq!(RELAY_CLI_PACKAGE, name);
    assert_eq!(RELAY_CLI_INSTALL, format!("npm i -g {name}"));
}
