//! The system is shutting down or restarting (Electron's `powerMonitor` "shutdown", macOS and
//! Linux): `lifecycle` then quits without its safeguards for `SHUTDOWN_GRACE_MS`, since a veto
//! there would stall the system. Windows sends Electron no such event either; a Windows shutdown
//! ends Relay as before.

use crate::state::{STATE, lock};

/// Notes a shutdown signal now.
pub fn note_system_shutdown() {
    *lock(&STATE.system_shutdown_at) = Some(relay_core::clock::now_ms());
}

/// Starts listening for the system's shutdown signal; call once at startup.
pub fn watch() {
    imp::watch();
}

#[cfg(target_os = "macos")]
mod imp {
    use std::ptr::NonNull;

    use objc2_app_kit::{NSWorkspace, NSWorkspaceWillPowerOffNotification};
    use objc2_foundation::NSNotification;

    pub fn watch() {
        let block =
            block2::RcBlock::new(|_: NonNull<NSNotification>| super::note_system_shutdown());
        // SAFETY: an AppKit notification name; the block only sets a flag, from any thread.
        let observer = unsafe {
            NSWorkspace::sharedWorkspace()
                .notificationCenter()
                .addObserverForName_object_queue_usingBlock(
                    Some(NSWorkspaceWillPowerOffNotification),
                    None,
                    None,
                    &block,
                )
        };
        // Observed for the life of the app.
        std::mem::forget(observer);
    }
}

#[cfg(target_os = "linux")]
mod imp {
    /// logind's PrepareForShutdown(true): a shutdown or reboot has begun.
    pub fn watch() {
        std::thread::Builder::new()
            .name("relay-shutdown".into())
            .spawn(|| {
                let listen = || -> zbus::Result<()> {
                    let connection = zbus::blocking::Connection::system()?;
                    let manager = zbus::blocking::Proxy::new(
                        &connection,
                        "org.freedesktop.login1",
                        "/org/freedesktop/login1",
                        "org.freedesktop.login1.Manager",
                    )?;
                    for signal in manager.receive_signal("PrepareForShutdown")? {
                        if signal.body().deserialize::<bool>().unwrap_or(false) {
                            super::note_system_shutdown();
                        }
                    }
                    Ok(())
                };
                // No system bus or no logind: no signal, as with Electron there.
                let _ = listen();
            })
            .ok();
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
mod imp {
    pub fn watch() {}
}
