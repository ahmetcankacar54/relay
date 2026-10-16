import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/dm-sans/400.css";
import "@fontsource/dm-sans/500.css";
import "@fontsource/dm-sans/600.css";
import "@fontsource/manrope/500.css";
import "@fontsource/manrope/600.css";
import "@fontsource/manrope/700.css";
import "@fontsource/manrope/800.css";
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
      <RelayProvider consumeTraySwitch={false} pollWhenHidden={false}>
        <RelayPrankStage>
          <Panel />
        </RelayPrankStage>
      </RelayProvider>
    </I18nProvider>
  </React.StrictMode>,
);
