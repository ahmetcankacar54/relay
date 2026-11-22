import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { SwitchSceneView } from "../../shared/switch-scene";
import { ErrorBoundary } from "../app/ErrorBoundary";
import { adoptLocale } from "../data/i18n";
import { SwitchStage } from "./SwitchStage";
import "../styles/theme.css";

// The window is transparent; the stage draws its own card.
document.body.style.background = "transparent";
// A small card: the compact type ramp (src/styles/theme.css).
document.documentElement.dataset.density = "compact";

function SwitchWindow() {
  const [view, setView] = useState<SwitchSceneView>();
  useEffect(() => {
    const api = window.relaySwitch;
    if (!api) return;
    const off = api.onScene((next) => {
      // The error screen speaks the language main draws the scene in.
      void adoptLocale(next.locale);
      setView(next);
    });
    api.ready();
    return off;
  }, []);
  return view ? <SwitchStage view={view} /> : null;
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <SwitchWindow />
    </ErrorBoundary>
  </React.StrictMode>,
);
