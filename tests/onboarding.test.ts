import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
import { supportsDesktop } from "../electron/core/environment";
import { Service } from "../electron/core/service";
import { localizeError } from "../src/messages";
import type { Account, DesktopState, Diagnostics } from "../shared/types";

const tr = (tr: string) => tr;
const en = (_: string, en: string) => en;
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
  // The platform gate stays in environment.ts; the version gate is the shared one.
  assert.equal(supportsDesktop("2.1.285", "darwin", "arm64"), true);
  assert.equal(supportsDesktop("2.1.285", "linux", "x64"), false);
});

test("reading limits needs a newer CLI, the one the usage refresher enforces", () => {
  assert.equal(USAGE_CLI_VERSION, "2.1.296");
  assert.equal(readsUsage("2.1.295 (Claude Code)"), false);
  assert.equal(readsUsage("2.1.296 (Claude Code)"), true);
  assert.equal(readsUsage("2.2.0"), true);
  assert.equal(readsUsage("2.0.999"), false);
  assert.equal(readsUsage("1.9.999"), false);
  assert.equal(readsUsage("unknown"), false);
  // The refresher in main reads the same constant, not a number of its own.
  const main = readFileSync(new URL("../electron/main.ts", import.meta.url), "utf8");
  assert.match(main, /readsUsage\(diagnostics\.version/);
  assert.doesNotMatch(main, /< 296/);
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

test("only the two first-run pages may open in the browser", () => {
  assert.deepEqual(EXTERNAL_LINKS, {
    claudeDownload: "https://claude.ai/download",
    cliSetup: "https://docs.anthropic.com/en/docs/claude-code/setup",
  });
  assert.equal(isExternalLink("https://claude.ai/download"), true);
  assert.equal(isExternalLink("https://docs.anthropic.com/en/docs/claude-code/setup"), true);
  assert.equal(isExternalLink("https://claude.ai/download?x=1"), false);
  assert.equal(isExternalLink("https://example.com"), false);
  assert.equal(isExternalLink("file:///etc/passwd"), false);
});

test("the main window opens allow-listed links in the browser and nothing else", () => {
  const main = readFileSync(new URL("../electron/main.ts", import.meta.url), "utf8");
  const opener = /window\.webContents\.setWindowOpenHandler\(([\s\S]*?)\n {2}\}\);/.exec(main)?.[1] ?? "";
  assert.match(opener, /isExternalLink\(url\)/);
  assert.match(opener, /shell\.openExternal\(url\)/);
  assert.match(opener, /action: "deny"/);
  // No new channel opens arbitrary URLs.
  assert.doesNotMatch(main, /handle\("open-(?:external|url|link)"/);
});

test("openPage carries the add intent to the main window", () => {
  assert.deepEqual(PAGE_INTENTS, ["ekle"]);
  assert.equal(intentHash("hesaplar", "ekle"), "#/hesaplar?ekle");
  assert.equal(intentHash("genel"), "#/genel");
  const main = readFileSync(new URL("../electron/main.ts", import.meta.url), "utf8");
  const start = main.indexOf('handle("open-page",');
  const handler = main.slice(start, main.indexOf('handle("quit"', start));
  assert.match(handler, /z\.enum\(PAGE_INTENTS\)\.optional\(\)\.parse\(intent\)/);
  assert.match(handler, /send\("relay:navigate", target, want\)/);
  const preload = readFileSync(new URL("../electron/preload.ts", import.meta.url), "utf8");
  assert.match(preload, /openPage: \(page, intent\) =>\s*ipcRenderer\.invoke\("relay:open-page", page, intent\)/);
  assert.match(preload, /callback\(page as never, intent as never\)/);
  const shell = readFileSync(new URL("../src/app/Shell.tsx", import.meta.url), "utf8");
  assert.match(shell, /window\.location\.hash = intentHash\(page, intent\)/);
});

test("a missing CLI error says where to choose the file, in both languages", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-cli-missing-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const service = new Service(path.join(root, "Relay"), () => {}, path.join(root, "unused"));
  service.store.update((s) => {
    s.executable = path.join(root, "no-such-claude");
  });
  const { error } = await service.diagnose();
  assert.ok(error);
  assert.equal(
    localizeError(error, "tr"),
    "Claude Code bulunamadı. Claude uygulamasında Code’u bir kez aç (Claude Code’u kendisi indirir) veya Ayarlar → Gelişmiş → Claude Code CLI → Dosyayı seç ile dosyasını göster.",
  );
  assert.equal(
    localizeError(error, "en"),
    "Relay cannot find Claude Code. Open Code once in the Claude app, or select the file in Settings → Advanced → Claude Code CLI.",
  );
});

const writeVersionCli = (file: string, version: string) =>
  fs.writeFile(file, `#!${process.execPath}\nconsole.log(${JSON.stringify(version)});\n`, { mode: 0o700 });

test("a CLI installed after Relay started is noticed by a later snapshot, at most once per throttle", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-cli-late-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const service = new Service(path.join(root, "Relay"), () => {}, path.join(root, "unused"));
  let now = 1_000_000;
  service.now = () => now;
  const cli = path.join(root, "claude");
  service.store.update((s) => {
    s.executable = cli;
  });
  const first = await service.panelSnapshot();
  assert.equal(first.diagnostics.executable, undefined);
  assert.ok(first.diagnostics.error);
  await writeVersionCli(cli, "2.1.296 (Claude Code)");
  // Within the throttle the cached result stands.
  now += 5_000;
  assert.ok((await service.panelSnapshot()).diagnostics.error);
  now += Service.REDIAGNOSE_MS;
  const found = (await service.panelSnapshot()).diagnostics;
  assert.equal(found.executable, cli);
  assert.equal(found.error, undefined);
  assert.equal(found.version, "2.1.296 (Claude Code)");
  assert.equal((await service.snapshot()).diagnostics.version, "2.1.296 (Claude Code)");
  // A usable result is kept for the whole process.
  await writeVersionCli(cli, "2.1.300 (Claude Code)");
  now += Service.REDIAGNOSE_MS * 2;
  assert.equal((await service.panelSnapshot()).diagnostics.version, "2.1.296 (Claude Code)");
});

test("a CLI too old to read limits is looked at again, so an update is noticed", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-cli-old-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const service = new Service(path.join(root, "Relay"), () => {}, path.join(root, "unused"));
  let now = 1_000_000;
  service.now = () => now;
  const cli = path.join(root, "claude");
  await writeVersionCli(cli, "2.1.290 (Claude Code)");
  service.store.update((s) => {
    s.executable = cli;
  });
  assert.equal((await service.panelSnapshot()).diagnostics.version, "2.1.290 (Claude Code)");
  await writeVersionCli(cli, "2.1.296 (Claude Code)");
  now += Service.REDIAGNOSE_MS;
  assert.equal((await service.panelSnapshot()).diagnostics.version, "2.1.296 (Claude Code)");
});

