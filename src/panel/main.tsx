import React from "react";
import { createRoot } from "react-dom/client";
import "../styles/fonts.css";
import { I18nProvider } from "../data/i18n";
import { api, RelayProvider } from "../data/useRelay";
import { RelayPrankStage } from "../pranks/RelayPrankStage";
import { Panel } from "./Panel";
import "../styles/theme.css";

// The panel window is transparent so macOS vibrancy shows through.
document.body.style.background = "transparent";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <I18nProvider api={api}>
      <RelayProvider pollWhenHidden={false}>
        <RelayPrankStage>
          <Panel />
        </RelayPrankStage>
      </RelayProvider>
    </I18nProvider>
  </React.StrictMode>,
);
