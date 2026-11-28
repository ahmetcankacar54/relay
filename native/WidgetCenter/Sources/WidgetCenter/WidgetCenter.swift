// Asks WidgetKit to reload Relay's widget. chronod accepts the request only from the containing
// app's own process (a helper executable gets ChronoCoreErrorDomain 10), so relay-app links this.
import WidgetKit

/// Reloads one widget kind's timelines, or every kind when `kind` is null or empty.
@_cdecl("relay_reload_timelines")
public func relayReloadTimelines(_ kind: UnsafePointer<CChar>?) {
  if let kind, kind.pointee != 0 {
    WidgetCenter.shared.reloadTimelines(ofKind: String(cString: kind))
  } else {
    WidgetCenter.shared.reloadAllTimelines()
  }
}
