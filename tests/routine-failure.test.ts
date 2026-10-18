import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { routineFailure, routineFailureNotice } from "../shared/routine-failure";

test("a known reason is named in words, in both languages", () => {
  assert.equal(
    routineFailureNotice("Studio", "routine-cli-unavailable", "tr"),
    "Studio limit dönemi başlatılamadı (Claude CLI bulunamadı).",
  );
  assert.equal(
    routineFailureNotice("Studio", "routine-cli-unavailable", "en"),
    "Could not start Studio’s limit period (Claude CLI not found).",
  );
  assert.deepEqual(routineFailure("interrupted"), ["Relay kapandı", "Relay quit"]);
});

test("a reason without a label is left out, never shown as a code", () => {
  for (const reason of ["routine-request-failed", "Wait for the account connection refresh to finish.", ""]) {
    assert.equal(routineFailureNotice("Studio", reason, "tr"), "Studio limit dönemi başlatılamadı.");
    assert.equal(routineFailureNotice("Studio", reason, "en"), "Could not start Studio’s limit period.");
  }
  assert.equal(routineFailure(undefined), undefined);
});

test("the notification and the planning panel read the same labels", () => {
  const main = readFileSync(new URL("../electron/main.ts", import.meta.url), "utf8");
  assert.match(main, /routineFailureNotice\(account\.name, reason, trayLanguage\)/);
  assert.doesNotMatch(main, /\(\$\{reason\}\)/);
  const panel = readFileSync(new URL("../src/features/PlanningPanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /routineFailure\(/);
  assert.doesNotMatch(panel, /"routine-cli-unavailable": \[/);
});
