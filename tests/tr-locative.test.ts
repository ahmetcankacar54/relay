import test from "node:test";
import assert from "node:assert/strict";
import { clockLocative } from "../shared/tr-dative";

test("a clock takes the locative its spoken form asks for", () => {
  const cases: [string, string][] = [
    ["14:00", "14:00’te"], // on dört
    ["13:00", "13:00’te"], // on üç
    ["15:00", "15:00’te"], // on beş
    ["16:00", "16:00’da"], // on altı
    ["17:00", "17:00’de"], // on yedi
    ["18:00", "18:00’de"], // on sekiz
    ["09:00", "09:00’da"], // dokuz
    ["10:00", "10:00’da"], // on
    ["12:00", "12:00’de"], // on iki
    ["20:00", "20:00’de"], // yirmi
    ["00:00", "00:00’da"], // sıfır
    ["14:30", "14:30’da"], // otuz
    ["14:40", "14:40’ta"], // kırk
    ["14:50", "14:50’de"], // elli
    ["14:05", "14:05’te"], // beş
    ["14:10", "14:10’da"], // on
    ["14:21", "14:21’de"], // yirmi bir
  ];
  for (const [clock, expected] of cases) assert.equal(clockLocative(clock), expected, clock);
});

test("what is not a clock is left as it is", () => {
  assert.equal(clockLocative("—"), "—");
  assert.equal(clockLocative(""), "");
});
