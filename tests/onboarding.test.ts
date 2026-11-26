import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  blockReason,
  cliDetail,
  cliState,
  codeTabOpened,
  desktopBlock,
  overviewCards,
  prerequisites,
  setupState,
} from "../src/lib/onboarding";
import { MIN_CLI_VERSION, USAGE_CLI_VERSION, meetsCliMinimum, readsUsage } from "../shared/cli-version";
import { EXTERNAL_LINKS, isExternalLink } from "../shared/external-links";
import { intentHash, PAGE_INTENTS } from "../src/app/routes";
import type { Account, DesktopState, Diagnostics } from "../shared/types";
import { testT } from "./i18n";

const tr = testT("tr");
const en = testT("en");
const ORG = "6f1c2d3e-4b5a-4c6d-8e7f-001122334455";
const desktop = (extra: Partial<DesktopState> = {}): DesktopState => ({
  available: true,
  running: true,
  organizations: [],
  busy: false,
  recoveryRequired: false,
  errorRevision: 0,
  ...extra,
});
const darwinDiagnostics = (extra: Partial<Diagnostics> = {}): Diagnostics => ({
  platform: "darwin",
  dataDir: "/tmp/relay",
  desktopSupported: true,
  executable: "/usr/local/bin/claude",
  version: "2.1.300 (Claude Code)",
  ...extra,
});
const diagnostics = darwinDiagnostics;
const account = (id: string, linked = true): Account => ({
  id,
  name: id,
  kind: "personal",
  group: "personal",
  color: "olive",
  createdAt: "2026-10-18T09:00:00Z",
  ...(linked
    ? {
        desktop: {
          accountUuid: "00000000-0000-4000-8000-000000000001",
          orgId: ORG,
          savedAt: "2026-10-18T09:00:00Z",
        },
      }
    : {}),
});

test("the CLI minimum is the one the Desktop check uses", () => {
  assert.equal(MIN_CLI_VERSION, "2.1.285");
  assert.equal(meetsCliMinimum("2.1.284 (Claude Code)"), false);
  assert.equal(meetsCliMinimum("2.1.285 (Claude Code)"), true);
  assert.equal(meetsCliMinimum("2.2.0"), true);
  assert.equal(meetsCliMinimum("3.0.0"), true);
  assert.equal(meetsCliMinimum("1.9.999"), false);
  assert.equal(meetsCliMinimum("unknown"), false);
});

test("reading limits needs a newer CLI, the one the usage refresher enforces", () => {
  assert.equal(USAGE_CLI_VERSION, "2.1.296");
  assert.equal(readsUsage("2.1.295 (Claude Code)"), false);
  assert.equal(readsUsage("2.1.296 (Claude Code)"), true);
  assert.equal(readsUsage("2.2.0"), true);
  assert.equal(readsUsage("2.0.999"), false);
  assert.equal(readsUsage("1.9.999"), false);
  assert.equal(readsUsage("unknown"), false);
});

test("cliState reads the diagnostics: unknown, missing, unreadable, outdated or ok", () => {
  assert.equal(cliState(undefined), "unknown");
  assert.equal(
    cliState(diagnostics({ executable: undefined, version: undefined, error: "x" })),
    "missing",
  );
  assert.equal(
    cliState(diagnostics({ version: undefined, error: "Claude Code sürümü okunamadı." })),
    "unreadable",
  );
  assert.equal(cliState(diagnostics({ version: "2.1.200 (Claude Code)" })), "outdated");
  // The Desktop minimum is not enough: the ✓ means the CLI can read limits.
  assert.equal(cliState(diagnostics({ version: "2.1.290 (Claude Code)" })), "outdated");
  assert.equal(cliState(diagnostics({ version: "2.1.296 (Claude Code)" })), "ok");
  assert.equal(cliState(diagnostics()), "ok");
  // The preview's platform is not darwin; the version alone decides.
  assert.equal(cliState(diagnostics({ platform: "preview", desktopSupported: false })), "ok");
});

test("cliDetail names the version found, and the minimum when it is too old", () => {
  assert.equal(cliDetail("ok", "2.1.300 (Claude Code)", tr), "2.1.300 (Claude Code)");
  assert.equal(cliDetail("missing", undefined, tr), "Bulunamadı");
  assert.equal(cliDetail("missing", undefined, en), "Not found");
  assert.equal(cliDetail("unreadable", undefined, tr), "Sürümü okunamadı");
  assert.equal(cliDetail("unreadable", undefined, en), "Cannot read its version");
  assert.equal(cliDetail("outdated", "2.1.200", tr), "2.1.200 · 2.1.296 veya üstü gerekir");
  assert.equal(cliDetail("outdated", "2.1.200", en), "2.1.200 · needs 2.1.296 or later");
});

