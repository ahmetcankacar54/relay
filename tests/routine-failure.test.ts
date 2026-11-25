import test from "node:test";
import assert from "node:assert/strict";
import { mainSource } from "./helpers/main-source";
import { readFileSync } from "node:fs";
import { routineFailure, routineFailureNotice } from "../shared/routine-failure";
import { testT } from "./i18n";

test("a known reason is named in words, in both languages", () => {
  assert.equal(
    routineFailureNotice("Studio", "routine-cli-unavailable", "tr"),
    "Studio hesabının limit dönemi başlatılamadı (Claude CLI bulunamadı).",
  );
  assert.equal(
    routineFailureNotice("Studio", "routine-cli-unavailable", "en"),
    "Studio’s limit period did not start (Claude CLI not found).",
  );
  const id = routineFailure("interrupted")!;
  assert.deepEqual([testT("tr")(id), testT("en")(id)], ["Relay kapandı", "Relay quit"]);
});

test("a reason without a label is left out, never shown as a code", () => {
  for (const reason of ["routine-request-failed", "Wait for the account connection refresh to finish.", ""]) {
    assert.equal(routineFailureNotice("Studio", reason, "tr"), "Studio hesabının limit dönemi başlatılamadı.");
    assert.equal(routineFailureNotice("Studio", reason, "en"), "Studio’s limit period did not start.");
  }
  assert.equal(routineFailure(undefined), undefined);
});

test("the notification and the planning panel read the same labels", () => {
  const main = mainSource();
  assert.match(main, /routineFailureNotice\(account\.name, reason, getAppLocale\(\)\)/);
  assert.doesNotMatch(main, /\(\$\{reason\}\)/);
  const panel = readFileSync(new URL("../src/features/PlanningPanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /routineFailure\(/);
  assert.doesNotMatch(panel, /"routine-cli-unavailable": \[/);
});
