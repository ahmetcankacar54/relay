import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { localizeError } from "../src/messages";

// The backend errors, word for word (electron/core/desktop.ts and desktop-host.ts). The lookup is
// keyed by this text, so it must keep matching while the display names the sign-in as the app does.
const backend = {
  missing: "Saved Desktop sign-in is missing. Connect this account again.",
  invalid: "Invalid saved Desktop sign-in.",
  pending: "Finish or cancel the current Desktop sign-in first.",
  encryption:
    "System encryption is unavailable. Desktop sign-in was not saved.",
};

test("saved sign-in errors name the Claude app sign-in in both languages", () => {
  assert.equal(
    localizeError(backend.missing, "tr"),
    "Kayıtlı Claude uygulaması girişi eksik. Hesabı yeniden bağla.",
  );
  assert.equal(
    localizeError(backend.missing, "en"),
    "Saved Claude app sign-in is missing. Connect this account again.",
  );
  assert.equal(
    localizeError(backend.invalid, "tr"),
    "Kayıtlı Claude uygulaması girişi geçersiz.",
  );
  assert.equal(
    localizeError(backend.invalid, "en"),
    "Invalid saved Claude app sign-in.",
  );
  assert.equal(
    localizeError(backend.pending, "tr"),
    "Önce devam eden Claude uygulaması girişini tamamla veya iptal et.",
  );
  assert.equal(
    localizeError(backend.pending, "en"),
    "Finish or cancel the current Claude app sign-in first.",
  );
  assert.equal(
    localizeError(backend.encryption, "tr"),
    "İşletim sistemi şifrelemesi kullanılamıyor. Claude uygulaması girişi kaydedilmedi.",
  );
  assert.equal(
    localizeError(backend.encryption, "en"),
    "System encryption is unavailable. Claude app sign-in was not saved.",
  );
});

test("the errors main's IPC handlers throw read in both languages", () => {
  const cases: [string, string, string][] = [
    [
      "Wait for the account connection refresh to finish.",
      "Hesap bağlantısının yenilenmesi bitene kadar bekle.",
      "Wait for the account connection refresh to finish.",
    ],
    [
      "Finish the Desktop handoff before signing in.",
      "Giriş yapmadan önce Claude uygulamasındaki işlemin bitmesini bekle.",
      "Wait for the Claude app operation to finish before signing in.",
    ],
    [
      "Finish the Desktop handoff before starting another Desktop operation.",
      "Claude uygulamasındaki işlemin bitmesini bekle, sonra yenisini başlat.",
      "Wait for the Claude app operation to finish before starting another.",
    ],
    [
      "Finish the Desktop operation before changing preferences.",
      "Tercihleri değiştirmeden önce Claude uygulamasındaki işlemi tamamla.",
      "Finish the Claude app operation before changing preferences.",
    ],
    ["Geçersiz IPC kaynağı.", "Geçersiz IPC kaynağı.", "Invalid IPC source."],
    // Thrown in Turkish by the service, which named the app "Desktop".
    [
      "Desktop’ta doğru hesabın açık olduğunu doğrula.",
      "Claude uygulamasında doğru hesabın açık olduğunu doğrula.",
      "Check that the right account is open in the Claude app.",
    ],
  ];
  for (const [backend, tr, en] of cases) {
    assert.equal(localizeError(backend, "tr"), tr, backend);
    assert.equal(localizeError(backend, "en"), en, backend);
  }
});

test("every error main.ts throws with a fixed message has both languages", () => {
  const main = readFileSync(new URL("../electron/main.ts", import.meta.url), "utf8");
  const thrown = [
    ...main.matchAll(/new Error\(\s*"([^"]+)",?\s*\)/g),
  ].map((m) => m[1]);
  assert.ok(thrown.length >= 5, String(thrown.length));
  for (const message of thrown) {
    const tr = localizeError(message, "tr");
    const en = localizeError(message, "en");
    assert.ok(tr !== message || en !== message, message);
    assert.doesNotMatch(`${tr} ${en}`, /Desktop/, message);
  }
});

test("an error Relay does not know is shown as it came", () => {
  assert.equal(
    localizeError("Something else broke.", "tr"),
    "Something else broke.",
  );
  assert.equal(
    localizeError("Something else broke.", "en"),
    "Something else broke.",
  );
});
