import React from "react";
import { createRoot } from "react-dom/client";
import "../styles/fonts.css";
import { ErrorBoundary } from "../app/ErrorBoundary";
import { I18nProvider } from "../data/i18n";
import { api, RelayProvider } from "../data/useRelay";
import { setMotionPaused } from "../lib/motion";
import { RelayPrankStage } from "../pranks/RelayPrankStage";
import { Panel } from "./Panel";
import "../styles/theme.css";

// The panel window is transparent so macOS vibrancy shows through.
document.body.style.background = "transparent";
// A 360 px column: the compact type ramp (src/styles/theme.css).
document.documentElement.dataset.density = "compact";
// The document never scrolls; the panel scrolls inside itself (Panel.tsx), so no scrollbar
// appears and none can take width from the 360 px column.
document.documentElement.style.overflow = "hidden";
document.body.style.overflow = "hidden";
// Created hidden, the panel would paint the panda's motion until it is first shown; it moves
// only while the panel is on screen.
setMotionPaused(true);
api.onPanelVisibility((shown) => setMotionPaused(!shown));

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <I18nProvider api={api}>
        <RelayProvider pollWhenHidden={false} reportsVisibility>
          <RelayPrankStage>
            <Panel />
          </RelayPrankStage>
        </RelayProvider>
      </I18nProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
