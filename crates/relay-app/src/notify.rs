//! System notifications whose click opens the page they name, as Electron's `notice.on("click",
//! () => openPage(...))` did. The notification plugin delivers no clicks, so each platform's own
//! API posts the notice: UNUserNotificationCenter on macOS (bundled app only; a bare development
//! binary has no bundle to post for), WinRT toasts on Windows, the freedesktop D-Bus service on
//! Linux. `show` returns false when the caller should fall back to the plugin.

use relay_core::host::Notice;
use tauri::AppHandle;

/// A click on a notice: the main window on its page.
fn clicked(app: &AppHandle, action: &str) {
    let app = app.clone();
    let action = action.to_owned();
    let _ = app.clone().run_on_main_thread(move || {
        crate::windows::main::open_page(&app, &action, None);
    });
}

/// Posts `notice`; false when this platform path is unavailable and the plugin should post it.
pub fn show(app: &AppHandle, notice: &Notice) -> bool {
    imp::show(app, notice)
}

#[cfg(target_os = "macos")]
mod imp {
    use std::sync::OnceLock;

    use block2::DynBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, Bool, NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{AllocAnyThread, define_class, msg_send};
    use objc2_foundation::{NSBundle, NSDictionary, NSError, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNMutableNotificationContent, UNNotification,
        UNNotificationDefaultActionIdentifier, UNNotificationPresentationOptions,
        UNNotificationRequest, UNNotificationResponse, UNNotificationSound,
        UNUserNotificationCenter, UNUserNotificationCenterDelegate,
    };
    use relay_core::host::Notice;
    use tauri::AppHandle;

    const ACTION_KEY: &str = "relayAction";

    static APP: OnceLock<AppHandle> = OnceLock::new();

    define_class!(
        #[unsafe(super(NSObject))]
        #[name = "RelayNoticeDelegate"]
        struct NoticeDelegate;

        unsafe impl NSObjectProtocol for NoticeDelegate {}

        unsafe impl UNUserNotificationCenterDelegate for NoticeDelegate {
            /// Shown while Relay is in front too, as Electron's notices were.
            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            fn will_present(
                &self,
                _center: &UNUserNotificationCenter,
                _notification: &UNNotification,
                handler: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
            ) {
                handler.call((UNNotificationPresentationOptions::Banner
                    | UNNotificationPresentationOptions::List
                    | UNNotificationPresentationOptions::Sound,));
            }

            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn did_receive(
                &self,
                _center: &UNUserNotificationCenter,
                response: &UNNotificationResponse,
                handler: &DynBlock<dyn Fn()>,
            ) {
                // SAFETY: a UserNotifications constant.
                let default = unsafe { UNNotificationDefaultActionIdentifier };
                if &*response.actionIdentifier() == default
                    && let Some(app) = APP.get()
                    && let Some(action) = action_of(response)
                {
                    super::clicked(app, &action);
                }
                handler.call(());
            }
        }
    );

    fn action_of(response: &UNNotificationResponse) -> Option<String> {
        let info = response.notification().request().content().userInfo();
        let key = NSString::from_str(ACTION_KEY);
        // SAFETY: `objectForKey:` with an NSString key; the value Relay stored is an NSString.
        let value: Option<Retained<AnyObject>> = unsafe { msg_send![&*info, objectForKey: &*key] };
        Some(value?.downcast::<NSString>().ok()?.to_string())
    }

