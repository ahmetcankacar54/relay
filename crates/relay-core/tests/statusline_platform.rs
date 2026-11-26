//! Port of the `relay-cli-path` and `shared/cli-package` cases of tests/statusline.test.ts; the
//! line, the snapshot and the installer are in statusline.rs and shared_statusline.rs, the CLI
//! cases in relay-cli.

use std::fs;
use std::path::Path;
#[cfg(unix)]
use std::path::PathBuf;
#[cfg(unix)]
use std::time::Instant;

use relay_core::relay_cli_path::relay_cli_candidates;
#[cfg(unix)]
use relay_core::relay_cli_path::{
    FindRelayCliOptions, find_relay_cli, is_relay_cli, login_shell_relay,
};
use relay_core::relay_paths::Platform;
use relay_core::shared::cli_package::{RELAY_CLI_INSTALL, RELAY_CLI_PACKAGE};

#[cfg(unix)]
fn temp() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::Builder::new()
        .prefix("relay-statusline-")
        .tempdir()
        .unwrap();
    let real = fs::canonicalize(dir.path()).unwrap();
    (dir, real)
}

#[test]
fn the_npm_package_settings_offers_is_cli_package_jsons() {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../cli/package.json");
    let pkg: serde_json::Value = serde_json::from_slice(&fs::read(manifest).unwrap()).unwrap();
    assert_eq!(RELAY_CLI_PACKAGE, pkg["name"].as_str().unwrap());
    assert_eq!(
        RELAY_CLI_INSTALL,
        format!("npm i -g {}", pkg["name"].as_str().unwrap())
    );
}

/// An npm global install of the relay CLI under `prefix`: the package, and the bin link to
/// its launcher (0.1.x: `dist/relay.js`).
#[cfg(unix)]
fn npm_install(prefix: &Path, legacy: bool) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let package = prefix
        .join("lib")
        .join("node_modules")
        .join("@ahmetcankacar")
        .join("relay");
    let launcher = if legacy {
        package.join("dist").join("relay.js")
    } else {
        package.join("launcher.js")
    };
    fs::create_dir_all(launcher.parent().unwrap()).unwrap();
    fs::write(&launcher, "#!/usr/bin/env node\n").unwrap();
    fs::set_permissions(&launcher, fs::Permissions::from_mode(0o755)).unwrap();
    let bin = prefix.join("bin");
    fs::create_dir_all(&bin).unwrap();
    std::os::unix::fs::symlink(&launcher, bin.join("relay")).unwrap();
    bin.join("relay")
}

/// The prebuilt binary npm installs for this package's launcher, under `node_modules`, for a
/// Mac.
#[cfg(unix)]
fn prebuilt(node_modules: &Path) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let binary = node_modules
        .join("@ahmetcankacar")
        .join(format!(
            "relay-darwin-{}",
            relay_core::mac_update::node_arch()
        ))
        .join("bin")
        .join("relay");
    fs::create_dir_all(binary.parent().unwrap()).unwrap();
    fs::write(&binary, "binary").unwrap();
    fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).unwrap();
    binary
}

#[cfg(unix)]
fn path_env(path: &str) -> std::collections::BTreeMap<String, String> {
    [("PATH".to_owned(), path.to_owned())].into_iter().collect()
}