test("the Code tab counts as opened once the current sign-in has a workspace folder", () => {
  assert.equal(codeTabOpened(desktop({ currentAccountUuid: "u", organizations: [ORG] }), []), true);
  assert.equal(codeTabOpened(desktop({ currentAccountUuid: "u", organizations: [] }), [account("a")]), false);
  // With no account signed in, a saved Claude app sign-in shows a workspace existed.
  assert.equal(codeTabOpened(desktop({ organizations: [] }), [account("a")]), true);
  assert.equal(codeTabOpened(desktop({ organizations: [] }), [account("a", false)]), false);
  assert.equal(codeTabOpened(desktop({ organizations: [] }), []), false);
});

test("on macOS the CLI is never a step: the Claude app's own sign-in reads the limits", () => {
  const missing = prerequisites({
    desktop: desktop({ currentAccountUuid: "u", organizations: [ORG] }),
    diagnostics: diagnostics({ executable: undefined, version: undefined }),
    accounts: [],
  });
  assert.deepEqual(missing?.items, [
    { key: "desktop", met: true },
    { key: "code", met: true },
  ]);
  assert.equal(missing?.cli, "missing");
  assert.equal(missing?.complete, true);
});

test("elsewhere prerequisites wait for both snapshots; the CLI is a step only when Code is open and it is still missing", () => {
  const diagnostics = (extra: Partial<Diagnostics> = {}) => darwinDiagnostics({ platform: "linux", ...extra });
  assert.equal(prerequisites({ desktop: undefined, diagnostics: diagnostics(), accounts: [] }), undefined);
  assert.equal(prerequisites({ desktop: desktop(), diagnostics: undefined, accounts: [] }), undefined);
  const none = prerequisites({
    desktop: desktop({ available: false }),
    diagnostics: diagnostics({ executable: undefined, version: undefined, error: "x" }),
    accounts: [],
  });
  // Opening Code makes the Claude app download its own Claude Code: no CLI step before it.
  assert.deepEqual(none, {
    items: [
      { key: "desktop", met: false },
      { key: "code", met: false },
    ],
    cli: "missing",
    complete: false,
  });
  const outdated = prerequisites({
    desktop: desktop({ currentAccountUuid: "u", organizations: [ORG] }),
    diagnostics: diagnostics({ version: "2.1.100" }),
    accounts: [],
  });
  assert.deepEqual(outdated?.items, [
    { key: "desktop", met: true },
    { key: "code", met: true },
    { key: "cli", met: false },
  ]);
  assert.equal(outdated?.cli, "outdated");
  assert.equal(outdated?.complete, false);
  const all = prerequisites({
    desktop: desktop({ currentAccountUuid: "u", organizations: [ORG] }),
    diagnostics: diagnostics(),
    accounts: [],
  });
  assert.deepEqual(all?.items.map((i) => i.met), [true, true]);
  assert.equal(all?.complete, true);
});

test("a disabled onboarding button has a reason for every Claude app lock", () => {
  const idle = { desktop: desktop(), desktopBusy: false, pendingDesktop: undefined };
  assert.equal(desktopBlock(idle), undefined);
  assert.equal(desktopBlock({ ...idle, desktop: undefined }), "loading");
  assert.equal(desktopBlock({ ...idle, desktop: desktop({ available: false }) }), "no-desktop");
  assert.equal(desktopBlock({ ...idle, desktop: desktop({ recoveryRequired: true }) }), "recovery");
  assert.equal(desktopBlock({ ...idle, pendingDesktop: account("p") }), "pending");
  assert.equal(desktopBlock({ ...idle, desktopBusy: true }), "busy");
  // Loading has no words: it lasts one snapshot.
  assert.equal(blockReason("loading", tr), undefined);
  assert.equal(blockReason(undefined, tr), undefined);
  const words = {
    "no-desktop": ["Claude uygulaması bulunamadı; önce onu kur.", "Relay cannot find the Claude app. Install it first."],
    recovery: ["Önce Claude uygulaması yedeğini geri yükle.", "Restore the Claude app backup first."],
    pending: [
      "Önce devam eden Claude uygulaması girişini tamamla veya iptal et.",
      "Finish or cancel the current Claude app sign-in first.",
    ],
    busy: ["Claude uygulamasında bir işlem sürüyor.", "A Claude app action is in progress."],
    limit: ["En fazla 50 hesap eklenebilir.", "You can add up to 50 accounts."],
    "all-linked": [
      "Her profilin Claude uygulaması girişi kayıtlı.",
      "Every profile already has a Claude app sign-in.",
    ],
  } as const;
  for (const [block, [trText, enText]] of Object.entries(words)) {
    assert.equal(blockReason(block as keyof typeof words, tr), trText, block);
    assert.equal(blockReason(block as keyof typeof words, en), enText, block);
  }
});

