import React from "react";
import { createRoot } from "react-dom/client";
import "./styles/fonts.css";
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
