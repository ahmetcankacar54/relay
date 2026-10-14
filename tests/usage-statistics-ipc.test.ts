import test from "node:test";
import assert from "node:assert/strict";
import { usageStatisticsInput } from "../electron/core/usage-statistics-input";

const uuid = "4f6c8a52-1d2e-4b7a-9c3f-2a1b0c9d8e7f";

test("usage statistics input accepts 7/30/90 and an optional account uuid", () => {
  assert.deepEqual(usageStatisticsInput.parse({ range: 30 }), { range: 30 });
  assert.deepEqual(usageStatisticsInput.parse({ range: 90, accountId: uuid }), {
    range: 90,
    accountId: uuid,
  });
  assert.deepEqual(usageStatisticsInput.parse({ range: 7 }), { range: 7 });
});

test("usage statistics input rejects other ranges, ids and extra keys", () => {
  for (const value of [
    { range: 14 },
    { range: "30" },
    { range: 30, accountId: "x" },
    { range: 30, extra: 1 },
    undefined,
    null,
  ])
    assert.equal(usageStatisticsInput.safeParse(value).success, false);
});
