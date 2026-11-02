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
      "Limit okuma girişinin yenilenmesi bitene kadar bekle.",
      "Wait for the usage sign-in renewal to finish.",
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
    // Thrown in Turkish by the service.
    [
      "Claude uygulamasında doğru hesabın açık olduğunu doğrula.",
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

test("the saved sign-in (vault) errors read in Turkish, inner reason included", () => {
  const missing = 'The Keychain item "Relay Vault Key" was not found.';
  assert.equal(
    localizeError(missing, "tr"),
    'Anahtarlık’ta "Relay Vault Key" öğesi bulunamadı.',
  );
  assert.equal(
    localizeError(
      `The Keychain item "Relay Vault Key" could not be read, so saved Claude app sign-ins cannot be opened. ${missing} To start over, run relay reset-vault (npm i -g @ahmetcankacar/relay) and save each account again.`,
      "tr",
    ),
    'Anahtarlık’taki "Relay Vault Key" öğesi okunamadı, bu yüzden kayıtlı Claude uygulaması girişleri açılamıyor. Anahtarlık’ta "Relay Vault Key" öğesi bulunamadı. Baştan başlamak için relay reset-vault komutunu çalıştır (npm i -g @ahmetcankacar/relay) ve her hesabı yeniden kaydet.',
  );
  assert.equal(
    localizeError(
      "2 saved sign-in files could not be opened and were set aside in desktop-vault/unreadable. Save the affected accounts’ Claude app sign-ins again.",
      "tr",
    ),
    "2 kayıtlı giriş dosyası açılamadı ve desktop-vault/unreadable klasörüne ayrıldı. Bu hesapların Claude uygulaması girişini yeniden kaydet.",
  );
  // English keeps the backend text, which never says "Desktop".
  assert.equal(localizeError(missing, "en"), missing);
  for (const message of [
    "No system keyring was found (Secret Service or KWallet), so Claude app sign-ins cannot be saved. Install and unlock gnome-keyring or KWallet, then restart Relay.",
    "System encryption is unavailable, so Claude app sign-ins cannot be saved.",
    "Relay could not open its old saved sign-ins this time (macOS did not allow access to their key). Nothing was moved; Relay tries again at its next start.",
    "Save this account’s Claude app sign-in first.",
  ])
    assert.notEqual(localizeError(message, "tr"), message, message);
});
