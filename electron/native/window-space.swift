// window-space.node: whether a window AppKit has on screen is on the Space the user is looking
// at. macOS can leave an ordered-in window on no Space at all: AppKit and Electron both call it
// visible, nothing draws it, and only NSWindow.isOnActiveSpace tells. A Node-API addon in the
// main process, because the answer needs the NSWindow itself.
import AppKit

private let onActiveSpace: napi_callback = { env, info in
  var argc = 1
  var argv: [napi_value?] = [nil]
  _ = argv.withUnsafeMutableBufferPointer { buffer in
    napi_get_cb_info(env, info, &argc, buffer.baseAddress, nil, nil)
  }
  var data: UnsafeMutableRawPointer?
  var length = 0
  // AppKit only on the main thread, which is where Electron's main process runs JavaScript.
  guard Thread.isMainThread, argc >= 1, let value = argv[0],
    napi_get_buffer_info(env, value, &data, &length) == napi_ok,
    let data, length == MemoryLayout<UInt>.size,
    let pointer = UnsafeRawPointer(bitPattern: data.loadUnaligned(as: UInt.self))
  else { return nil }
  // BrowserWindow.getNativeWindowHandle() is the window's content NSView.
  let view = Unmanaged<NSView>.fromOpaque(pointer).takeUnretainedValue()
  guard let window = view.window, window.isVisible else { return nil }
  var result: napi_value?
  guard napi_get_boolean(env, window.isOnActiveSpace, &result) == napi_ok else { return nil }
  return result
}

@_cdecl("napi_register_module_v1")
public func registerModule(_ env: napi_env?, _ exports: napi_value?) -> napi_value? {
  var function: napi_value?
  if napi_create_function(env, "onActiveSpace", Int(bitPattern: UInt(NAPI_AUTO_LENGTH)), onActiveSpace, nil, &function) == napi_ok,
    let function
  {
    _ = napi_set_named_property(env, exports, "onActiveSpace", function)
  }
  return exports
}
