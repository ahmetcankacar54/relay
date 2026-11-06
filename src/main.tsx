import React from "react";
import { createRoot } from "react-dom/client";
import "./styles/fonts.css";
import App from "./App";
import { ErrorBoundary } from "./app/ErrorBoundary";
import { pauseMotionWithoutAttention } from "./lib/motion";
import "./styles/theme.css";
pauseMotionWithoutAttention();
// The Electron main window on macOS has a vibrant sidebar (electron/main.ts); the browser preview has none.
if (/\bElectron\//.test(navigator.userAgent) && navigator.userAgent.includes("Macintosh"))
  document.documentElement.dataset.vibrancy = "";
const root = createRoot(document.getElementById("root")!);
// Development only: review sheets for the mascot artwork and the lost and found's pins.
const sheet = import.meta.env.DEV
  ? new URLSearchParams(location.search).get("scenario")
  : null;
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
