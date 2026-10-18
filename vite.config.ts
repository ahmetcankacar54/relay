import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { contentSecurityPolicyPlugin } from "./scripts/csp";
// Vite's built-in JSX transform avoids an inline React-refresh preamble, keeping the CSP strict in development too.
export default defineConfig({
  base: "./",
  // The built app's CSP has no dev-server socket (scripts/csp.ts).
  plugins: [tailwindcss(), contentSecurityPolicyPlugin()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        panel: fileURLToPath(new URL("./panel.html", import.meta.url)),
        switch: fileURLToPath(new URL("./switch.html", import.meta.url)),
      },
    },
  },
});
