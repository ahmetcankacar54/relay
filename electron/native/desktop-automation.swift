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
// An element's text for observation: a missing or non-text AXValue is "".
func valueText(_ element: AXUIElement) -> String { stringAttribute(element, kAXValueAttribute) }
// Marks that take no room on screen. An embedded object (U+FFFC, a mention or a file
// chip) is not among them: it is content.
let zeroWidth: Set<Unicode.Scalar> = ["\u{200B}", "\u{200C}", "\u{200D}", "\u{2060}", "\u{FEFF}"]
// The characters of `text` that show: no spaces, line breaks or zero-width marks.
func visibleText(_ text: String) -> String {
    String(String.UnicodeScalarView(text.unicodeScalars.filter {
        !CharacterSet.whitespacesAndNewlines.contains($0) && !zeroWidth.contains($0)
    }))
}
// Claude's composer is a tiptap editor. Empty, it holds one paragraph kept open by a line
// break, which tiptap gives this class and whose ::before draws the placeholder; Chromium
// can read both into the composer's value, so an empty composer never reads as "".
let emptyEditorClass = "is-editor-empty"
// Why a composer whose AXValue is `value` reads as empty, or nil when it holds text: no
// visible character, tiptap's empty-editor class on a node in it, or a value that is
// only its placeholder.
func composerEmptyReason(value: String, emptyEditorMarked: Bool, placeholder: String) -> String? {
    if value.isEmpty { return "empty" }
    if visibleText(value).isEmpty { return "blank" }
    if emptyEditorMarked { return "editor-empty" }
    if !visibleText(placeholder).isEmpty && visibleText(value) == visibleText(placeholder) { return "placeholder" }
    return nil
}
// Whether `element` or a node a few levels inside it carries tiptap's empty-editor class.
func marksEmptyEditor(_ element: AXUIElement, depth: Int = 3) -> Bool {
    if (attribute(element, "AXDOMClassList") as? [String])?.contains(emptyEditorClass) == true { return true }
    guard depth > 0 else { return false }
    let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
    return children.prefix(8).contains { marksEmptyEditor($0, depth: depth - 1) }
}
// Why the composer reads as empty now, or nil. AX saying it has no value is empty; any
// other error, or a value that is not text, may hide the user's text: not empty.
func composerEmptiness(_ element: AXUIElement) -> String? {
    var value: CFTypeRef?
    switch AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &value) {
    case .success: break
    case .noValue: return "no-value"
    default: return nil
    }
    guard let text = value as? String else { return nil }
    return composerEmptyReason(
        value: text,
        emptyEditorMarked: !visibleText(text).isEmpty && marksEmptyEditor(element),
        placeholder: stringAttribute(element, kAXPlaceholderValueAttribute)
    )
}
// The pre-write composer re-read, from AX directly rather than the observation.
func composerReadsEmpty(_ element: AXUIElement) -> Bool { composerEmptiness(element) != nil }
// Whether Claude is the app in front, read now.
func claudeFrontmost(_ app: NSRunningApplication) -> Bool {
    NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier
}
// Milliseconds since the user's last input of any kind (keys, mouse, scroll), read now.
// The raw value ~0 is kCGAnyInputEventType.
func idleMilliseconds() -> Int {
    Int(CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: ~0)!) * 1000)
}
// Milliseconds since the user last pressed a key, a modifier included, read now. A mouse
// that moves or clicks does not count: only keystrokes could land in a composer Relay types into.
func keyIdleMilliseconds() -> Int {
    let since = [CGEventType.keyDown, .flagsChanged].map {
        CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: $0)
    }.min() ?? 0
    return Int(since * 1000)
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
            value: valueText(element),
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
// Whether every claude.ai/epitaxy URL among a web area's strings is Code's bare
// new-session screen, https://claude.ai/epitaxy (a trailing "/" and a query allowed),
// and there is at least one. Desktop's own claude://code/new opens that path. A
// conversation, another Code screen, or epitaxy text that is not such a URL: false.
func epitaxyNewSession(_ strings: [String]) -> Bool {
    var seen = false
    for text in strings where text.contains("claude.ai/epitaxy") {
        guard let url = URLComponents(string: text), url.scheme == "https", url.host == "claude.ai",
              url.path == "/epitaxy" || url.path == "/epitaxy/" else { return false }
        seen = true
    }
    return seen
}
// What the web areas show: one conversation, by its id, or Code's new-session screen,
// which has none. Neither for several conversations, another screen, or a load.
func screenOf(_ strings: [String]) -> (localSessionId: String?, newSession: Bool) {
    let ids = epitaxySessionIDs(strings)
    return (ids.count == 1 ? ids.first : nil, ids.isEmpty && epitaxyNewSession(strings))
}
// The shape of the claude.ai page the web areas show, for the diagnosis log: its path with
// every id dropped, such as "/epitaxy/local", "/epitaxy" or "/new"; "none" without a
// claude.ai URL, "several" for more than one shape. Never an id or a query.
func screenShape(_ strings: [String]) -> String {
    var shapes = Set<String>()
    for text in strings {
        guard let url = URLComponents(string: text), url.scheme == "https", url.host == "claude.ai" else { continue }
        let parts = url.path.split(separator: "/").prefix(4).map { part -> String in
            let segment = String(part)
            if segment.hasPrefix("local_") { return "local" }
            if segment.range(of: "^[a-z-]{1,24}$", options: .regularExpression) != nil { return segment }
            return segment.range(of: "^[0-9a-fA-F-]{8,}$", options: .regularExpression) != nil ? ":id" : "*"
        }
        shapes.insert("/" + parts.joined(separator: "/"))
    }
    if shapes.isEmpty { return "none" }
    return shapes.count == 1 ? shapes.first! : "several"
}
// Cheap re-read of only the web areas an earlier observe() already found: a few
// attribute reads, no tree walk. Used right before a write that replaces text.
func liveScreen(_ observation: Observation) -> (localSessionId: String?, newSession: Bool) {
    let strings = observation.tree.filter { $0.role == "AXWebArea" }.flatMap { node in
        [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute, "AXURL"].map { stringAttribute(node.element, $0) }
    }
    return screenOf(strings.filter { !$0.isEmpty })
}
// One field of two observations, absent on both sides counting as the same.
func sameField(_ a: [String: Any], _ b: [String: Any], _ field: String) -> Bool {
    a[field].map { String(describing: $0) } == b[field].map { String(describing: $0) }
}
func observe() throws -> Observation {
    guard AXIsProcessTrusted() else { try fail("accessibility-permission-required") }
    let apps = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
        .filter { !$0.isTerminated }
    guard apps.count == 1, let app = apps.first else { try fail(apps.isEmpty ? "claude-not-running" : "desktop-ui-unsupported") }
    let root = AXUIElementCreateApplication(app.processIdentifier)
    let tree = try nodes(root)
    let webAreas = tree.filter { $0.role == "AXWebArea" }
    // Several web surfaces, ambiguous aliases or unsupported URL exposure block
    // targeting. A title or a sidebar card is never a conversation identity.
    let screen = screenOf(webAreas.flatMap { $0.strings })
    let localID = screen.localSessionId
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
    let composerEmpty = composer.flatMap { composerEmptiness($0.element) }
    var stable: [String: Any] = [
        "pid": Int(app.processIdentifier), "status": status,
        "quotaStopped": quota && status == "stopped",
        "composerEmpty": composerEmpty != nil,
        // composerEmpty is false without a composer, so say whether there is one.
        "composerPresent": composer != nil,
        "sendEnabled": send?.enabled == true,
        "visibleActiveTasks": visibleActive,
        "visibleWaitingTasks": visibleWaiting,
        "visibleScheduledTasks": visibleScheduled,
        "coverage": "active-conversation-only"
    ]
    if let id = localID { stable["localSessionId"] = id }
    if screen.newSession { stable["newSession"] = true }
    if let label = account { stable["accountLabel"] = label }
    if let value = mode { stable["permissionMode"] = value }
    if let checked = autoChecked { stable["quotaAutoResume"] = checked }
    let serialized = try JSONSerialization.data(withJSONObject: stable, options: [.sortedKeys])
    var fields = stable
    fields["contextFingerprint"] = SHA256.hash(data: serialized).map { String(format: "%02x", $0) }.joined()
    fields["observedAt"] = Int(Date().timeIntervalSince1970 * 1000)
    // What the user is doing, not what the conversation is: outside the fingerprint.
    fields["frontmost"] = claudeFrontmost(app)
    fields["idleMs"] = idleMilliseconds()
    fields["keyIdleMs"] = keyIdleMilliseconds()
    // How an empty composer read as empty, for the diagnosis log; never its text.
    if let reason = composerEmpty { fields["composerEmptyAs"] = reason }
    // How much a composer that is not empty holds, as a count; never its text.
    if let element = composer?.element, composerEmpty == nil {
        fields["composerChars"] = visibleText(stringAttribute(element, kAXValueAttribute)).count
    }
    fields["screen"] = screenShape(webAreas.flatMap { $0.strings })
    return Observation(app: app, tree: tree, composer: composer, send: send, permission: permission, fields: fields)
}
// A guard names its screen by a conversation id or, for write-draft only
// (allowNewSession), as Code's new-session screen, which has none. That screen may
// show no single permission selector: its mode is the same when absent on both sides.
func validateGuard(_ observation: Observation, _ expected: [String: Any], allowComposer: Bool = false, allowNewSession: Bool = false) throws {
    let named = expected["newSession"] != nil
    if named {
        guard allowNewSession, expected["newSession"] as? Bool == true, expected["localSessionId"] == nil,
              observation.fields["newSession"] as? Bool == true, observation.fields["localSessionId"] == nil,
              sameField(expected, observation.fields, "permissionMode") else { try fail("context-changed") }
    }
    for field in named ? ["pid", "accountLabel"] : ["pid", "localSessionId", "accountLabel", "permissionMode"] {
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
    // The new-session screen is named without an id, and may show no mode.
    let required = observation.fields["newSession"] as? Bool == true
        ? ["pid", "newSession", "accountLabel", "status", "composerEmpty"]
        : ["pid", "localSessionId", "accountLabel", "permissionMode", "status", "composerEmpty"]
    for field in required {
        guard let before = observation.fields[field], let after = focused.fields[field],
              String(describing: before) == String(describing: after) else { try fail("context-changed") }
    }
    for field in ["localSessionId", "newSession", "permissionMode"] {
        guard sameField(observation.fields, focused.fields, field) else { try fail("context-changed") }
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
    // Clipboard managers skip transient and concealed content (nspasteboard.org), so
    // the text never lands in a clipboard history.
    board.setData(Data(), forType: NSPasteboard.PasteboardType("org.nspasteboard.TransientType"))
    board.setData(Data(), forType: NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType"))
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
// Claude's own question before it quits while work is left running, an alert or a sheet,
// by its title in English and Turkish: "shells" when it asks only about background
// commands, "working" when Claude is still working in a session, nil for anything else.
let shellsGuardTitles = ["Background commands are still running", "Arka plan komutları hâlâ çalışıyor"]
let workingGuardTitles = ["Claude is still working", "Claude hâlâ çalışıyor"]
let quitAnywayTitles = ["Quit anyway", "Yine de çık"]
func quitGuardKind(_ texts: [String]) -> String? {
    if texts.contains(where: { workingGuardTitles.contains($0) }) { return "working" }
    if texts.contains(where: { shellsGuardTitles.contains($0) }) { return "shells" }
    return nil
}
// Claude's quit question, if it shows one: its kind and its "Quit anyway" button. Looks only
// in Claude's dialogs and sheets, never in a page.
func quitGuard(_ app: NSRunningApplication) -> (kind: String?, quitAnyway: AXUIElement?) {
    let root = AXUIElementCreateApplication(app.processIdentifier)
    var containers: [AXUIElement] = []
    for window in attribute(root, kAXWindowsAttribute) as? [AXUIElement] ?? [] {
        if ["AXDialog", "AXSystemDialog"].contains(stringAttribute(window, kAXSubroleAttribute)) { containers.append(window) }
        for child in attribute(window, kAXChildrenAttribute) as? [AXUIElement] ?? []
            where stringAttribute(child, kAXRoleAttribute) == "AXSheet" { containers.append(child) }
    }
    for container in containers {
        var texts: [String] = []
        var buttons: [(title: String, element: AXUIElement)] = []
        func walk(_ element: AXUIElement, _ depth: Int) {
            let role = stringAttribute(element, kAXRoleAttribute)
            if role == "AXStaticText" { texts += [valueText(element), stringAttribute(element, kAXTitleAttribute)] }
            if role == "AXButton" { buttons.append((stringAttribute(element, kAXTitleAttribute), element)) }
            guard depth < 4 else { return }
            for child in (attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []).prefix(40) { walk(child, depth + 1) }
        }
        walk(container, 0)
        if let kind = quitGuardKind(texts) {
            return (kind, buttons.first { quitAnywayTitles.contains($0.title) }?.element)
        }
    }
    return (nil, nil)
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
    if command == "quit-guard" {
        // Relay asked Claude to quit, after stopping the background commands it found. Only
        // the question about background commands alone is answered, with "Quit anyway".
        guard AXIsProcessTrusted() else { try fail("accessibility-permission-required") }
        let apps = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).filter { !$0.isTerminated }
        guard apps.count == 1, let app = apps.first else { return ["ok": true, "guard": NSNull(), "pressed": false] }
        let found = quitGuard(app)
        var pressed = false
        if request["answer"] as? String == "quit-anyway", found.kind == "shells", let button = found.quitAnyway {
            pressed = AXUIElementPerformAction(button, kAXPressAction as CFString) == .success
        }
        return ["ok": true, "guard": found.kind as Any? ?? NSNull(), "pressed": pressed]
    }
    if command == "open-session" || command == "open-new-session" {
        let link: String
        if command == "open-session" {
            guard let id = request["localSessionId"] as? String, match(id, localPattern) else { try fail("exact-session-not-observed") }
            link = "claude://code/continue?session=\(id)"
        } else {
            // Desktop's own "New Claude Code Session" link. It only shows Code's
            // new-session screen (claude.ai/epitaxy): it starts no session and picks
            // no folder.
            link = "claude://code/new"
        }
        // Inspect first: opening a protocol URL must never launch a closed app.
        let observation = try observe()
        guard let url = URL(string: link) else { try fail("desktop-ui-unsupported") }
        // Opening brings Claude forward. A caller that asks opens only into a Claude
        // already in front with no input for 3 s, read now, after the long observe().
        if request["requireIdle"] as? Bool == true {
            guard claudeFrontmost(observation.app), idleMilliseconds() >= 3000 else { try fail("user-active") }
        }
        guard NSWorkspace.shared.open(url) else { try fail("desktop-ui-unsupported") }
        return ["ok": true]
    }
    if command == "lookup" {
        guard let requestID = request["requestId"] as? String, match(requestID, "^[A-Za-z0-9._:-]{1,128}$") else { try fail("desktop-ui-unsupported") }
        return ["ok": true, "markerPresent": markerPresent(try observe(), "[Relay continuation: \(requestID)]")]
    }
    guard let expected = request["guard"] as? [String: Any] else { try fail("context-changed") }
    var current = try observe()
    // Only a draft is ever typed into the new-session screen: nothing else may act there.
    let draft = command == "write-draft"
    try validateGuard(current, expected, allowNewSession: draft)
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
        // The editor may give its paragraphs other line breaks than the text had: the
        // characters that show must all be there, in order, and nothing else.
        guard let typed = current.composer?.value, visibleText(typed) == visibleText(body),
              let send = current.send, send.enabled else { try fail("delivery-ambiguous") }
        // There is no atomic lock across AX clients. This is one guarded attempt,
        // never an exactly-once transport. Ambiguous results must not be retried.
        try press(send)
        current = try observe()
        return ["ok": true, "acceptedVisible": current.fields["composerEmpty"] as? Bool == true && markerPresent(current, marker)]
    }
    if command == "write-draft" {
        // Re-types an unsent draft, into a conversation or Code's new-session screen.
        // It never presses Send and adds no marker. The guard above required the same
        // account/screen/mode, a stopped screen and an empty composer, but that was
        // sampled during the observe() tree walk, which can be long. Re-read the
        // composer value and the screen directly right before the write. This narrows
        // the race with a user typing or switching screens; it cannot close it, as AX
        // has no atomic lock.
        guard let text = request["text"] as? String, !text.isEmpty, text.utf8.count <= 65536, !text.contains("\0"),
              let composer = current.composer else { try fail("desktop-ui-unsupported") }
        // The user's keystrokes, a Return included, must never land in a composer
        // Relay types into: write only into a Claude in front that has had no input
        // for 3 s or, when the caller names keysIdleMs (500-3000), no key pressed for
        // that long. Read now, not from the observation, before anything is written.
        let quiet: Bool
        if let keys = request["keysIdleMs"] {
            guard let ms = keys as? Int, (500...3000).contains(ms) else { try fail("desktop-ui-unsupported") }
            quiet = keyIdleMilliseconds() >= ms
        } else {
            quiet = idleMilliseconds() >= 3000
        }
        guard claudeFrontmost(current.app), quiet else { try fail("user-active") }
        guard composerReadsEmpty(composer.element) else { try fail("composer-not-empty") }
        let live = liveScreen(current)
        if expected["newSession"] as? Bool == true {
            guard live.newSession else { try fail("context-changed") }
        } else {
            guard let id = live.localSessionId, id == expected["localSessionId"] as? String else { try fail("context-changed") }
        }
        try writeComposer(current, text)
        current = try observe()
        try validateGuard(current, expected, allowComposer: true, allowNewSession: true)
        // One guarded attempt, never retried: a composer that does not read back the
        // same visible characters is ambiguous, not a reason to type again.
        guard let typed = current.composer?.value, visibleText(typed) == visibleText(text) else { try fail("delivery-ambiguous") }
        return ["ok": true, "snapshot": current.fields]
    }
    try fail("desktop-ui-unsupported")
}

// Claude's top-level web areas, found cheaply: a breadth-first walk of the native views
// only. It skips the menu bar, never descends into a web area and stops at 300 elements,
// so it never walks the page's own tree the way observe() does.
func webAreas(_ root: AXUIElement) -> [AXUIElement] {
    var found: [AXUIElement] = []
    var queue: [(AXUIElement, Int)] = [(root, 0)]
    var seen = 0
    while !queue.isEmpty && seen < 300 {
        let (element, depth) = queue.removeFirst()
        seen += 1
        let role = stringAttribute(element, kAXRoleAttribute)
        if role == "AXWebArea" { found.append(element); continue }
        if role == "AXMenuBar" || depth >= 12 { continue }
        for child in attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? [] { queue.append((child, depth + 1)) }
    }
    return found
}
func emit(_ object: [String: Any]) {
    guard let line = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return }
    FileHandle.standardOutput.write(line + Data("\n".utf8))
}
// `watch <quietMs> <idleMs>`: a long-lived, read-only look at where the user is, so the
// parent need not spawn a whole observe() to learn it. While Claude is in front it reads,
// every 250 ms, the URLs of Claude's web areas, and every 1 s otherwise only whether Claude
// is in front. It prints one JSON line each time the place (a conversation id, the
// new-session screen, or null when unknown or Claude is not in front), Claude being in front,
// no key for quietMs, or no input for idleMs changes. It never opens, types or presses
// anything, and reads no text. It ends when stdin closes, Claude quits, or after 10 minutes.
func watch(_ arguments: [String]) -> Never {
    guard arguments.count == 4, let quietMs = Int(arguments[2]), let idleMs = Int(arguments[3]),
          (250...10000).contains(quietMs), (250...10000).contains(idleMs) else {
        emit(["issue": "desktop-ui-unsupported"]); exit(2)
    }
    // The parent holds stdin open: its end, or the parent's, ends the watch.
    Thread.detachNewThread {
        _ = FileHandle.standardInput.readDataToEndOfFile()
        exit(0)
    }
    guard AXIsProcessTrusted() else { emit(["issue": "accessibility-permission-required"]); exit(0) }
    let apps = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).filter { !$0.isTerminated }
    guard apps.count == 1, let app = apps.first else {
        emit(["issue": apps.isEmpty ? "claude-not-running" : "desktop-ui-unsupported"]); exit(0)
    }
    let pid = app.processIdentifier
    let root = AXUIElementCreateApplication(pid)
    let deadline = Date().addingTimeInterval(600)
    var areas: [AXUIElement] = []
    var foundAt = Date.distantPast
    var last: Data?
    func tick() {
        if Date() >= deadline { emit(["expired": true]); exit(0) }
        if app.isTerminated || kill(pid, 0) != 0 { emit(["gone": true]); exit(0) }
        let front = claudeFrontmost(app)
        var place: Any = NSNull()
        if front {
            if areas.isEmpty || Date().timeIntervalSince(foundAt) >= 2 {
                areas = webAreas(root)
                foundAt = Date()
            }
            let strings = areas.flatMap { area in
                [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute, "AXURL"].map { stringAttribute(area, $0) }
            }.filter { !$0.isEmpty }
            let screen = screenOf(strings)
            if let id = screen.localSessionId { place = id } else if screen.newSession { place = "new-session" }
        }
        let state: [String: Any] = [
            "pid": Int(pid), "place": place, "frontmost": front,
            "quiet": keyIdleMilliseconds() >= quietMs, "idle": idleMilliseconds() >= idleMs
        ]
        if let line = try? JSONSerialization.data(withJSONObject: state, options: [.sortedKeys]), line != last {
            last = line
            FileHandle.standardOutput.write(line + Data("\n".utf8))
        }
        // The main run loop runs between looks, so NSWorkspace and NSRunningApplication stay current.
        Timer.scheduledTimer(withTimeInterval: front ? 0.25 : 1, repeats: false) { _ in tick() }
    }
    tick()
    RunLoop.main.run()
    exit(0)
}

