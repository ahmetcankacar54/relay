import test from "node:test";
import assert from "node:assert/strict";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RelayContext, type Relay } from "../src/data/relay-context";
import { I18nContext } from "../src/data/i18n";
import { SidebarUpdate } from "../src/app/SidebarUpdate";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { PanelUpdate } from "../src/panel/PanelUpdate";
import { UpdatesGroup } from "../src/pages/Settings";
import { updateHint, updateShown } from "../src/lib/update-text";
import { DEFAULT_SETTINGS, type Snapshot, type UpdateState } from "../shared/types";

const base: UpdateState = { status: "ready", current: "0.15.0", autoCheck: true, version: "0.16.0" };

function relayFor(update: UpdateState | undefined, extra: Partial<Relay> = {}): Relay {
  return {
    api: {},
    busy: "",
    desktop: { available: true, running: true, organizations: [], busy: false, recoveryRequired: false, errorRevision: 0 },
    data: { settings: DEFAULT_SETTINGS, usage: {}, accounts: [], authFlows: [], update } as unknown as Snapshot,
    action: async () => {},
    ...extra,
  } as unknown as Relay;
}
const render = (relay: Relay, el: ReactElement, language: "tr" | "en" = "tr") =>
  renderToStaticMarkup(
    createElement(
      I18nContext.Provider,
      { value: { language, setLanguage() {}, t: (tr: string, en: string) => (language === "tr" ? tr : en) } },
      createElement(RelayContext.Provider, { value: relay }, el),
    ),
  );

test("the sidebar card is one Update row with the version in its name, and Later on hover", () => {
  const tr = render(relayFor(base), createElement(SidebarUpdate));
  assert.match(tr, /data-slot="update-card"/);
  assert.match(tr, /<button[^>]*aria-label="Relay 0\.16\.0 hazır\.[^"]*"[^>]*>[\s\S]*?<span class="truncate">Güncelle<\/span>/);
  assert.doesNotMatch(tr, />v?0\.16\.0</);
  assert.match(tr, /aria-label="Sonra hatırlat"/);
  assert.match(tr, /Güncelle’ye basınca Relay kapanır, yeni sürüm birkaç saniyede açılır\./);
  const en = render(relayFor(base), createElement(SidebarUpdate), "en");
  assert.match(en, /Relay 0\.16\.0 is ready\./);
  assert.match(en, /<span class="truncate">Update<\/span>/);
  // While the Claude app is busy, Update waits.
  const busy = render(
    relayFor(base, { desktop: { available: true, running: true, organizations: [], busy: true, recoveryRequired: false, errorRevision: 0 } } as Partial<Relay>),
    createElement(SidebarUpdate),
  );
  assert.match(busy, /<button[^>]*disabled=""[^>]*>[\s\S]*?Güncelle<\/span>/);
  // The rail shows the icon alone, with the update as its name.
  const rail = render(relayFor(base), createElement(TooltipProvider, null, createElement(SidebarUpdate, { compact: true })));
  assert.match(rail, /<button[^>]*data-slot="update-card"[^>]*aria-label="Relay 0\.16\.0 hazır\./);
  assert.doesNotMatch(rail, />Güncelle</);
});

test("downloading, installing and by-hand updates read as such; nothing shows when up to date", () => {
  assert.match(render(relayFor({ ...base, status: "downloading", progress: 0.42 }), createElement(TooltipProvider, null, createElement(SidebarUpdate))), /data-slot="update-progress" role="progressbar"[^>]*aria-valuenow="42"/);
  const installing = render(relayFor({ ...base, status: "installing" }), createElement(TooltipProvider, null, createElement(SidebarUpdate)));
  assert.match(installing, /birazdan yeniden açılır/);
  assert.doesNotMatch(installing, /Sonra hatırlat/);
  const manual = render(relayFor({ ...base, status: "manual", manualReason: "location" }), createElement(SidebarUpdate));
  assert.match(manual, /Relay 0\.16\.0 çıktı\./);
  assert.match(manual, /Önce Uygulamalar klasörüne taşı/);
  assert.match(manual, />Güncellemeyi indir</);
  assert.doesNotMatch(manual, />Güncelle</);
  for (const status of ["up-to-date", "checking", "available", "error", "idle"] as const)
    assert.equal(render(relayFor({ ...base, status }), createElement(SidebarUpdate)), "", status);
  assert.equal(render(relayFor(undefined), createElement(SidebarUpdate)), "");
  assert.equal(updateShown({ ...base, version: undefined }), false);
  for (const reason of ["no-asset", "not-writable", "not-appimage"] as const)
    assert.ok(updateHint({ ...base, status: "manual", manualReason: reason }, (tr) => tr).length > 10, reason);
});

test("the panel shows one row: Update when ready, Download by hand", () => {
  const ready = render(relayFor(base), createElement(PanelUpdate));
  assert.match(ready, /Relay 0\.16\.0 hazır\./);
  assert.match(ready, />Güncelle</);
  const manual = render(relayFor({ ...base, status: "manual", manualReason: "no-asset" }), createElement(PanelUpdate));
  assert.match(manual, />İndir</);
  assert.equal(render(relayFor({ ...base, status: "up-to-date" }), createElement(PanelUpdate)), "");
});

test("Settings shows the version, the last check and the automatic switch; only where Relay updates itself", () => {
  const t = (tr: string) => tr;
  const group = (update: UpdateState | undefined) =>
    render(
      relayFor(update),
      createElement(UpdatesGroup, {
        api: {} as Relay["api"],
        action: async () => {},
        data: { update } as unknown as Snapshot,
        busy: "",
        t,
        language: "tr",
      }),
    );
  const html = group({ ...base, status: "up-to-date", checkedAt: "2026-11-05T09:00:00.000Z" });
  assert.match(html, /Güncellemeler/);
  assert.match(html, /Relay 0\.15\.0/);
  assert.match(html, /Relay güncel\./);
  assert.match(html, /Son kontrol: /);
  assert.match(html, />Şimdi kontrol et</);
  assert.match(html, /id="update-auto"[^>]*aria-checked="true"|aria-checked="true"[^>]*id="update-auto"/);
  assert.match(group({ ...base, status: "error", error: "The update is too large." }), /Kontrol edilemedi: Güncelleme çok büyük\./);
  assert.equal(group(undefined), "");
});
