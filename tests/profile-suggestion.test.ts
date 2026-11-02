import test from "node:test";
import assert from "node:assert/strict";
import type { Account } from "../shared/types";
import { groupName, isProvisionalName, provisionalName, suggestProfile } from "../src/lib/profile-suggestion";

const tr = (a: string) => a;
const en = (_: string, b: string) => b;
const acc = (id: string, name: string, extra: Partial<Account> = {}) =>
  ({ id, name, kind: "personal", group: "personal", color: "olive", createdAt: "", ...extra }) as Account;

test("a new profile is called Hesap N until Relay knows whose it is", () => {
  assert.equal(provisionalName([], tr), "Hesap 1");
  assert.equal(provisionalName([acc("a", "Kişisel"), acc("b", "Hesap 3")], tr), "Hesap 4");
  assert.equal(provisionalName([acc("a", "hesap 2")], tr), "Hesap 3");
  assert.equal(provisionalName([], en), "Account 1");
  assert.ok(isProvisionalName("Hesap 12") && isProvisionalName("Account 2"));
  assert.ok(!isProvisionalName("Hesap") && !isProvisionalName("Vertex"));
});

test("a Team seat is a work account named and grouped after its organization; others are personal", () => {
  const team = acc("t", "Hesap 2", { auth: { loggedIn: true, email: "ahmet@vertex.com", orgName: "Vertex", subscription: "team" } as Account["auth"] });
  assert.deepEqual(suggestProfile(team, [team]), { name: "Vertex", kind: "work", group: "Vertex" });
  const max = acc("m", "Hesap 1", { auth: { loggedIn: true, email: "deniz.kaya@gmail.com", subscription: "max" } as Account["auth"] });
  assert.deepEqual(suggestProfile(max, [max]), { name: "Deniz kaya", kind: "personal" });
  // A name another profile already has gets a number.
  assert.deepEqual(suggestProfile(team, [team, acc("x", "vertex")]), { name: "Vertex 2", kind: "work", group: "Vertex" });
  assert.equal(suggestProfile(acc("n", "Hesap 3"), []), undefined);
});

test("the group field shows a work account's own group name, and nothing for its private group", () => {
  assert.equal(groupName({ id: "w", kind: "work", group: "work:Vertex" }), "Vertex");
  assert.equal(groupName({ id: "w", kind: "work", group: "work:w" }), "");
  assert.equal(groupName({ id: "p", kind: "personal", group: "personal" }), "");
});