#if RELAY_AX_SELECTOR_FIXTURE
// This compilation mode deliberately has no live AX dispatcher. Fixtures may
// only call the pure selectors; they cannot request permission or inspect apps.
// An array of nodes picks the account popup; {"webAreaStrings": [...]} names
// the screen those web area strings show.
do {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    guard input.count <= 65536 else { try fail("desktop-ui-unsupported") }
    let json = try JSONSerialization.jsonObject(with: input)
    let result: [String: Any]
    if let values = json as? [[String: String]] {
        let tree = values.map {
            AccountSelectorNode(role: $0["role"] ?? "", title: $0["title"] ?? "", description: $0["description"] ?? "", value: $0["value"] ?? "", path: $0["path"] ?? "")
        }
        result = ["accountPath": accountPopupPath(tree) as Any? ?? NSNull()]
    } else if let object = json as? [String: Any], let strings = object["webAreaStrings"] as? [String] {
        let screen = screenOf(strings)
        result = ["localSessionId": screen.localSessionId as Any? ?? NSNull(), "newSession": screen.newSession, "screen": screenShape(strings)]
    } else if let object = json as? [String: Any], let texts = object["quitGuardTexts"] as? [String] {
        result = ["kind": quitGuardKind(texts) as Any? ?? NSNull()]
    } else if let object = json as? [String: Any], let composer = object["composer"] as? [String: Any] {
        // {"composer": {value, emptyEditorMarked, placeholder}} says how such a composer reads.
        let value = composer["value"] as? String ?? ""
        let reason = composerEmptyReason(
            value: value,
            emptyEditorMarked: composer["emptyEditorMarked"] as? Bool ?? false,
            placeholder: composer["placeholder"] as? String ?? ""
        )
        result = ["emptyAs": reason as Any? ?? NSNull(), "visible": visibleText(value)]
    } else { try fail("desktop-ui-unsupported") }
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]))
} catch {
    FileHandle.standardOutput.write(Data("{\"error\":\"invalid-fixture\"}".utf8))
}
#else
if CommandLine.arguments.count > 1 && CommandLine.arguments[1] == "watch" { watch(CommandLine.arguments) }
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
