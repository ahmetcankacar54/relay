import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

// The helper cannot be run in tests (it drives the real Claude UI), so these
// scan its source for the properties that matter most. Comments are stripped:
// only code counts.
const swiftSource = readFileSync(
  path.join(import.meta.dirname, "../native/desktop-automation.swift"),
  "utf8",
);
/** The `{ ... }` block that follows `header`, with `//` comments removed. */
function swiftBlock(header: string): string {
  const start = swiftSource.indexOf(header);
  assert.notEqual(start, -1, `${header} not found`);
  const open = swiftSource.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < swiftSource.length; i++) {
    if (swiftSource[i] === "{") depth++;
    else if (swiftSource[i] === "}" && --depth === 0)
      return swiftSource.slice(open, i + 1).replace(/\/\/.*$/gm, "");
  }
  throw new Error(`${header} is not closed`);
}
test("the Swift write-draft branch and writeComposer never press, send or add a marker", () => {
  const branch = swiftBlock('if command == "write-draft" {');
  const composer = swiftBlock("func writeComposer(");
  assert.match(branch, /writeComposer\(/);
  assert.doesNotMatch(branch, /marker/i);
  assert.doesNotMatch(branch, /requestId/i);
  // writeComposer is shared with send: it must only type, never press a button or Return.
  for (const [name, block] of [
    ["write-draft", branch],
    ["writeComposer", composer],
  ]) {
    for (const forbidden of [
      "press(",
      "AXUIElementPerformAction",
      "kAXPressAction",
      "virtualKey: 36",
      "virtualKey: 76",
    ])
      assert.equal(block.includes(forbidden), false, `${name}: ${forbidden}`);
    // Return (36) and keypad Enter (76) send, however the call is spaced.
    assert.doesNotMatch(block, /virtualKey:\s*(?:36|76)\b/, name);
  }
  // Its only key is V (9), for the paste.
  const keys = [...composer.matchAll(/virtualKey:\s*([^,)\s]+)/g)].map(
    (m) => m[1],
  );
  assert.ok(keys.length > 0);
  assert.deepEqual([...new Set(keys)], ["9"]);
  // send submits outside both blocks: with Return, since Send pressed through AX did nothing.
  const send = swiftBlock('if command == "send" {');
  assert.match(send, /try submitComposer\(current\)/);
  assert.doesNotMatch(send, /press\(send\)/);
});
test("the Swift write-draft branch checks the user, then re-reads the composer and conversation, right before writing", () => {
  const branch = swiftBlock('if command == "write-draft" {');
  const at = (text: string) => branch.indexOf(text);
  const guarded = at("let composer = current.composer");
  const active = at('fail("user-active")');
  const write = at("writeComposer(");
  assert.ok(guarded !== -1 && active !== -1 && write !== -1);
  // First the text and composer guard, then whether the user is active, then the re-reads.
  assert.ok(guarded < active);
  for (const before of [
    "composerReadsEmpty(composer.element)",
    'fail("composer-not-empty")',
    "liveScreen(",
    'fail("context-changed")',
  ]) {
    const i = at(before);
    assert.ok(i > active, `${before} must follow the user check`);
    assert.ok(i < write, `${before} must precede writeComposer`);
  }
  // Read fresh, never from the observation: Claude in front and 3 s without input, or, when
  // the caller names keysIdleMs (500 to 3000), no key for that long.
  const check = branch.slice(guarded, at("composerReadsEmpty("));
  assert.match(
    check,
    /if let keys = request\["keysIdleMs"\] \{\s*guard let ms = keys as\? Int, \(500\.\.\.3000\)\.contains\(ms\) else \{ try fail\("desktop-ui-unsupported"\) \}\s*quiet = keyIdleMilliseconds\(\) >= ms\s*\} else \{\s*quiet = idleMilliseconds\(\) >= 3000\s*\}/,
  );
  assert.match(
    check,
    /guard claudeFrontmost\(current\.app\), quiet else \{ try fail\("user-active"\) \}/,
  );
  assert.doesNotMatch(check, /current\.fields/);
});
test("the Swift open-session checks the user right before opening, and only when asked", () => {
  const block = swiftBlock(
    'if command == "open-session" || command == "open-new-session" {',
  );
  const at = (text: string) => block.indexOf(text);
  const observed = at("let observation = try observe()");
  const flag = at('if request["requireIdle"] as? Bool == true {');
  const check = at(
    'guard claudeFrontmost(observation.app), idleMilliseconds() >= 3000 else { try fail("user-active") }',
  );
  const open = at("NSWorkspace.shared.open(url)");
  for (const [name, i] of Object.entries({ observed, flag, check, open }))
    assert.notEqual(i, -1, name);
  // After its observe() and right before the open, read fresh, never from the observation.
  assert.ok(observed < flag && flag < check && check < open);
  assert.doesNotMatch(block, /observation\.fields/);
  // The check sits inside the flag's branch: without the flag nothing new runs.
  assert.match(
    block,
    /if request\["requireIdle"\] as\? Bool == true \{\s*guard claudeFrontmost\(observation\.app\), idleMilliseconds\(\) >= 3000 else \{ try fail\("user-active"\) \}\s*\}/,
  );
  // Nothing else opens a URL in that block.
  assert.equal(block.split("NSWorkspace.shared.open(").length - 1, 1);
  // Its only links: an exact conversation, and Desktop's own new-session link with nothing
  // after it, so no text ever travels in a URL (its ?q= would prefill the composer). Read
  // from the source as it is: stripping `//` comments would cut the links too.
  const raw = swiftSource.slice(
    swiftSource.indexOf('if command == "open-session" ||'),
    swiftSource.indexOf('if command == "lookup" {'),
  );
  const links = [...raw.matchAll(/"(claude:\/\/[^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(links, [
    "claude://code/continue?session=\\(id)",
    "claude://code/new",
  ]);
});
test("the Swift helper accepts a new-session guard for write-draft only", () => {
  // validateGuard takes a guard without a conversation id only when allowed to.
  const check = swiftBlock("func validateGuard(");
  assert.match(check, /if named \{\s*guard allowNewSession,/);
  const handler = swiftBlock("func handle(");
  assert.match(handler, /let draft = command == "write-draft"/);
  assert.match(
    handler,
    /try validateGuard\(current, expected, allowNewSession: draft\)/,
  );
  // No other command's branch allows it.
  for (const command of ["cancel-quota-resume", "set-permission", "send"])
    assert.doesNotMatch(
      swiftBlock(`if command == "${command}" {`),
      /allowNewSession/,
      command,
    );
  // write-draft re-reads the screen right before writing: still the new-session screen.
  assert.match(
    swiftBlock('if command == "write-draft" {'),
    /if expected\["newSession"\] as\? Bool == true \{\s*guard live\.newSession else \{ try fail\("context-changed"\) \}/,
  );
});
test("the Swift snapshot names the new-session screen inside the fingerprint", () => {
  const body = swiftBlock("func observe()");
  const stable = body.indexOf("var stable: [String: Any] = [");
  const flag = body.indexOf(
    'if screen.newSession { stable["newSession"] = true }',
  );
  const serialized = body.indexOf("let serialized");
  assert.ok(stable !== -1 && flag > stable && flag < serialized);
  // The same pure classifier names the conversation, so the two cannot disagree.
  assert.match(
    body,
    /let screen = screenOf\(webAreas\.flatMap \{ \$0\.strings \}\)/,
  );
  assert.match(body, /let localID = screen\.localSessionId/);
});
test("the Swift snapshot reports frontmost and idleMs outside the fingerprint", () => {
  const body = swiftBlock("func observe()");
  const stable = body.slice(
    body.indexOf("var stable: [String: Any] = ["),
    body.indexOf("let serialized"),
  );
  assert.ok(stable.length > 0);
  assert.doesNotMatch(stable, /frontmost|idleMs/);
  const fingerprint = body.indexOf('fields["contextFingerprint"]');
  for (const field of [
    'fields["frontmost"] = claudeFrontmost(app)',
    'fields["idleMs"] = idleMilliseconds()',
  ]) {
    const i = body.indexOf(field);
    assert.ok(i !== -1 && i > fingerprint, field);
  }
  assert.match(
    swiftBlock("func claudeFrontmost("),
    /NSWorkspace\.shared\.frontmostApplication\?\.processIdentifier == app\.processIdentifier/,
  );
  assert.match(
    swiftBlock("func idleMilliseconds("),
    /CGEventSource\.secondsSinceLastEventType\(\.combinedSessionState, eventType: CGEventType\(rawValue: ~0\)!\)/,
  );
  // keyIdleMs too: keys and modifiers only, read after the fingerprint.
  const keys = body.indexOf('fields["keyIdleMs"] = keyIdleMilliseconds()');
  assert.ok(keys > fingerprint);
  assert.doesNotMatch(stable, /keyIdleMs/);
  assert.match(
    swiftBlock("func keyIdleMilliseconds("),
    /\[CGEventType\.keyDown, \.flagsChanged\]\.map \{\s*CGEventSource\.secondsSinceLastEventType\(\.combinedSessionState, eventType: \$0\)\s*\}\.min\(\)/,
  );
});
test("the Swift watch only reads: it opens, types, presses and observes nothing, and ends on its own", () => {
  const body = swiftBlock("func watch(");
  for (const forbidden of [
    /writeComposer\(/,
    /press\(/,
    /NSWorkspace\.shared\.open/,
    /AXUIElementSetAttributeValue/,
    /AXUIElementPerformAction/,
    /CGEvent\(/,
    /observe\(\)/,
    /NSPasteboard/,
    /requestAccessibility|AXIsProcessTrustedWithOptions/,
  ])
    assert.doesNotMatch(body, forbidden, String(forbidden));
  // Ends with stdin, with Claude, and after 10 minutes; never asks for accessibility.
  assert.match(
    body,
    /FileHandle\.standardInput\.readDataToEndOfFile\(\)\s*exit\(0\)/,
  );
  assert.match(body, /guard AXIsProcessTrusted\(\) else/);
  assert.match(body, /Date\(\)\.addingTimeInterval\(600\)/);
  assert.match(body, /emit\(\["gone": true\]\)/);
  // Its times are bounded, and it reads the web areas only while Claude is in front.
  assert.match(
    body,
    /\(250\.\.\.10000\)\.contains\(quietMs\), \(250\.\.\.10000\)\.contains\(idleMs\)/,
  );
  assert.match(body, /if front \{\s*if areas\.isEmpty/);
  assert.match(body, /front \? 0\.25 : 1/);
  // The cheap walk never enters a web area or the menu bar, and stops at 300 elements.
  const walk = swiftBlock("func webAreas(");
  assert.match(walk, /seen < 300/);
  assert.match(
    walk,
    /if role == "AXWebArea" \{ found\.append\(element\); continue \}/,
  );
  assert.match(walk, /role == "AXMenuBar"/);
  // The dispatcher runs it from its argument, before reading any request.
  const dispatch = swiftSource.slice(swiftSource.lastIndexOf("#else"));
  assert.ok(
    dispatch.indexOf('CommandLine.arguments[1] == "watch"') <
      dispatch.indexOf("readDataToEndOfFile"),
  );
});
test("the Swift composer reads as empty only from a readable value, the same way before a write", () => {
  // observe() and the re-read right before a write decide alike, from AX directly.
  assert.match(
    swiftBlock("func observe()"),
    /let composerEmpty = composer\.flatMap \{ composerEmptiness\(\$0\.element\) \}/,
  );
  assert.match(
    swiftBlock("func observe()"),
    /"composerEmpty": composerEmpty != nil/,
  );
  // A missing composer reads as not empty, so the snapshot says whether there is one.
  assert.match(
    swiftBlock("func observe()"),
    /"composerPresent": composer != nil/,
  );
  const branch = swiftBlock('if command == "write-draft" {');
  assert.match(
    branch,
    /guard composerReadsEmpty\(composer\.element\) else \{ try fail\("composer-not-empty"\) \}/,
  );
  assert.doesNotMatch(branch, /valueText\(/);
  assert.doesNotMatch(branch, /kAXValueAttribute/);
  assert.match(
    swiftBlock("func composerReadsEmpty("),
    /composerEmptiness\(element\) != nil/,
  );
  // An AX error, or a value that is not text, may hide the user's text: never empty.
  const read = swiftBlock("func composerEmptiness(");
  assert.match(
    read,
    /AXUIElementCopyAttributeValue\(element, kAXValueAttribute as CFString, &value\)/,
  );
  assert.match(read, /case \.noValue: return "no-value"/);
  assert.match(read, /default: return nil/);
  assert.match(
    read,
    /guard let text = value as\? String else \{ return nil \}/,
  );
});
test("the Swift submitComposer posts Return only into Claude in front with its composer focused", () => {
  const body = swiftBlock("func submitComposer(");
  const keys = [...body.matchAll(/virtualKey:\s*([^,)\s]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(keys)], ["36"]);
  // No modifier: Shift+Return is a new line, Cmd+Return something else.
  assert.doesNotMatch(body, /flags/);
  const focus = body.indexOf("kAXFocusedAttribute");
  const front = body.indexOf("frontmostApplication");
  const post = body.indexOf("down.post(");
  assert.ok(focus !== -1 && front !== -1 && post !== -1);
  assert.ok(focus < post && front < post);
  assert.match(body, /fail\("context-changed"\)/);
});
test("the Swift writeComposer only pastes: Claude's editor ignores a value set through AX", () => {
  const body = swiftBlock("func writeComposer(");
  // Setting the value shows the text but leaves the editor's own state empty, so Send took nothing.
  assert.doesNotMatch(body, /kAXValueAttribute/);
  assert.doesNotMatch(body, /"ax-value"/);
  assert.match(body, /return "paste"/);
  assert.match(body, /down\.post\(tap: \.cghidEventTap\)/);
});
test("the Swift writeComposer marks its clipboard text transient and concealed before it is owned", () => {
  const body = swiftBlock("func writeComposer(");
  const at = (text: string) => body.indexOf(text);
  const string = at("board.setString(body, forType: .string)");
  const marks = [
    'board.setData(Data(), forType: NSPasteboard.PasteboardType("org.nspasteboard.TransientType"))',
    'board.setData(Data(), forType: NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType"))',
  ].map(at);
  const owned = at("let owned = board.changeCount");
  const paste = at("down.post(");
  assert.ok(string !== -1 && owned !== -1 && paste !== -1);
  for (const mark of marks) assert.ok(mark > string && mark < owned);
  assert.ok(owned < paste);
});
test("the Swift writeComposer re-checks focus after its re-observe and before the clipboard write", () => {
  const body = swiftBlock("func writeComposer(");
  const observed = body.indexOf("try observe()");
  const board = body.indexOf("board.clearContents()");
  const checks = [...body.matchAll(/focusHeld\(\)/g)].map((m) => m.index ?? -1);
  assert.ok(observed !== -1 && board !== -1);
  assert.ok(
    checks.some((at) => at > observed && at < board),
    "focus must be checked between the re-observe and the clipboard write",
  );
});
