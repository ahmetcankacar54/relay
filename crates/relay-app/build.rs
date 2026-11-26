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
    let mut attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(&["relay_invoke", "relay_send"]));
    // Windows: tauri-build embeds the Common Controls v6 manifest in the app binary only, and an
    // integration test linking Tauri then dies at load (STATUS_ENTRYPOINT_NOT_FOUND). Embed it
    // through the linker instead, for every binary of this crate.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        let manifest = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap())
            .join("windows")
            .join("app.manifest");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
        attributes = attributes
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
    }
    tauri_build::try_build(attributes).expect("tauri build");
}
