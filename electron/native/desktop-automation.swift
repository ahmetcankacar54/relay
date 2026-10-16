import Foundation
import AppKit
import ApplicationServices
import CryptoKit

// A bounded AX bridge. It never launches Claude, reads a credential/configuration
// file, calls private IPC or injects code. Input/output stay on the parent's pipes.
// AX cannot provide a global worker roster or an atomic cross-application lock.
let bundleID = "com.anthropic.claudefordesktop"
let localPattern = "^local_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
let allowedModes = ["Manual", "Auto", "Plan", "Accept edits"]
// Compact layouts show "Accept" for Accept edits.
func modeLabel(_ text: String) -> String? {
    if allowedModes.contains(text) { return text }
    if text == "Accept" { return "Accept edits" }
    if text.hasPrefix("PermissionMode ") { return modeLabel(String(text.dropFirst("PermissionMode ".count))) }
    return nil
}
// Menu items are named "<mode> <description>", e.g. "Accept edits Automatically accept all file edits".
func menuItemMatches(_ text: String, _ mode: String) -> Bool {
    text == mode || text.hasPrefix(mode + " ") ||
        (mode == "Accept edits" && (text == "Accept" || text.hasPrefix("Accept ")))
}

struct BridgeError: Error { let issue: String }
func fail(_ issue: String) throws -> Never { throw BridgeError(issue: issue) }
func match(_ value: String, _ pattern: String) -> Bool {
    value.range(of: pattern, options: .regularExpression) != nil
}
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var result: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &result) == .success else { return nil }
    return result
}
func stringAttribute(_ element: AXUIElement, _ name: String) -> String {
    if let value = attribute(element, name) as? String { return value }
    if let value = attribute(element, name) as? URL { return value.absoluteString }
    return ""
}
struct Node {
    let element: AXUIElement
    let role: String
    let title: String
    let description: String
    let value: String
    let url: String
    let enabled: Bool
    let path: String
    var strings: [String] { [title, description, value, url].filter { !$0.isEmpty } }
    var label: String { strings.joined(separator: " ") }
    var selectorNode: AccountSelectorNode {
        AccountSelectorNode(role: role, title: title, description: description, value: value, path: path)
    }
}

// Keep structural account selection independent of AX so the actual selector
// can be exercised with bounded fixtures, without inspecting a running app.
struct AccountSelectorNode {
    let role: String
    let title: String
    let description: String
    let value: String
    let path: String
    var strings: [String] { [title, description, value].filter { !$0.isEmpty } }
}
func accountPopupPath(_ tree: [AccountSelectorNode]) -> String? {
    let sidebars = tree.filter {
        ["AXGroup", "AXLandmark"].contains($0.role) &&
        ($0.title == "Sidebar" || $0.description == "Sidebar")
    }
    guard sidebars.count == 1, let sidebar = sidebars.first else { return nil }
    let nonAccountActions = [
        "Create project", "New from a template", "New from template", "Filter", "More options"
    ]
    let accountMenus = tree.filter { node in
        guard node.role == "AXPopUpButton", !node.strings.isEmpty,
              node.path.hasPrefix(sidebar.path + "/") else { return false }
        return !node.strings.contains { text in
            nonAccountActions.contains(text) ||
            match(text, "^More options(?: |$)") ||
            text.contains("PermissionMode") || text.contains("Model") || text.contains("Effort") ||
            allowedModes.contains(text) ||
            ["Low", "Medium", "High", "Max", "Highest"].contains(text) ||
            match(text, "^(?:Claude )?(?:Sonnet|Opus|Haiku)(?: |$)")
        }
    }
    // Unknown extra sidebar controls make the account ambiguous. Never select
    // a company/subscription label, last popup, or a popup in the main pane.
    return accountMenus.count == 1 ? accountMenus.first?.path : nil
}
func nodes(_ root: AXUIElement) throws -> [Node] {
    var result: [Node] = []
    var visited = Set<CFHashCode>()
    func walk(_ element: AXUIElement, _ depth: Int, _ path: String) throws {
        guard depth <= 64 && result.count < 60000 else { try fail("desktop-ui-unsupported") }
        let hash = CFHash(element)
        if visited.contains(hash) { return }
        visited.insert(hash)
        result.append(Node(
            element: element,
            role: stringAttribute(element, kAXRoleAttribute),
            title: stringAttribute(element, kAXTitleAttribute),
            description: stringAttribute(element, kAXDescriptionAttribute),
            value: stringAttribute(element, kAXValueAttribute),
            url: stringAttribute(element, "AXURL"),
            enabled: (attribute(element, kAXEnabledAttribute) as? Bool) ?? true,
            path: path
        ))
        let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
        for (index, child) in children.enumerated() { try walk(child, depth + 1, "\(path)/\(index)") }
    }
    try walk(root, 0, "root")
    return result
}

