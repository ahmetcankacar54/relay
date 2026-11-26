//! What only AppKit can tell or do: which Space a window is on, the menu bar item's place, image
//! and title, the screen geometry under it, the launch Apple event, and WidgetKit reloads.
//! Replaces Electron's window-space.node and widget-center.node addons. AppKit calls need the main
//! thread; each function that needs it returns `None`/does nothing elsewhere.

use std::ffi::{CString, c_char, c_void};
use std::sync::Arc;

use objc2::rc::Retained;
use objc2::{AllocAnyThread, MainThreadMarker};
use objc2_app_kit::{
    NSBitmapImageRep, NSCellImagePosition, NSEvent, NSFont, NSFontAttributeName,
    NSFontWeightRegular, NSImage, NSScreen, NSStatusItem, NSView, NSWindow, NSWorkspace,
};
use objc2_foundation::{
    NSAppleEventManager, NSAttributedString, NSData, NSDictionary, NSPoint, NSRect, NSSize,
    NSString, NSUserDefaults,
};
use relay_core::shared::tray_panel::{Point, Rect};
use relay_core::tray_place::{TRAY_GUID, TrayDefaults, place_tray};
use relay_core::widget_center::ReloadTimelines;

unsafe extern "C" {
    /// native/WidgetCenter (swift-rs): reloads one widget kind, or all with null.
    fn relay_reload_timelines(kind: *const c_char);
}

/// `kAEOpenApplication`, `keyAEPropData`, `keyAELaunchedAsLogInItem`.
const OPEN_APPLICATION: u32 = u32::from_be_bytes(*b"oapp");
const PROP_DATA: u32 = u32::from_be_bytes(*b"prdt");
const LAUNCHED_AS_LOGIN_ITEM: u32 = u32::from_be_bytes(*b"lgit");

/// Whether macOS opened Relay as a login item. Read from the launch Apple event, which is only
/// current while the app finishes launching: call it from Tauri's `setup`.
pub fn launched_as_login_item() -> bool {
    let Some(event) = NSAppleEventManager::sharedAppleEventManager().currentAppleEvent() else {
        return false;
    };
    // Sent directly: objc2-foundation gates these behind its CoreServices feature.
    // SAFETY: NSAppleEventDescriptor's `eventID` and `paramDescriptorForKeyword:` take and
    // return these exact types.
    let id: u32 = unsafe { objc2::msg_send![&*event, eventID] };
    let data: Option<Retained<objc2_foundation::NSAppleEventDescriptor>> =
        unsafe { objc2::msg_send![&*event, paramDescriptorForKeyword: PROP_DATA] };
    id == OPEN_APPLICATION
        && data.is_some_and(|data| data.enumCodeValue() == LAUNCHED_AS_LOGIN_ITEM)
}

/// The WidgetKit reload hook. chronod honors it only from the containing app (a packaged
/// Relay.app with its widget); elsewhere the call is a harmless no-op.
pub fn widget_reload() -> Option<ReloadTimelines> {
    Some(Arc::new(|kind: Option<&str>| {
        let kind = kind.and_then(|kind| CString::new(kind).ok());
        // SAFETY: a NUL-terminated string or null, read during the call only.
        unsafe { relay_reload_timelines(kind.as_ref().map_or(std::ptr::null(), |k| k.as_ptr())) }
    }))
}

struct StandardDefaults(Retained<NSUserDefaults>);

impl TrayDefaults for StandardDefaults {
    type Error = std::convert::Infallible;
    fn get_user_default(&mut self, key: &str) -> Result<f64, Self::Error> {
        Ok(self.0.doubleForKey(&NSString::from_str(key)))
    }
    fn set_user_default(&mut self, key: &str, value: f64) -> Result<(), Self::Error> {
        self.0.setDouble_forKey(value, &NSString::from_str(key));
        Ok(())
    }
}

/// Gives the menu bar item its first place, clear of the notch, unless it has one (tray-place.ts).
/// Call before the item is made.
pub fn place_status_item() {
    place_tray(
        &mut StandardDefaults(NSUserDefaults::standardUserDefaults()),
        TRAY_GUID,
    );
}

