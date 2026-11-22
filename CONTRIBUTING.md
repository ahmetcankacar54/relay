# Contributing to Relay

Thanks for helping. Bug reports, translations and pull requests are all welcome.

## Reporting a problem

- **Security problems:** report them privately, as [SECURITY.md](SECURITY.md) explains. Never in a public issue.
- **Bugs:** open an issue with the **Bug report** form. Include the Relay version, your operating system and what you expected. Logs and screenshots help, but check them for email addresses and account names first.
- **Ideas:** open an issue with the **Feature request** form and describe the problem before the solution.

## Before you start

- Read [Terms & risk](README.md#terms--risk). Changes that move Relay further from ordinary use of Claude sign-ins (new ways to route, share or pool accounts) need a discussion in an issue first.
- A real switch quits the Claude app and stops every conversation running in it. Try your change in the browser preview first (`npm run dev:ui`), and test a real switch only on a machine where that is fine.

## Development

Requirements: Node.js 22.12+, and on macOS the Xcode Command Line Tools.

```sh
npm ci
npm run dev:ui     # browser preview with sample accounts
npm run dev        # the full Electron app
```

How switching, history merging and usage reading work is in [docs/development.md](docs/development.md).

## Pull requests

1. Branch from `main`, and keep one change per pull request.
2. Run what CI runs, on your machine:
   ```sh
   npm run typecheck
   npm test
   npm run build
   ```
   CI runs these on macOS, Windows and Linux; a test that needs macOS or POSIX file modes should be skipped elsewhere, not fail.
3. Add or update tests for what you change.
4. Write the commit message as what changed for the user, after a type: `fix: a dropped sign-in is found before a switch`, `feat: …`, `docs: …`, `test: …`.
5. Use made-up names in tests and fixtures (`example.com`, "Vertex", "Alto"). No real company names, email addresses, account IDs or local paths.

## Translations

- Every string in the app lives in [`shared/i18n/catalogs`](shared/i18n/catalogs). English (`en.ts`) is the source; every other catalog has exactly its ids, and a test checks that.
- Copy follows [docs/ux/glossary.md](docs/ux/glossary.md): short, plain sentences that say what happened and what to do.
- The English README is the source of the translated READMEs. When you change it, update the translations or say in the pull request that they need it; a test checks that their headings, images, links and in-page anchors still match.

## License

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).
