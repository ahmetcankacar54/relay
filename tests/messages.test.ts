import test from "node:test";
import assert from "node:assert/strict";
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
