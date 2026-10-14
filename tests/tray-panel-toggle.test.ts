import test from "node:test";
import assert from "node:assert/strict";
import { ToggleGuard } from "../shared/tray-panel";

test("a tray click right after a blur-hide does not reopen the panel", () => {
  const guard = new ToggleGuard();
  assert.equal(guard.shouldOpen(1000), true);
  guard.hidden(1000);
  assert.equal(guard.shouldOpen(1200), false);
  assert.equal(guard.shouldOpen(1250), false);
  assert.equal(guard.shouldOpen(1251), true);
});
