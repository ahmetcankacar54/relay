import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AutoSwitchStatus } from "../src/features/AutoSwitchStatus";
import type { AutoSwitchState } from "../shared/types";

const html = (reason: AutoSwitchState["reason"], language: "tr" | "en") =>
  renderToStaticMarkup(
    createElement(AutoSwitchStatus, {
      value: { status: "blocked", reason },
      accounts: [],
      t: (tr: string, en: string) => (language === "tr" ? tr : en),
    }),
  ).replace(/&#x27;|&#39;/g, "'");

test("the automatic-switch status says that Continue at quota holds the switch", () => {
  assert.match(
    html("continuation-active", "tr"),
    /Kota dolunca devam açık\. Kotası dolan konuşmaları o devam ettirir; bu sırada Claude kapanınca hazırlama beklemede\./,
  );
  assert.match(
    html("continuation-active", "en"),
    /Continue at quota is on\. It continues conversations stopped at quota; preparing on quit waits meanwhile\./,
  );
});

test("the browser sign-in status names what to finish and where", () => {
  assert.match(
    html("browser-sign-in", "tr"),
    /Bir hesabın girişi veya bağlantı yenilemesi sürüyor\. Tarayıcıda açık bir giriş varsa Hesaplar sayfasında tamamla veya iptal et\./,
  );
  assert.match(
    html("browser-sign-in", "en"),
    /An account’s sign-in or connection renewal is in progress\. If a browser sign-in is open, finish or cancel it on the Accounts page\./,
  );
  assert.doesNotMatch(
    html("browser-sign-in", "tr"),
    /Tarayıcı girişi tamamlanmalı/,
  );
});