test("the setup list needs two connected accounts and a choice of when to switch; the extension is optional", () => {
  const ready = desktop({ organizations: [ORG] });
  const settings = { autoSwitchMode: "off" as const, claudeExtension: { mode: "guide" as const } };
  const keys = (s?: ReturnType<typeof setupState>) => s?.steps.map((x) => `${x.key}:${x.met}${x.optional ? "?" : ""}`);
  assert.equal(setupState({ desktop: ready, accounts: [], settings }), undefined);
  const none = setupState({ desktop: ready, diagnostics: diagnostics(), accounts: [], settings });
  assert.deepEqual(keys(none), ["desktop:true", "code:true", "first:false", "second:false", "mode:false", "extension:false?"]);
  assert.equal(none?.ready, false);
  // An account without a saved Claude app sign-in does not count.
  const loose = setupState({ desktop: ready, diagnostics: diagnostics(), accounts: [account("a"), account("b", false)], settings });
  assert.deepEqual(keys(loose)?.slice(2, 4), ["first:true", "second:false"]);
  // Two accounts and a mode: ready, though the extension is still open until skipped.
  const two = [account("a"), account("b")];
  const chosen = setupState({ desktop: ready, diagnostics: diagnostics(), accounts: two, settings: { ...settings, autoSwitchMode: "after-exit" } });
  assert.equal(chosen?.ready, true);
  assert.equal(chosen?.complete, false);
  const skipped = setupState({ desktop: ready, diagnostics: diagnostics(), accounts: two, settings, seen: new Set(["mode", "extension"]) });
  assert.equal(skipped?.complete, true);
  // Continue at quota counts as a choice; off macOS there is no extension step.
  const linux = setupState({ desktop: ready, diagnostics: diagnostics({ platform: "linux" }), accounts: two, settings, quota: true });
  assert.deepEqual(keys(linux)?.at(-1), "mode:true");
  assert.equal(linux?.complete, true);
  // The extension that follows the account is met.
  const follows = setupState({ desktop: ready, diagnostics: diagnostics(), accounts: two, settings: { ...settings, claudeExtension: { mode: "restart" } } });
  assert.deepEqual(keys(follows)?.at(-1), "extension:true?");
});