/// The menu bar is dark: macOS's own appearance, not Relay's Appearance setting.
pub fn menu_bar_dark() -> bool {
    NSUserDefaults::standardUserDefaults()
        .stringForKey(&NSString::from_str("AppleInterfaceStyle"))
        .is_some_and(|style| style.to_string() == "Dark")
}

/// System Settings → Accessibility → Display → Reduce motion.
pub fn prefers_reduced_motion() -> bool {
    NSWorkspace::sharedWorkspace().accessibilityDisplayShouldReduceMotion()
}

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    /// A CFStringRef, toll-free bridged to NSString.
    static kAXTrustedCheckOptionPrompt: *const NSString;
    fn AXIsProcessTrustedWithOptions(
        options: *const NSDictionary<NSString, objc2_foundation::NSNumber>,
    ) -> u8;
}

/// Electron's `systemPreferences.isTrustedAccessibilityClient(true)`: whether Relay may use
/// Accessibility, asking macOS to show its prompt (for Relay itself) when it may not.
pub fn request_accessibility_trust() -> bool {
    // SAFETY: an ApplicationServices constant and call; the dictionary lives across the call.
    unsafe {
        let options = NSDictionary::from_slices(
            &[&*kAXTrustedCheckOptionPrompt],
            &[&*objc2_foundation::NSNumber::new_bool(true)],
        );
        AXIsProcessTrustedWithOptions(&*options) != 0
    }
}

/// Whether a window AppKit has on screen is on the Space the user is looking at. macOS can leave
/// an ordered-in window on no Space at all: AppKit calls it visible, nothing draws it, and only
/// `isOnActiveSpace` tells. `None` off the main thread or for a window not on screen.
pub fn on_active_space(ns_window: *mut c_void) -> Option<bool> {
    MainThreadMarker::new()?;
    if ns_window.is_null() {
        return None;
    }
    // SAFETY: Tauri's `ns_window()` is a live NSWindow; read on the main thread.
    let window = unsafe { &*(ns_window as *const NSWindow) };
    window.isVisible().then(|| window.isOnActiveSpace())
}

/// The primary screen's height: AppKit's y runs up from its bottom edge.
fn primary_height(mtm: MainThreadMarker) -> Option<f64> {
    let screens = NSScreen::screens(mtm);
    (screens.count() > 0).then(|| screens.objectAtIndex(0).frame().size.height)
}

/// An AppKit rect as Electron's screen coordinates (points, y down from the primary's top).
fn top_left(rect: NSRect, primary: f64) -> Rect {
    Rect {
        x: rect.origin.x,
        y: primary - rect.origin.y - rect.size.height,
        width: rect.size.width,
        height: rect.size.height,
    }
}

/// The work area (menu bar and Dock excluded) of the screen holding most of `rect`, as
/// `screen.getDisplayMatching(rect).workArea` gives it.
pub fn work_area(rect: Rect) -> Option<Rect> {
    let mtm = MainThreadMarker::new()?;
    let primary = primary_height(mtm)?;
    let screens = NSScreen::screens(mtm);
    let overlap = |frame: Rect| {
        let w = (rect.x + rect.width).min(frame.x + frame.width) - rect.x.max(frame.x);
        let h = (rect.y + rect.height).min(frame.y + frame.height) - rect.y.max(frame.y);
        w.max(0.0) * h.max(0.0)
    };
    let centre = (rect.x + rect.width / 2.0, rect.y + rect.height / 2.0);
    let distance = |frame: Rect| {
        let dx = (frame.x - centre.0)
            .max(centre.0 - (frame.x + frame.width))
            .max(0.0);
        let dy = (frame.y - centre.1)
            .max(centre.1 - (frame.y + frame.height))
            .max(0.0);
        dx * dx + dy * dy
    };
    let mut best: Option<(f64, f64, Rect)> = None;
    for screen in screens.iter() {
        let frame = top_left(screen.frame(), primary);
        let candidate = (
            overlap(frame),
            -distance(frame),
            top_left(screen.visibleFrame(), primary),
        );
        if best.is_none_or(|b| (candidate.0, candidate.1) > (b.0, b.1)) {
            best = Some(candidate);
        }
    }
    best.map(|(_, _, area)| area)
}

