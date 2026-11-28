// swift-tools-version:5.9
// Linked into relay-app by swift-rs (crates/relay-app/build.rs): WidgetKit reloads must come from
// the containing app's own process, so this is a static library, not a helper executable.
import PackageDescription

let package = Package(
  name: "WidgetCenter",
  platforms: [.macOS(.v14)],
  products: [
    .library(name: "WidgetCenter", type: .static, targets: ["WidgetCenter"])
  ],
  targets: [
    .target(name: "WidgetCenter", path: "Sources/WidgetCenter")
  ]
)