/// npm installs symlinks only on macOS and Linux.
#[cfg(unix)]
#[test]
fn relay_app_finds_the_relay_cli_on_path_or_in_the_usual_install_folders_and_only_this_packages() {
    use std::os::unix::fs::PermissionsExt;
    let (_guard, home) = temp();
    let home_text = home.to_string_lossy().into_owned();
    let find = |env: std::collections::BTreeMap<String, String>,
                login_shell: &dyn Fn() -> Option<PathBuf>| {
        find_relay_cli(FindRelayCliOptions {
            env: Some(env),
            home: Some(home_text.clone()),
            platform: Some(Platform::MacOs),
            system_dirs: Some(Vec::new()),
            login_shell: Some(login_shell),
        })
    };
    let never = || -> Option<PathBuf> {
        panic!("the login shell is asked only when nothing else has relay")
    };
    // A Mac app's bare PATH, and none of this machine's own folders.
    let bare = path_env(&home.join("empty").to_string_lossy());
    // Not installed: nowhere, and the login shell does not know it either.
    let asked = std::cell::Cell::new(0);
    assert_eq!(
        find(bare.clone(), &|| {
            asked.set(asked.get() + 1);
            None
        }),
        None
    );
    assert_eq!(asked.get(), 1);
    // Another program called relay is not ours.
    let other = home.join("other").join("relay");
    fs::create_dir_all(other.parent().unwrap()).unwrap();
    fs::write(&other, "#!/bin/sh\necho relay\n").unwrap();
    fs::set_permissions(&other, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(!is_relay_cli(&other));
    let other_path = other.clone();
    assert_eq!(
        find(
            path_env(&other.parent().unwrap().to_string_lossy()),
            &move || Some(other_path.clone())
        ),
        None
    );
    // On PATH.
    let on_path = npm_install(&home.join("prefix"), false);
    assert_eq!(
        find(
            path_env(&format!(
                "{}:{}",
                other.parent().unwrap().display(),
                on_path.parent().unwrap().display()
            )),
            &never
        ),
        Some(on_path.clone())
    );
    // With its prebuilt binary beside the package (nested, or hoisted next to it), the status
    // line runs that and starts no Node.
    let alone = || path_env(&on_path.parent().unwrap().to_string_lossy());
    let modules = home.join("prefix/lib/node_modules");
    let nested = prebuilt(&modules.join("@ahmetcankacar/relay/node_modules"));
    assert_eq!(find(alone(), &never), Some(nested));
    fs::remove_dir_all(modules.join("@ahmetcankacar/relay/node_modules")).unwrap();
    let hoisted = prebuilt(&modules);
    assert_eq!(find(alone(), &never), Some(hoisted.clone()));
    fs::remove_dir_all(hoisted.parent().unwrap().parent().unwrap()).unwrap();
    assert_eq!(find(alone(), &never), Some(on_path.clone()));
    // Off the PATH, in an nvm version's bin folder (newest first); the older one holds a 0.1.x
    // install, whose launcher was dist/relay.js.
    let nvm = npm_install(&home.join(".nvm/versions/node/v22.12.0"), true);
    let newer = npm_install(&home.join(".nvm/versions/node/v24.1.0"), false);
    let candidates = relay_cli_candidates(&bare, &home_text, Platform::MacOs, &[]);
    let index = |file: &Path| {
        candidates
            .iter()
            .position(|c| Path::new(c) == file)
            .unwrap()
    };
    assert!(index(&newer) < index(&nvm));
    assert_eq!(find(bare.clone(), &never), Some(newer));
    // Only the login shell knows it (a custom npm prefix set in .zshrc).
    let custom = npm_install(&home.join("custom"), false);
    fs::remove_dir_all(home.join(".nvm")).unwrap();
    let answer = custom.clone();
    assert_eq!(find(bare, &move || Some(answer.clone())), Some(custom));
}

/// No login shell on Windows.
#[cfg(unix)]
#[test]
fn the_login_shell_is_asked_with_a_deadline_and_what_its_startup_files_print_is_ignored() {
    use std::os::unix::fs::PermissionsExt;
    let (_guard, home) = temp();
    let relay = npm_install(&home.join("custom"), false);
    // A shell whose startup prints a greeting, then runs the lookup as `-ilc` asks.
    let chatty = home.join("chatty-sh");
    fs::write(
        &chatty,
        "#!/bin/sh\necho \"Welcome back\"\nshift\nexec /bin/sh -c \"$1\"\n",
    )
    .unwrap();
    fs::set_permissions(&chatty, fs::Permissions::from_mode(0o755)).unwrap();
    let mut env = path_env(&format!(
        "{}:/usr/bin:/bin",
        relay.parent().unwrap().display()
    ));
    env.insert("SHELL".into(), chatty.to_string_lossy().into_owned());
    assert_eq!(login_shell_relay(&env, 2_000), Some(relay));
    // A shell that never answers is given up on at the deadline.
    let stuck = home.join("stuck-sh");
    fs::write(&stuck, "#!/bin/sh\nsleep 10\n").unwrap();
    fs::set_permissions(&stuck, fs::Permissions::from_mode(0o755)).unwrap();
    let started = Instant::now();
    let mut env = path_env("/usr/bin:/bin");
    env.insert("SHELL".into(), stuck.to_string_lossy().into_owned());
    assert_eq!(login_shell_relay(&env, 300), None);
    assert!(started.elapsed().as_millis() < 2_000);
    assert_eq!(login_shell_relay(&path_env("/usr/bin:/bin"), 2_000), None);
}

#[test]
fn on_windows_the_usual_folder_is_npms_in_appdata() {
    let env = [
        ("Path".to_owned(), "C:\\Windows".to_owned()),
        (
            "APPDATA".to_owned(),
            "C:\\Users\\ada\\AppData\\Roaming".to_owned(),
        ),
    ]
    .into_iter()
    .collect();
    assert_eq!(
        relay_cli_candidates(&env, "C:\\Users\\ada", Platform::Windows, &[]),
        vec![
            "C:\\Windows\\relay".to_owned(),
            "C:\\Users\\ada\\AppData\\Roaming\\npm\\relay".to_owned(),
        ]
    );
}
