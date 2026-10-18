import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ContinuationSettings,
  type ContinuationSettingsView,
} from "../src/features/ContinuationSettings";
import type { Account } from "../shared/types";

const account = (id: string, name: string): Account => ({
  id,
  name,
  kind: "personal",
  group: "personal",
  color: "olive",
  createdAt: "2026-10-13T08:00:00.000Z",
  desktop: {
    accountUuid: `account-${id}`,
    orgId: `org-${id}`,
    email: `${id}@example.test`,
    savedAt: "2026-10-13T08:00:00.000Z",
  },
  auth: {
    loggedIn: true,
    accountUuid: `account-${id}`,
    orgId: `org-${id}`,
    checkedAt: "2026-10-13T08:00:00.000Z",
  },
});
const source = account("a", "Source account");
const target = account("b", "Target account");
const view: ContinuationSettingsView = {
  status: "off",
  reason: "disabled",
  enabled: false,
  executable: true,
  sourceId: source.id,
  targetId: target.id,
  sessionId: "ceab1e31-2bbd-4fa0-a92e-5c25f482a533",
  projectKey: "/isolated/project",
  permissionMode: "Manual",
};
/** Opening tag of the first button whose visible text contains `name`. */
function buttonTag(html: string, name: string) {
  for (const m of html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g))
    if (m[2].replace(/<[^>]*>/g, "").includes(name)) return m[1];
  return undefined;
}
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
const consentTag = (html: string) =>
  html.match(/<button[^>]*role="switch"[^>]*>/)?.[0];
function render(
  patch: Partial<ContinuationSettingsView> = {},
  blockingReason?: string,
  language = "en",
) {
  return renderToStaticMarkup(
    createElement(ContinuationSettings, {
      accounts: [source, target],
      active: source,
      value: { ...view, ...patch },
      busy: false,
      canArm: true,
      blockingReason,
      onRefresh: () => {},
      onArm: () => {},
      onDisable: () => {},
      t: (tr, en) => (language === "tr" ? tr : en),
    }),
  );
}

test("read-only readiness does not arm or authorize a continuation, and unavailable execution cannot be enabled", () => {
  const ready = render();
  assert.match(consentTag(ready) ?? "", /aria-checked="false"/);
  assert.match(buttonTag(ready, "Watch this conversation") ?? "", /disabled=""/);
  assert.match(ready, /restart the Claude app/);
  assert.match(ready, /one continuation message/);
  const unavailable = render({ executable: false });
  assert.match(unavailable, /Automatic continuation cannot be enabled/);
  assert.match(consentTag(unavailable) ?? "", /disabled=""/);
  assert.match(buttonTag(unavailable, "Watch this conversation") ?? "", /disabled=""/);
});

test("execution and verified completion remain visible when an older observation reason is present", () => {
  const executing = render(
    { status: "executing", reason: "checkpointed-handoff", enabled: true },
    "accessibility-permission-required",
  );
  assert.match(executing, /Verifying the saved conversation/);
  assert.doesNotMatch(executing, /Allow Relay in macOS Accessibility/);
  const completed = render(
    { status: "continued", reason: "new-turn-verified", enabled: false },
    "claude-not-running",
  );
  assert.match(completed, /new response started in the same conversation/);
  assert.match(completed, /permission mode preserved/);
  assert.match(completed, /one-time watch is complete/);
  assert.doesNotMatch(completed, /Open the Claude app and choose/);
});

test("ambiguous delivery keeps its non-repeat explanation instead of an unrelated observation error", () => {
  const html = render(
    {
      status: "reconciliation-required",
      reason: "delivery-unknown",
      enabled: false,
    },
    "composer-not-empty",
  );
  assert.match(html, /whether the continuation message arrived/);
  assert.match(html, /It will not be sent again/);
  assert.doesNotMatch(html, /message field has a draft/);
});

test("each guarded wait explains the actual work and retains a way to turn watching off", () => {
  const reasons: Record<string, RegExp> = {
    "awaiting-quota-stop": /percentage alone does not trigger a switch/,
    "not-quiescent:busyWorkers": /Another response or operation is running/,
    "not-quiescent:subagents": /A subtask is still running/,
    "not-quiescent:waiting": /waiting for approval or input/,
    "not-quiescent:unknownWork": /Could not verify the state of some tasks/,
  };
  for (const [reason, expected] of Object.entries(reasons)) {
    const html = render({ status: "waiting", reason, enabled: true });
    assert.match(html, expected);
    assert.match(html, /Turn off watching/);
    assert.doesNotMatch(html, /role="switch"/);
  }
});

test("changing a selected conversation pauses the retained watch and tells the user how to rebind it", () => {
  const html = render({
    status: "blocked",
    reason: "selected-session-changed",
    enabled: true,
  });
  assert.match(html, /different conversation is open/);
  assert.match(html, /Switching is paused/);
  assert.match(html, /Turn off watching/);
  assert.doesNotMatch(html, /This watch stopped/);
  const tr = render(
    { status: "blocked", reason: "permission-mode-changed", enabled: true },
    undefined,
    "tr",
  );
  assert.match(tr, /İzin modu/);
  assert.match(tr, /izlemeyi kapatıp yeniden aç/);
});

test("automatic watching presents capacity selection without a fixed target control", () => {
  const html = render({ targetId: undefined, targetSelection: "automatic" });
  assert.doesNotMatch(html, /<select/);
  assert.match(html, /Automatic · by remaining capacity/);
  assert.match(html, /1 connected accounts · checked at handoff/);
  assert.match(html, /switch to an eligible account and send one continuation/);
  assert.match(html, /chosen by current quota and plan capacity/);
  assert.match(html, /enable watching again to include accounts added later/);
});

test("an automatic watch explains missing live quota and reveals a frozen target only after selection", () => {
  const waiting = render({
    status: "waiting",
    reason: "automatic-target-unavailable",
    enabled: true,
    targetId: undefined,
    targetSelection: "automatic",
    allowedTargetCount: 2,
  });
  assert.match(waiting, /2 connected accounts · checked at handoff/);
  assert.match(
    waiting,
    /No connected account in the shared history scope has fresh, sufficient quota/,
  );
  assert.doesNotMatch(text(waiting), /Target account/);
  const pending = render({
    status: "reconciliation-required",
    reason: "delivery-unknown",
    targetSelection: "automatic",
  });
  assert.match(text(pending), /Target account/);
  assert.match(pending, /b@example.test/);
  assert.match(pending, /It will not be sent again/);
});

test("a previous fixed-target watch does not imply newly expanded automatic authorization", () => {
  const html = render({
    status: "armed",
    reason: "awaiting-quota-stop",
    enabled: true,
  });
  assert.match(text(html), /Target account/);
  assert.match(html, /This earlier watch retains its saved target account/);
  assert.match(
    html,
    /Turn watching off and on to use automatic account selection/,
  );
});
