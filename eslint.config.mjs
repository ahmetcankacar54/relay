// ESLint flat config: `npm run lint`, which CI runs on every push.
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    // What .gitignore keeps out: builds, local worktrees and audits, tool caches, Playwright output.
    ignores: [
      "node_modules/",
      "dist/",
      "dist-electron/",
      "release/",
      "output/",
      "cli/npm/dist/",
      // rust-anything's generated bindings and recorders for the parity crates.
      "rust/",
      "target/",
      "docs/audit-*/",
      ".claude/",
      ".superpowers/",
      ".relay-dev/",
      ".playwright-cli/",
      ".playwright-mcp/",
      "e2e/test-results/",
      "e2e/report/",
    ],
  },
  js.configs.recommended,
  // Syntax-only rules: the type-aware set would type-check the whole tree a second time per run,
  // and `npm run typecheck` already runs strict.
  tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.browser, ...globals.node },
    },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      // A leading underscore marks a name kept on purpose; a rest sibling drops fields from a copy.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      // Best-effort cleanup swallows errors on purpose; an empty catch says so.
      "no-empty": ["error", { allowEmptyCatch: true }],
      // Terminal output, cookie values and file names are scrubbed of control characters on purpose.
      "no-control-regex": "off",
      // The `any`s sit at untyped edges (CDP, LevelDB, JSON from other apps); typing them is its own job.
      "@typescript-eslint/no-explicit-any": "warn",
      // Attaching `cause` changes what the logs print; worth doing, one call site at a time.
      "preserve-caught-error": "warn",
      // Regexes match formatted output, where no-break and thin spaces are the point.
      "no-irregular-whitespace": ["error", { skipRegExps: true }],
      // A closure that reads the variable before its one assignment cannot take a const.
      "prefer-const": ["error", { ignoreReadBeforeAssign: true }],
    },
  },
  {
    // React code only: main-process helpers name callbacks `use` without being hooks.
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      // The two classic hook rules only: the React Compiler rules in the plugin's recommended set
      // flag patterns the app uses on purpose and would need a sweeping rewrite.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    files: ["tests/**", "e2e/**"],
    rules: {
      // Fakes stand in for a slice of a large interface; `any` is how they say so.
      "@typescript-eslint/no-explicit-any": "off",
      // Patterns match source text and terminal output, indentation included.
      "no-regex-spaces": "off",
    },
  },
  {
    // The npm launcher is CommonJS (cli/package.json has no "type") so that any Node can run it.
    files: ["**/*.cjs", "cli/launcher.js"],
    languageOptions: { sourceType: "commonjs" },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
);
