import { defineConfig } from "vite";
// Vite's built-in JSX transform avoids an inline React-refresh preamble, keeping the CSP strict in development too.
export default defineConfig({
  base: "./",
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
});
