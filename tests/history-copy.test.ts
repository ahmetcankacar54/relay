import test from "node:test";
import assert from "node:assert/strict";
import { historyCopy } from "../src/pages/accounts/historyCopy";

const tr = (turkish: string) => turkish;
const en = (_: string, english: string) => english;

test("same-group keeps today's group field and its two sentences", () => {
  for (const [t, placeholder, personal, work] of [
    [
      tr,
      "Aynı gruptaki şirket hesapları Code geçmişini paylaşır",
      "Kişisel hesapların Code geçmişi aynı grupta korunur.",
      "Boş bırakırsan bu şirket hesabı ayrı tutulur.",
    ],
    [
      en,
      "Work accounts in the same group share Code history",
      "Personal accounts share their local Code history.",
      "Leave blank to keep this work account separate.",
    ],
  ] as const) {
    assert.deepEqual(historyCopy("same-group", "work", t), {
      groupPlaceholder: placeholder,
      note: work,
    });
    assert.deepEqual(historyCopy("same-group", "personal", t), {
      groupPlaceholder: placeholder,
      note: personal,
    });
  }
});

test("the other modes hide the group field and say what the mode shares", () => {
  const notes = {
    all: [
      "Code geçmişi bağlı tüm hesaplar arasında ortak. Geçiş sayfasından değiştirebilirsin.",
      "Code history is shared across every connected account. You can change this on the Switching page.",
    ],
    selected: [
      "Code geçmişi yalnızca Geçiş sayfasında seçtiğin hesaplar arasında ortak.",
      "Code history is shared only between the accounts you pick on the Switching page.",
    ],
    off: [
      "Code geçmişi hesaplar arasında paylaşılmıyor.",
      "Code history is not shared between accounts.",
    ],
  } as const;
  for (const mode of ["all", "selected", "off"] as const)
    for (const kind of ["personal", "work"] as const) {
      assert.deepEqual(historyCopy(mode, kind, tr), { note: notes[mode][0] });
      assert.deepEqual(historyCopy(mode, kind, en), { note: notes[mode][1] });
    }
});
