import test from "node:test";
import assert from "node:assert/strict";
import { targetWorkspace, workspaceOptions } from "../src/lib/workspaces";
import type { Account } from "../shared/types";

const tr = (tr: string) => tr;
const en = (_: string, en: string) => en;
const A = "6f1c2d3e-4b5a-4c6d-8e7f-001122334455";
const B = "a1b2c3d4-0000-4000-8000-000000000002";
const C = "c0ffee00-0000-4000-8000-000000000003";
const withOrg = (id: string, orgId: string, orgName?: string): Account => ({
  id,
  name: id,
  kind: "work",
  group: `work:${id}`,
  color: "blue",
  createdAt: "2026-10-18T09:00:00Z",
  auth: { loggedIn: true, orgId, orgName, checkedAt: "2026-10-18T09:00:00Z" },
});

test("a workspace is named by the organization Relay knows for it", () => {
  // The CLI may report the id in upper case; folder names are lower case.
  const accounts = [withOrg("x", B.toUpperCase(), "Vertex")];
  assert.deepEqual(workspaceOptions([A, B], accounts, tr), [
    { id: A, label: "Çalışma alanı 1", short: "6f1c2d3e" },
    { id: B, label: "Vertex", short: "a1b2c3d4" },
  ]);
});

test("unnamed workspaces are numbered in order, never shown as a raw id", () => {
  const options = workspaceOptions([A, B, C], [withOrg("x", B)], en);
  assert.deepEqual(
    options.map((o) => o.label),
    ["Workspace 1", "Workspace 2", "Workspace 3"],
  );
  for (const o of options) {
    assert.doesNotMatch(o.label, /[0-9a-f]{8}-/);
    assert.equal(o.short, o.id.slice(0, 8));
  }
});

test("a known name skips the numbering, so the numbers stay consecutive", () => {
  const labels = workspaceOptions([A, B, C], [withOrg("x", B, "Vertex")], tr).map((o) => o.label);
  assert.deepEqual(labels, ["Çalışma alanı 1", "Vertex", "Çalışma alanı 2"]);
});

test("the only workspace is chosen without asking", () => {
  assert.equal(targetWorkspace([A], ""), A);
  assert.equal(targetWorkspace([A, B], ""), "");
  assert.equal(targetWorkspace([A, B], B), B);
  // A choice the folders no longer have falls back.
  assert.equal(targetWorkspace([A], B), A);
  assert.equal(targetWorkspace([], A), "");
  assert.equal(targetWorkspace(undefined, A), "");
});
