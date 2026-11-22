import test from "node:test";
import assert from "node:assert/strict";
import type { Account } from "../shared/types";
import { groupName, isProvisionalName, provisionalName, suggestProfile } from "../src/lib/profile-suggestion";
import { testT } from "./i18n";

const tr = testT("tr");
const en = testT("en");
const acc = (id: string, name: string, extra: Partial<Account> = {}) =>
  ({ id, name, kind: "personal", group: "personal", color: "olive", createdAt: "", ...extra }) as Account;

test("a new profile is called Hesap N until Relay knows whose it is", () => {
  assert.equal(provisionalName([], tr), "Hesap 1");
  assert.equal(provisionalName([acc("a", "Kişisel"), acc("b", "Hesap 3")], tr), "Hesap 4");
  assert.equal(provisionalName([acc("a", "hesap 2")], tr), "Hesap 3");
  assert.equal(provisionalName([], en), "Account 1");
  assert.ok(isProvisionalName("Hesap 12", tr) && isProvisionalName(" Account 2 ", en));
  assert.ok(!isProvisionalName("Hesap", tr) && !isProvisionalName("Vertex", tr) && !isProvisionalName("Hesap 2b", tr));
  // The provisional name is the current language's.
  assert.ok(!isProvisionalName("Account 2", tr));
});

test("a Team seat is a work account named and grouped after its organization; others are personal", () => {
  const team = acc("t", "Hesap 2", { auth: { loggedIn: true, email: "ahmet@vertex.com", orgName: "Vertex", subscription: "team" } as Account["auth"] });
  assert.deepEqual(suggestProfile(team, [team], "tr"), { name: "Vertex", kind: "work", group: "Vertex" });
  const max = acc("m", "Hesap 1", { auth: { loggedIn: true, email: "deniz.kaya@gmail.com", subscription: "max" } as Account["auth"] });
  assert.deepEqual(suggestProfile(max, [max], "tr"), { name: "Deniz kaya", kind: "personal" });
  // The first letter is capitalized as the language does it.
  const ismail = acc("i", "Hesap 4", { auth: { loggedIn: true, email: "ismail@gmail.com" } as Account["auth"] });
  assert.equal(suggestProfile(ismail, [ismail], "tr")?.name, "İsmail");
  assert.equal(suggestProfile(ismail, [ismail], "en")?.name, "Ismail");
  // A name another profile already has gets a number.
  assert.deepEqual(suggestProfile(team, [team, acc("x", "vertex")], "tr"), { name: "Vertex 2", kind: "work", group: "Vertex" });
  assert.equal(suggestProfile(acc("n", "Hesap 3"), [], "tr"), undefined);
});

test("the group field shows a work account's own group name, and nothing for its private group", () => {
  assert.equal(groupName({ id: "w", kind: "work", group: "work:Vertex" }), "Vertex");
  assert.equal(groupName({ id: "w", kind: "work", group: "work:w" }), "");
  assert.equal(groupName({ id: "p", kind: "personal", group: "personal" }), "");
});