struct Observation {
    let app: NSRunningApplication
    let tree: [Node]
    let composer: Node?
    let send: Node?
    let permission: Node?
    let fields: [String: Any]
}
// The conversation ids a web area advertises through its epitaxy URL.
func epitaxySessionIDs(_ strings: [String]) -> Set<String> {
    var ids = Set<String>()
    for text in strings where text.contains("claude.ai/epitaxy/local_") {
        guard let range = text.range(of: "local_[0-9a-fA-F-]{36}", options: .regularExpression) else { continue }
        let id = String(text[range])
        if match(id, localPattern) { ids.insert(id) }
    }
    return ids
}
// Cheap re-read of only the web areas an earlier observe() already found: a few
// attribute reads, no tree walk. Used right before a write that replaces text.
func liveSessionIDs(_ observation: Observation) -> Set<String> {
    let strings = observation.tree.filter { $0.role == "AXWebArea" }.flatMap { node in
        [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute, "AXURL"].map { stringAttribute(node.element, $0) }
    }
    return epitaxySessionIDs(strings.filter { !$0.isEmpty })
}
func observe() throws -> Observation {
    guard AXIsProcessTrusted() else { try fail("accessibility-permission-required") }
    let apps = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
        .filter { !$0.isTerminated }
    guard apps.count == 1, let app = apps.first else { try fail(apps.isEmpty ? "claude-not-running" : "desktop-ui-unsupported") }
    let root = AXUIElementCreateApplication(app.processIdentifier)
    let tree = try nodes(root)
    let webAreas = tree.filter { $0.role == "AXWebArea" }
    let localIDs = epitaxySessionIDs(webAreas.flatMap { $0.strings })
    // Several web surfaces, ambiguous aliases or unsupported URL exposure block
    // targeting. A title or a sidebar card is never a conversation identity.
    let localID = localIDs.count == 1 ? localIDs.first : nil
    let composers = tree.filter {
        ["AXTextArea", "AXTextField"].contains($0.role) &&
        ($0.description == "Prompt" || $0.title == "Prompt")
    }
    let composer = composers.count == 1 ? composers.first : nil
    let sends = tree.filter { $0.role == "AXButton" && ($0.title == "Send" || $0.description == "Send") }
    let send = sends.count == 1 ? sends.first : nil
    // The selector carries the "Permission mode" label. Scheduled task rows also
    // show "Auto"/"Manual", so a bare mode label is only a fallback.
    let buttons = tree.filter { ["AXPopUpButton", "AXButton"].contains($0.role) }
    let labeled = buttons.filter { node in
        node.strings.contains { $0.contains("PermissionMode") || $0.contains("Permission mode") }
    }
    let permissionNodes = labeled.isEmpty
        ? buttons.filter { node in node.strings.contains { modeLabel($0) != nil } }
        : labeled
    let permission = permissionNodes.count == 1 ? permissionNodes.first : nil
    let mode = permission.flatMap { node in node.strings.lazy.compactMap(modeLabel).first }
    // Account selection is scoped to the one named Sidebar container. Session
    // actions and project/model/usage menus elsewhere cannot become an account.
    let accountPath = accountPopupPath(tree.map { $0.selectorNode })
    let account = tree.first { $0.path == accountPath }.map { node in
        node.strings.reduce(into: [String]()) { unique, text in
            if !unique.contains(text) { unique.append(text) }
        }.joined(separator: " ")
    }
    let finished = tree.contains { $0.strings.contains("Claude finished the response") }
    // "Session", "Weekly", "Usage", "<model>" and "Monthly spend limit reached".
    let quota = tree.contains { $0.strings.contains { $0.hasSuffix(" limit reached") } }
    let working = tree.contains { $0.role == "AXButton" && ["Stop", "Stop response", "Stop Claude"].contains(where: $0.strings.contains) }
    let waiting = tree.contains { node in
        node.role == "AXDialog" || ["Approve", "Allow once", "Allow always", "Reject"].contains(where: node.strings.contains)
    }
    let autoResume = tree.filter { $0.role == "AXCheckBox" && $0.strings.contains("Auto-continue when limits reset") }
    let autoChecked = autoResume.count == 1 ? attribute(autoResume[0].element, kAXValueAttribute) as? Bool : nil
    let visibleActive = tree.filter { ["Running", "Working"].contains(where: $0.strings.contains) }.count
    let visibleWaiting = tree.filter { ["Waiting", "Needs approval", "Waiting for permission"].contains(where: $0.strings.contains) }.count
    let visibleScheduled = tree.filter { ["Scheduled", "Queued"].contains(where: $0.strings.contains) }.count
    // A loaded composer without a stop/dialog is a UI idle observation, never a
    // worker proof. The evidence adapter additionally requires a terminal latest
    // transcript turn before permitting a still-alive selected engine.
    let status = waiting ? "waiting" : working ? "running" : (finished || composer != nil) ? "stopped" : "unknown"
    var stable: [String: Any] = [
        "pid": Int(app.processIdentifier), "status": status,
        "quotaStopped": quota && status == "stopped",
        "composerEmpty": composer?.value.isEmpty == true,
        "sendEnabled": send?.enabled == true,
        "visibleActiveTasks": visibleActive,
        "visibleWaitingTasks": visibleWaiting,
        "visibleScheduledTasks": visibleScheduled,
        "coverage": "active-conversation-only"
    ]
    if let id = localID { stable["localSessionId"] = id }
    if let label = account { stable["accountLabel"] = label }
    if let value = mode { stable["permissionMode"] = value }
    if let checked = autoChecked { stable["quotaAutoResume"] = checked }
    let serialized = try JSONSerialization.data(withJSONObject: stable, options: [.sortedKeys])
    var fields = stable
    fields["contextFingerprint"] = SHA256.hash(data: serialized).map { String(format: "%02x", $0) }.joined()
    fields["observedAt"] = Int(Date().timeIntervalSince1970 * 1000)
    return Observation(app: app, tree: tree, composer: composer, send: send, permission: permission, fields: fields)
}
func validateGuard(_ observation: Observation, _ expected: [String: Any], allowComposer: Bool = false) throws {
    for field in ["pid", "localSessionId", "accountLabel", "permissionMode"] {
        guard let want = expected[field], let actual = observation.fields[field],
              String(describing: want) == String(describing: actual) else { try fail("context-changed") }
    }
    if !allowComposer {
        guard expected["contextFingerprint"] as? String == observation.fields["contextFingerprint"] as? String else { try fail("context-changed") }
    }
    guard observation.fields["status"] as? String == "stopped" else { try fail("desktop-work-active") }
    guard observation.composer != nil && observation.send != nil else { try fail("desktop-ui-unsupported") }
    if !allowComposer && observation.fields["composerEmpty"] as? Bool != true { try fail("composer-not-empty") }
}
func press(_ node: Node) throws {
    guard node.enabled, AXUIElementPerformAction(node.element, kAXPressAction as CFString) == .success else { try fail("desktop-ui-unsupported") }
}
func markerPresent(_ observation: Observation, _ marker: String) -> Bool {
    observation.tree.contains { node in
        if let composer = observation.composer, node.path == composer.path || node.path.hasPrefix(composer.path + "/") { return false }
        return node.strings.contains { $0.contains(marker) }
    }
}
func writeComposer(_ observation: Observation, _ body: String) throws {
    guard let composer = observation.composer else { try fail("desktop-ui-unsupported") }
    if AXUIElementSetAttributeValue(composer.element, kAXValueAttribute as CFString, body as CFString) == .success { return }
    // Chromium contenteditable fields can reject AXSetValue. The fallback is a
    // normal focused paste. Restore the prior clipboard only if it is still ours;
    // never overwrite a clipboard change made by the user during this action.
    guard observation.app.activate(options: []),
          AXUIElementSetAttributeValue(composer.element, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success,
          let down = CGEvent(keyboardEventSource: nil, virtualKey: 9, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: 9, keyDown: false) else { try fail("desktop-ui-unsupported") }
    func focusHeld() -> Bool {
        NSWorkspace.shared.frontmostApplication?.processIdentifier == observation.app.processIdentifier &&
            attribute(composer.element, kAXFocusedAttribute) as? Bool == true
    }
    guard focusHeld() else { try fail("context-changed") }
    let focused = try observe()
    for field in ["pid", "localSessionId", "accountLabel", "permissionMode", "status", "composerEmpty"] {
        guard let before = observation.fields[field], let after = focused.fields[field],
              String(describing: before) == String(describing: after) else { try fail("context-changed") }
    }
    // The re-observe walks the whole tree and takes time; focus or the frontmost
    // app may have moved meanwhile. Check again right before the paste.
    guard focusHeld() else { try fail("context-changed") }
    let board = NSPasteboard.general
    let original: [(NSPasteboard.PasteboardType, Data)] = (board.types ?? []).compactMap { type in
        board.data(forType: type).map { (type, $0) }
    }
    board.clearContents()
    guard board.setString(body, forType: .string) else { try fail("desktop-ui-unsupported") }
    let owned = board.changeCount
    defer {
        if board.changeCount == owned {
            board.clearContents()
            for (type, data) in original { board.setData(data, forType: type) }
        }
    }
    down.flags = .maskCommand
    up.flags = .maskCommand
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
    // Give this ordinary UI event bounded time to arrive. Caller rereads the
    // exact account/session/mode and whole composer before a separate send click.
    Thread.sleep(forTimeInterval: 0.15)
}
func handle(_ request: [String: Any]) throws -> [String: Any] {
    guard let command = request["command"] as? String else { try fail("desktop-ui-unsupported") }
    if command == "request-accessibility" {
        // Only the foreground explicit Relay permission action requests this.
        // Polling inspect never calls AXIsProcessTrustedWithOptions(prompt:true).
        let trusted = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
        return ["ok": true, "accessibilityGranted": trusted]
    }
    if command == "inspect" { return ["ok": true, "snapshot": try observe().fields] }
    if command == "open-session" {
        guard let id = request["localSessionId"] as? String, match(id, localPattern) else { try fail("exact-session-not-observed") }
        // Inspect first: opening a protocol URL must never launch a closed app.
        _ = try observe()
        guard let url = URL(string: "claude://code/continue?session=\(id)"),
              NSWorkspace.shared.open(url) else { try fail("desktop-ui-unsupported") }
        return ["ok": true]
    }
    if command == "lookup" {
        guard let requestID = request["requestId"] as? String, match(requestID, "^[A-Za-z0-9._:-]{1,128}$") else { try fail("desktop-ui-unsupported") }
        return ["ok": true, "markerPresent": markerPresent(try observe(), "[Relay continuation: \(requestID)]")]
    }
    guard let expected = request["guard"] as? [String: Any] else { try fail("context-changed") }
    var current = try observe()
    try validateGuard(current, expected)
    if command == "cancel-quota-resume" {
        let controls = current.tree.filter { $0.role == "AXCheckBox" && $0.strings.contains("Auto-continue when limits reset") }
        guard current.fields["quotaStopped"] as? Bool == true,
              controls.count == 1, let control = controls.first,
              let checked = attribute(control.element, kAXValueAttribute) as? Bool else { try fail("desktop-ui-unsupported") }
        if checked { try press(control) }
        current = try observe()
        guard current.fields["quotaAutoResume"] as? Bool == false else { try fail("context-changed") }
        return ["ok": true, "snapshot": current.fields]
    }
    if command == "set-permission" {
        guard let mode = request["mode"] as? String, allowedModes.contains(mode), let selector = current.permission else { try fail("permission-mode-mismatch") }
        if current.fields["permissionMode"] as? String == mode { return ["ok": true, "snapshot": current.fields] }
        try press(selector)
        current = try observe()
        guard current.fields["pid"] as? Int == expected["pid"] as? Int,
              current.fields["localSessionId"] as? String == expected["localSessionId"] as? String,
              current.fields["accountLabel"] as? String == expected["accountLabel"] as? String else { try fail("context-changed") }
        let items = current.tree.filter { node in
            node.role == "AXMenuItem" && (node.strings.contains { menuItemMatches($0, mode) } || menuItemMatches(node.label, mode))
        }
        guard items.count == 1, let item = items.first else { try fail("permission-mode-mismatch") }
        try press(item)
        current = try observe()
        guard current.fields["permissionMode"] as? String == mode else { try fail("permission-mode-mismatch") }
        return ["ok": true, "snapshot": current.fields]
    }
    if command == "send" {
        guard let requestID = request["requestId"] as? String, match(requestID, "^[A-Za-z0-9._:-]{1,128}$"),
              let text = request["text"] as? String, !text.isEmpty, text.utf8.count <= 32768, !text.contains("\0"),
              current.composer != nil else { try fail("desktop-ui-unsupported") }
        let marker = "[Relay continuation: \(requestID)]"
        // A visible prior marker is a reconciliation requirement, not permission
        // to send again. A durable transcript lookup is the parent's responsibility.
        if markerPresent(current, marker) { try fail("delivery-ambiguous") }
        let body = text + "\n\n" + marker
        try writeComposer(current, body)
        current = try observe()
        try validateGuard(current, expected, allowComposer: true)
        guard current.composer?.value == body, let send = current.send, send.enabled else { try fail("delivery-ambiguous") }
        // There is no atomic lock across AX clients. This is one guarded attempt,
        // never an exactly-once transport. Ambiguous results must not be retried.
        try press(send)
        current = try observe()
        return ["ok": true, "acceptedVisible": current.fields["composerEmpty"] as? Bool == true && markerPresent(current, marker)]
    }
    if command == "write-draft" {
        // Re-types an unsent draft. It never presses Send and adds no marker. The
        // guard above required the same account/session/mode, a stopped conversation
        // and an empty composer, but that was sampled during the observe() tree walk,
        // which can be long. Re-read the composer value and the conversation id
        // directly right before the write. This narrows the race with a user typing
        // or switching conversations; it cannot close it, as AX has no atomic lock.
        guard let text = request["text"] as? String, !text.isEmpty, text.utf8.count <= 65536, !text.contains("\0"),
              let composer = current.composer else { try fail("desktop-ui-unsupported") }
        guard let live = attribute(composer.element, kAXValueAttribute) as? String, live.isEmpty else { try fail("composer-not-empty") }
        let sessions = liveSessionIDs(current)
        guard sessions.count == 1, sessions.first == expected["localSessionId"] as? String else { try fail("context-changed") }
        try writeComposer(current, text)
        current = try observe()
        try validateGuard(current, expected, allowComposer: true)
        // One guarded attempt, never retried: a composer that does not read back
        // exactly is ambiguous, not a reason to type again.
        guard current.composer?.value == text else { try fail("delivery-ambiguous") }
        return ["ok": true, "snapshot": current.fields]
    }
    try fail("desktop-ui-unsupported")
}

#if RELAY_AX_SELECTOR_FIXTURE
// This compilation mode deliberately has no live AX dispatcher. Fixtures may
// only call the pure selector; they cannot request permission or inspect apps.
do {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    guard input.count <= 65536,
          let values = try JSONSerialization.jsonObject(with: input) as? [[String: String]] else { try fail("desktop-ui-unsupported") }
    let tree = values.map {
        AccountSelectorNode(role: $0["role"] ?? "", title: $0["title"] ?? "", description: $0["description"] ?? "", value: $0["value"] ?? "", path: $0["path"] ?? "")
    }
    let result: [String: Any] = ["accountPath": accountPopupPath(tree) as Any? ?? NSNull()]
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]))
} catch {
    FileHandle.standardOutput.write(Data("{\"error\":\"invalid-fixture\"}".utf8))
}
#else
do {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    guard input.count <= 65536,
          let request = try JSONSerialization.jsonObject(with: input) as? [String: Any] else { try fail("desktop-ui-unsupported") }
    let output = try JSONSerialization.data(withJSONObject: try handle(request), options: [.sortedKeys])
    FileHandle.standardOutput.write(output)
} catch {
    let issue = (error as? BridgeError)?.issue ?? "desktop-ui-unsupported"
    if let output = try? JSONSerialization.data(withJSONObject: ["ok": false, "issue": issue], options: [.sortedKeys]) {
        FileHandle.standardOutput.write(output)
    }
}
#endif