/// The mouse pointer in screen coordinates.
pub fn cursor() -> Option<Point> {
    let mtm = MainThreadMarker::new()?;
    let primary = primary_height(mtm)?;
    let NSPoint { x, y } = NSEvent::mouseLocation();
    Some(Point { x, y: primary - y })
}

/// The menu bar item on screen: its whole status bar window, full menu bar height, as Electron's
/// `tray.getBounds()` gives it (the button inside is inset vertically).
pub fn status_item_bounds(item: &NSStatusItem) -> Option<Rect> {
    let mtm = MainThreadMarker::new()?;
    let primary = primary_height(mtm)?;
    let window = item.button(mtm)?.window()?;
    Some(top_left(window.frame(), primary))
}

/// Gives the item its stable id: AppKit keeps its place (and a Cmd-drag) under it.
pub fn set_status_item_autosave_name(item: &NSStatusItem) {
    item.setAutosaveName(Some(&NSString::from_str(TRAY_GUID)));
}

/// Draws `representations` (scale factor, PNG) as the item's image, each at its own scale, as
/// Electron's multi-representation nativeImage does. `template` lets macOS tint it.
pub fn set_status_image(item: &NSStatusItem, representations: &[(f64, &[u8])], template: bool) {
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let Some(button) = item.button(mtm) else {
        return;
    };
    let mut image: Option<Retained<NSImage>> = None;
    for &(scale, png) in representations {
        let Some(rep) = NSBitmapImageRep::imageRepWithData(&NSData::with_bytes(png)) else {
            continue;
        };
        let size = NSSize::new(
            rep.pixelsWide() as f64 / scale,
            rep.pixelsHigh() as f64 / scale,
        );
        rep.setSize(size);
        let image = image.get_or_insert_with(|| NSImage::initWithSize(NSImage::alloc(), size));
        image.addRepresentation(&rep);
    }
    let Some(image) = image else {
        return;
    };
    image.setTemplate(template);
    button.setImage(Some(&image));
    button.setImagePosition(NSCellImagePosition::ImageLeft);
    refit_click_target(&button);
}

/// Sets the item's title with digits of one width, so a countdown never shifts the items beside
/// it (Electron's `fontType: "monospacedDigit"`).
pub fn set_status_title(item: &NSStatusItem, title: &str) {
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let Some(button) = item.button(mtm) else {
        return;
    };
    let size = NSFont::menuBarFontOfSize(0.0).pointSize();
    // SAFETY: an AppKit constant, read on the main thread.
    let font = NSFont::monospacedDigitSystemFontOfSize_weight(size, unsafe { NSFontWeightRegular });
    // SAFETY: the attribute key is AppKit's; its value is an NSFont, as the key requires.
    let attributes = unsafe {
        NSDictionary::from_slices(
            &[NSFontAttributeName],
            &[&*font as &objc2::runtime::AnyObject],
        )
    };
    // SAFETY: the dictionary maps attribute names to valid attribute values.
    let text =
        unsafe { NSAttributedString::new_with_attributes(&NSString::from_str(title), &attributes) };
    button.setAttributedTitle(&text);
    refit_click_target(&button);
}

/// tray-icon catches clicks with a view over the button sized when it sets the title or icon;
/// one set here directly must resize it too, or part of the item stops answering clicks.
fn refit_click_target(button: &NSView) {
    let frame = button.frame();
    for view in button.subviews().iter() {
        if view
            .class()
            .name()
            .to_str()
            .is_ok_and(|name| name == "TaoTrayTarget")
        {
            view.setFrame(NSRect::new(NSPoint::new(0.0, 0.0), frame.size));
        }
    }
}
