import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// switch-window.ts imports Electron, so these read its source, as the other main tests do.
const source = readFileSync(
  new URL("../electron/switch-window.ts", import.meta.url),
  "utf8",
);
/** A method's body, from its signature to the closing brace at two spaces' indent. */
function method(signature: string) {
  const start = source.indexOf(`  ${signature}`);
  assert.ok(start >= 0, signature);
  return source.slice(start, source.indexOf("\n  }\n", start));
}

test("Relay starts with no switch window renderer", () => {
  assert.match(
    source,
    /constructor\(private readonly options: SwitchWindowOptions\) \{\}/,
  );
  assert.equal(source.match(/new BrowserWindow\(/g)?.length, 1);
  assert.ok(method("private create(): BrowserWindow").includes("new BrowserWindow("));
});

test("a visible story creates the window, guarded, only when the setting allows it", () => {
  const show = method("show(view: SwitchSceneView)");
  assert.match(show, /if \(view\.visible && this\.options\.enabled\(\)\) \{/);
  assert.match(show, /this\.cancelRelease\(\);/);
  assert.match(show, /if \(!this\.live\(\)\)\s*try \{\s*this\.create\(\);\s*\} catch \{/);
  assert.match(show, /if \(!view\.visible\) this\.scheduleRelease\(\);/);
});

test("an ended story frees the window 30 s later unless another starts", () => {
  assert.match(source, /export const SWITCH_WINDOW_RELEASE_MS = 30_000;/);
  const release = method("private scheduleRelease()");
  assert.match(release, /if \(this\.releaseTimer \|\| !this\.live\(\)\) return;/);
  assert.match(release, /if \(this\.view\?\.visible\) return;/);
  assert.match(release, /win\?\.destroy\(\);/);
  assert.match(release, /this\.releaseTimer\.unref\(\);/);
  assert.match(method("destroy()"), /this\.cancelRelease\(\);/);
});

test("a fresh window starts its load from the beginning", () => {
  const create = method("private create(): BrowserWindow");
  assert.match(create, /this\.load = INITIAL_PANEL_LOAD;/);
  assert.match(create, /if \(this\.win === win\) this\.win = undefined;/);
});

test("only an unpackaged Relay lets the smoke test start a scene", () => {
  const main = readFileSync(new URL("../electron/main.ts", import.meta.url), "utf8");
  assert.match(
    main,
    /if \(!app\.isPackaged\)\s*Object\.assign\(globalThis, \{\s*relaySmokeSwitchScene: \(view: SwitchSceneView\) =>\s*switchWindow\?\.show\(view\),/,
  );
  const smoke = readFileSync(new URL("../scripts/smoke.cjs", import.meta.url), "utf8");
  assert.match(smoke, /assert\.equal\(findSwitcher\(\), undefined, "Relay starts with no switch window"\);/);
});
