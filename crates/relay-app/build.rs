fn main() {
    // WidgetKit reloads (native/WidgetCenter): chronod accepts them only from the app's own
    // process, so the Swift package is linked in rather than run as a helper. `cfg` here is the
    // build machine's; the target decides (a Mac also cross-checks Windows and Linux).
    #[cfg(target_os = "macos")]
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        swift_rs::SwiftLinker::new("14.0")
            .with_package("WidgetCenter", "../../native/WidgetCenter")
            .link();
    }
    // The app's two commands get permissions of their own, so a capability can grant them to
    // Relay's windows only (capabilities/default.json); no other window may call them.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&["relay_invoke", "relay_send"]),
        ),
    )
    .expect("tauri build");
}
