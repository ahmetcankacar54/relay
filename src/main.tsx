import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/dm-sans/400.css";
import "@fontsource/dm-sans/500.css";
import "@fontsource/dm-sans/600.css";
import "@fontsource/manrope/500.css";
import "@fontsource/manrope/600.css";
import "@fontsource/manrope/700.css";
import "@fontsource/manrope/800.css";
import App from "./App";
import "./styles/theme.css";
const root = createRoot(document.getElementById("root")!);
// Development only: a review sheet for the mascot artwork.
if (
  import.meta.env.DEV &&
  new URLSearchParams(location.search).get("scenario") === "mascot"
)
  void import("./dev/mascot-gallery-entry").then(({ render }) => render(root));
else
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