    /// The center, with Relay's delegate and the permission asked once; `None` for a binary
    /// outside an app bundle (UNUserNotificationCenter aborts there).
    fn center(app: &AppHandle) -> Option<Retained<UNUserNotificationCenter>> {
        static READY: OnceLock<bool> = OnceLock::new();
        let ready = *READY.get_or_init(|| {
            let bundle = NSBundle::mainBundle();
            let bundled = bundle.bundleIdentifier().is_some()
                && bundle.bundlePath().to_string().ends_with(".app");
            if !bundled {
                return false;
            }
            let _ = APP.set(app.clone());
            let delegate: Retained<NoticeDelegate> =
                unsafe { msg_send![NoticeDelegate::alloc(), init] };
            let delegate =
                ProtocolObject::<dyn UNUserNotificationCenterDelegate>::from_retained(delegate);
            let center = UNUserNotificationCenter::currentNotificationCenter();
            center.setDelegate(Some(&delegate));
            // The center holds its delegate weakly: it lives as long as the app.
            std::mem::forget(delegate);
            center.requestAuthorizationWithOptions_completionHandler(
                UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
                &block2::RcBlock::new(|_granted: Bool, _error: *mut NSError| {}),
            );
            true
        });
        ready.then(UNUserNotificationCenter::currentNotificationCenter)
    }

    pub fn show(app: &AppHandle, notice: &Notice) -> bool {
        let Some(center) = center(app) else {
            return false;
        };
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(&notice.title));
        content.setBody(&NSString::from_str(&notice.body));
        if !notice.silent {
            content.setSound(Some(&UNNotificationSound::defaultSound()));
        }
        if let Some(action) = &notice.action {
            let key = NSString::from_str(ACTION_KEY);
            let value = NSString::from_str(action);
            let info = NSDictionary::from_slices(&[&*key], &[&*value]);
            // SAFETY: a property-list dictionary (string to string), as userInfo requires.
            unsafe { content.setUserInfo(Retained::cast_unchecked::<NSDictionary>(info).as_ref()) };
        }
        let id = NSString::from_str(&uuid::Uuid::new_v4().to_string());
        let request =
            UNNotificationRequest::requestWithIdentifier_content_trigger(&id, &content, None);
        center.addNotificationRequest_withCompletionHandler(&request, None);
        true
    }
}

#[cfg(windows)]
mod imp {
    use relay_core::host::Notice;
    use tauri::AppHandle;
    use tauri_winrt_notification::{Sound, Toast};

    /// The installed app's AppUserModelID is its identifier; a development binary posts as
    /// PowerShell, as the notification plugin does.
    fn app_id(app: &AppHandle) -> String {
        let installed = std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(|dir| dir.to_path_buf()))
            .is_some_and(|dir| {
                !dir.ends_with("target\\debug") && !dir.ends_with("target\\release")
            });
        if installed {
            app.config().identifier.clone()
        } else {
            Toast::POWERSHELL_APP_ID.to_owned()
        }
    }

    pub fn show(app: &AppHandle, notice: &Notice) -> bool {
        let mut toast = Toast::new(&app_id(app))
            .title(&notice.title)
            .text1(&notice.body)
            .sound(if notice.silent {
                None
            } else {
                Some(Sound::Default)
            });
        if let Some(action) = notice.action.clone() {
            let app = app.clone();
            toast = toast.on_activated(move |_| {
                super::clicked(&app, &action);
                Ok(())
            });
        }
        toast.show().is_ok()
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use relay_core::host::Notice;
    use tauri::AppHandle;

    /// The freedesktop "default" action: a click on the notice body.
    const DEFAULT_ACTION: &str = "default";

    pub fn show(app: &AppHandle, notice: &Notice) -> bool {
        let mut notification = notify_rust::Notification::new();
        notification
            .appname("Relay")
            .summary(&notice.title)
            .body(&notice.body)
            .auto_icon();
        if !notice.silent {
            notification.sound_name("message-new-instant");
        }
        if notice.action.is_some() {
            notification.action(DEFAULT_ACTION, "Open");
        }
        let app = app.clone();
        let action = notice.action.clone();
        // Showing and waiting for the click both talk to D-Bus: off the caller's thread.
        std::thread::spawn(move || {
            let Ok(handle) = notification.show() else {
                return;
            };
            if let Some(action) = action {
                handle.wait_for_action(|clicked| {
                    if clicked == DEFAULT_ACTION {
                        super::clicked(&app, &action);
                    }
                });
            }
        });
        true
    }
}

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
mod imp {
    pub fn show(_app: &tauri::AppHandle, _notice: &relay_core::host::Notice) -> bool {
        false
    }
}
