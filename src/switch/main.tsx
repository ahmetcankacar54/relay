import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/dm-sans/400.css";
import "@fontsource/dm-sans/600.css";
import type { SwitchSceneView } from "../../shared/switch-scene";
import { SwitchStage } from "./SwitchStage";
import "../styles/theme.css";

// The window is transparent; the stage draws its own card.
document.body.style.background = "transparent";

function SwitchWindow() {
  const [view, setView] = useState<SwitchSceneView>();
  useEffect(() => {
    const api = window.relaySwitch;
    if (!api) return;
    const off = api.onScene(setView);
    api.ready();
    return off;
  }, []);
  return view ? <SwitchStage view={view} /> : null;
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SwitchWindow />
  </React.StrictMode>,
);
