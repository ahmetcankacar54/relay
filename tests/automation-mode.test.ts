import test from "node:test";
import assert from "node:assert/strict";
import {
  AUTOMATION_MODES,
  automationMode,
  automationModeWrites,
} from "../shared/automation-mode";
import { withDative } from "../shared/tr-dative";

test("the mode comes from the fleet first, then prepare-on-quit", () => {
  assert.equal(
    automationMode({ autoSwitchMode: "after-exit" }, { enabled: true }),
    "quota",
  );
  assert.equal(
    automationMode({ autoSwitchMode: "off" }, { enabled: true }),
    "quota",
  );
  assert.equal(
    automationMode({ autoSwitchMode: "after-exit" }, { enabled: false }),
    "after-exit",
  );
  assert.equal(automationMode({ autoSwitchMode: "after-exit" }), "after-exit");
  assert.equal(automationMode({ autoSwitchMode: "off" }), "off");
});

test("each mode writes both records", () => {
  assert.deepEqual(automationModeWrites("off"), {
    fleet: false,
    autoSwitchMode: "off",
  });
  assert.deepEqual(automationModeWrites("after-exit"), {
    fleet: false,
    autoSwitchMode: "after-exit",
  });
  assert.deepEqual(automationModeWrites("quota"), {
    fleet: true,
    autoSwitchMode: "off",
  });
});

test("every mode has a Turkish and English label and description", () => {
  assert.deepEqual(
    AUTOMATION_MODES.map((mode) => mode.value),
    ["off", "after-exit", "quota"],
  );
  assert.deepEqual(
    AUTOMATION_MODES.map((mode) => mode.label),
    [
      ["Kapalı", "Off"],
      ["Claude kapanınca", "When Claude quits"],
      ["Kota dolunca", "At quota"],
    ],
  );
  const [off, afterExit, quota] = AUTOMATION_MODES;
  assert.deepEqual(off.description, [
    "Relay hesabı kendiliğinden değiştirmez.",
    "Relay never switches accounts on its own.",
  ]);
  assert.deepEqual(afterExit.description, [
    "Kota dolunca, sen Claude’u kapattığında sıradaki hesabı hazırlar. Claude’u kendisi kapatmaz.",
    "When a quota runs out, prepares the next account once you quit Claude. Never quits Claude itself.",
  ]);
  assert.deepEqual(quota.description, [
    "Kota dolunca, çalışan iş bitince Claude’u sıradaki hesapla yeniden açar ve kota yüzünden duran Code konuşmalarını devam ettirir.",
    "When a quota runs out and running work finishes, reopens Claude on the next account and continues the Code conversations that stopped at the limit.",
  ]);
});

test("Turkish dative follows vowel harmony, buffer y and digit readings", () => {
  const cases: [string, string][] = [
    ["Kişisel", "Kişisel’e"],
    ["Alto", "Alto’ya"],
    ["Kişisel · İkinci", "Kişisel · İkinci’ye"],
    ["Studio", "Studio’ya"],
    ["Danışmanlık", "Danışmanlık’a"],
    ["Vertex", "Vertex’e"],
    ["Max", "Max’a"],
    ["Team 2", "Team 2’ye"],
    ["Pro 6", "Pro 6’ya"],
    ["Max 5×", "Max 5×’e"],
    ["XYZ", "XYZ’e"],
  ];
  for (const [name, dative] of cases)
    assert.equal(withDative(name), dative, name);
});

test("the dative reads the other digits, the Turkish capitals and trailing marks", () => {
  const cases: [string, string][] = [
    ["Hat 0", "Hat 0’a"], // sıfır
    ["Hat 1", "Hat 1’e"], // bir
    ["Hat 3", "Hat 3’e"], // üç
    ["Hat 4", "Hat 4’e"], // dört
    ["Hat 7", "Hat 7’ye"], // yedi
    ["Hat 8", "Hat 8’e"], // sekiz
    ["Hat 9", "Hat 9’a"], // dokuz
    ["ISIK", "ISIK’a"], // I is dotless: ı
    ["İZMİR", "İZMİR’e"], // İ is dotted: i
    ["Okul ·", "Okul ·’a"], // the mark is skipped; the suffix still ends the name
    ["Alto (Eski)", "Alto (Eski)’ye"],
    ["···", "···’e"],
    ["", "’e"],
  ];
  for (const [name, dative] of cases)
    assert.equal(withDative(name), dative, JSON.stringify(name));
});