test("the Today card waits for one connected account, automation for two", () => {
  assert.deepEqual(overviewCards([]), { today: false, automation: false });
  // A profile without a saved Claude app sign-in is not connected yet.
  assert.deepEqual(overviewCards([account("a", false)]), { today: false, automation: false });
  assert.deepEqual(overviewCards([account("a"), account("b", false)]), { today: true, automation: false });
  assert.deepEqual(overviewCards([account("a"), account("b")]), { today: true, automation: true });
});

test("only the two first-run pages, the providers' terms and the Full Disk Access pane may open outside Relay", () => {
  assert.deepEqual(EXTERNAL_LINKS, {
    claudeDownload: "https://claude.ai/download",
    cliSetup: "https://docs.anthropic.com/en/docs/claude-code/setup",
    claudeTerms: "https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use",
    antigravityTerms: "https://antigravity.google/docs/faq",
    anthropicAup: "https://www.anthropic.com/legal/aup",
    antigravityServiceTerms: "https://antigravity.google/terms",
    openaiSignIn: "https://help.openai.com/en/articles/20001542",
    githubTerms: "https://docs.github.com/en/site-policy/github-terms/github-terms-of-service",
    geminiCliFaq: "https://geminicli.com/docs/resources/faq/",
    cursorTerms: "https://cursor.com/terms-of-service",
    fullDiskAccess: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
  });
  assert.equal(isExternalLink("https://claude.ai/download"), true);
  assert.equal(isExternalLink("https://docs.anthropic.com/en/docs/claude-code/setup"), true);
  assert.equal(isExternalLink("https://claude.ai/download?x=1"), false);
  assert.equal(isExternalLink("https://example.com"), false);
  assert.equal(isExternalLink("file:///etc/passwd"), false);
});

test("openPage carries the add intent to the main window", () => {
  assert.deepEqual(PAGE_INTENTS, ["ekle"]);
  assert.equal(intentHash("hesaplar", "ekle"), "#/hesaplar?ekle");
  assert.equal(intentHash("genel"), "#/genel");
  const shell = readFileSync(new URL("../src/app/Shell.tsx", import.meta.url), "utf8");
  assert.match(shell, /window\.location\.hash = intentHash\(page, intent\)/);
});

test("the setup list needs two connected accounts and a choice of when to switch; the extension and open at login are optional", () => {
  const ready = desktop({ organizations: [ORG] });
  const settings = { autoSwitchMode: "off" as const, claudeExtension: { mode: "guide" as const } };
  const keys = (s?: ReturnType<typeof setupState>) => s?.steps.map((x) => `${x.key}:${x.met}${x.optional ? "?" : ""}`);
  assert.equal(setupState({ desktop: ready, accounts: [], settings }), undefined);
  const none = setupState({ desktop: ready, diagnostics: diagnostics(), accounts: [], settings });
  assert.deepEqual(keys(none), ["desktop:true", "code:true", "first:false", "second:false", "mode:false", "extension:false?", "login:false?"]);
  assert.equal(none?.ready, false);
  // An account without a saved Claude app sign-in does not count.
  const loose = setupState({ desktop: ready, diagnostics: diagnostics(), accounts: [account("a"), account("b", false)], settings });
  assert.deepEqual(keys(loose)?.slice(2, 4), ["first:true", "second:false"]);
  // Two accounts and a mode: ready, though the extension is still open until skipped.
  const two = [account("a"), account("b")];
  const chosen = setupState({ desktop: ready, diagnostics: diagnostics(), accounts: two, settings: { ...settings, autoSwitchMode: "after-exit" } });
  assert.equal(chosen?.ready, true);
  assert.equal(chosen?.complete, false);
  const skipped = setupState({ desktop: ready, diagnostics: diagnostics(), accounts: two, settings, seen: new Set(["mode", "extension", "login"]) });
  assert.equal(skipped?.complete, true);
  // Open at login stays open until it is on or skipped.
  const loginOpen = setupState({ desktop: ready, diagnostics: diagnostics(), accounts: two, settings, seen: new Set(["mode", "extension"]) });
  assert.equal(loginOpen?.complete, false);
  // Continue at quota counts as a choice; Linux has the extension step too, Windows does not.
  const linux = setupState({ desktop: ready, diagnostics: diagnostics({ platform: "linux" }), accounts: two, settings, quota: true });
  assert.deepEqual(keys(linux)?.at(-2), "extension:false?");
  assert.equal(linux?.ready, true);
  const windows = setupState({ desktop: ready, diagnostics: diagnostics({ platform: "win32" }), accounts: two, settings: { ...settings, launchAtLogin: true }, quota: true });
  assert.deepEqual(keys(windows)?.slice(-2), ["mode:true", "login:true?"]);
  assert.equal(windows?.complete, true);
  // The extension that follows the account is met.
  const follows = setupState({ desktop: ready, diagnostics: diagnostics(), accounts: two, settings: { ...settings, claudeExtension: { mode: "restart" } } });
  assert.deepEqual(keys(follows)?.at(-2), "extension:true?");
});
