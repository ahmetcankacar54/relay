import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./app/ErrorBoundary";
import { bootI18n } from "./data/i18n";
import { applyLegacyStorage, inTauri } from "./data/tauri-bridge";
import { api } from "./data/useRelay";
import { pauseMotionWithoutAttention } from "./lib/motion";
import "./styles/theme.css";
pauseMotionWithoutAttention();
// The main window on macOS has a vibrant sidebar (electron/main.ts, crates/relay-app); the
// browser preview has none.
// Phase 6: drop the window.relay fallback
if (
  (/\bElectron\//.test(navigator.userAgent) && navigator.userAgent.includes("Macintosh")) ||
  (inTauri() && navigator.platform.startsWith("Mac"))
)
  document.documentElement.dataset.vibrancy = "";
const root = createRoot(document.getElementById("root")!);
// Development only: review sheets for the mascot artwork and the lost and found's pins.
const sheet = import.meta.env.DEV
  ? new URLSearchParams(location.search).get("scenario")
  : null;
// Under Tauri, Electron's saved window preferences (the language among them) come over first.
const legacy = inTauri()
  ? applyLegacyStorage().catch((error: unknown) => console.error(error))
  : Promise.resolve();
// The language is chosen before the first paint, so nothing shows in the wrong one. A boot that
// fails still renders: a blank window is worse than one in the fallback language.
void legacy.then(() => bootI18n(api)).catch((error: unknown) => console.error(error)).then(() => {
  if (sheet === "mascot")
    void import("./dev/mascot-gallery-entry").then(({ render }) => render(root));
  else if (sheet === "pins")
    void import("./dev/pin-gallery-entry").then(({ render }) => render(root));
  else
    root.render(
      <React.StrictMode>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </React.StrictMode>,
    );
});
