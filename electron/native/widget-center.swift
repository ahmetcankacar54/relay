// widget-center.node: asks WidgetKit to reload Relay's widget. chronod accepts
// the request only from the containing app's own process, so this is a
// Node-API addon loaded into Electron's main process, not a helper executable.
import WidgetKit

private let reloadTimelines: napi_callback = { env, info in
  var argc = 1
  var argv: [napi_value?] = [nil]
  _ = argv.withUnsafeMutableBufferPointer { buffer in
    napi_get_cb_info(env, info, &argc, buffer.baseAddress, nil, nil)
  }
  var kind = [CChar](repeating: 0, count: 128)
  var length = 0
  if argc >= 1, let value = argv[0],
    napi_get_value_string_utf8(env, value, &kind, kind.count, &length) == napi_ok,
    length > 0
  {
    WidgetCenter.shared.reloadTimelines(ofKind: String(cString: kind))
  } else {
    WidgetCenter.shared.reloadAllTimelines()
  }
  return nil
}

@_cdecl("napi_register_module_v1")
public func registerModule(_ env: napi_env?, _ exports: napi_value?) -> napi_value? {
  var function: napi_value?
  if napi_create_function(env, "reloadTimelines", Int(bitPattern: UInt(NAPI_AUTO_LENGTH)), reloadTimelines, nil, &function) == napi_ok,
    let function
  {
    _ = napi_set_named_property(env, exports, "reloadTimelines", function)
  }
  return exports
}
