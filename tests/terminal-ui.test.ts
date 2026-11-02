import test from "node:test";
import assert from "node:assert/strict";
import type { Account } from "../shared/types";
import type { TerminalStatus } from "../shared/terminal-identity";
import { terminalGuide } from "../src/lib/terminal-ui";

const tr = (a: string) => a;
const U = "00000000-0000-4000-8000-000000000001";
const O = "00000000-0000-4000-8000-000000000002";
const account = (desktop = true) =>
  ({
    id: "a", name: "Kişisel", kind: "personal", group: "personal", color: "olive", createdAt: "",
    ...(desktop ? { desktop: { accountUuid: U, orgId: O, savedAt: "", email: "me@x.test" } } : {}),
  }) as Account;
const status = (patch: Partial<TerminalStatus> = {}) => ({ mode: "follow", saved: [], ...patch }) as TerminalStatus;

test("the terminal row: linked when saved or on the account now, a guide otherwise", () => {
  assert.equal(terminalGuide(account(), undefined, tr, "tr").label, "Kontrol ediliyor…");
  assert.equal(terminalGuide(account(), status({ mode: "off" }), tr, "tr").action, "settings");
  assert.equal(terminalGuide(account(false), status(), tr, "tr").label, "Önce Claude uygulaması girişini kaydet.");
  const missing = terminalGuide(account(), status(), tr, "tr");
  assert.equal(missing.tone, "warn");
  assert.match(missing.steps![0], /claude auth login.*me@x\.test/);
  const saved = terminalGuide(account(), status({ saved: [{ accountUuid: U, orgId: O, savedAt: "2026-11-01T10:00:00Z", parked: true }] }), tr, "tr");
  assert.equal(saved.tone, "ok");
  assert.match(saved.label, /^Bağlı · /);
  const here = terminalGuide(
    account(),
    status({ current: { state: "signed-in", accountUuid: U, orgId: O, known: true, at: "" } as TerminalStatus["current"] }),
    tr,
    "tr",
  );
  assert.equal(here.label, "Bağlı · terminal şu an bu hesapta");
});
