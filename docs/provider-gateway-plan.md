# Relay provider gateway: implementation and next stages

## Current contract

Relay serves a local, client-key-protected gateway at `/v1/messages`, `/v1/responses`, and `/v1/chat/completions`. Claude accounts use Relay's existing isolated Claude Code credentials. Codex accounts use the Codex CLI's ChatGPT sign-in or an OpenAI API key that OpenAI accepted when the account was added. Antigravity accounts use **Google OAuth through CLIProxyAPI**, with no Gemini API key field.

A request always stays on its own provider. When the chosen account answers 401, 403, 429, 503 or 529, the gateway holds that answer back and sends the same request to the next account of that provider. It does this before anything reaches the client and tries up to three accounts. A limited account waits until its window resets: the reset time comes from Anthropic's `anthropic-ratelimit-unified-*` headers, otherwise from `Retry-After`. Strategy, session time and the client key change on a running gateway without a restart; only a new host or port restarts it.

The client key may arrive as `Authorization: Bearer`, `x-relay-key` or `x-api-key`. It is compared in constant time and never forwarded upstream, and neither is `x-relay-provider`. `/health` only says the gateway is up; `/status` needs the key. A gateway bound to loopback refuses any `Host` header that is not a loopback name, which blocks DNS rebinding. Request bodies are capped at 32 MB, and at most 32 requests are answered at once. `relay proxy start` uses the app's client key, or makes one for the run.

Antigravity is a distinct subscription channel. A Gemini API key calls the public Gemini API and does not grant access to an Antigravity subscription. Relay therefore routes an Antigravity account to a separate local CLIProxyAPI process. Each account has its own OAuth directory, process, local client key, and management key. The process does OAuth exchange, refresh, project discovery, request conversion, and streaming responses. Relay keeps control of account selection and client authentication.

The helper is [CLIProxyAPI v8.0.61](https://github.com/router-for-me/CLIProxyAPI/releases/tag/v8.0.61), distributed under the MIT license. Relay downloads a pinned platform archive on the first Antigravity sign-in and verifies its published SHA-256 checksum before extracting it. Supported archives are macOS, Linux, and Windows on x64 and arm64. The helper listens on `127.0.0.1`; its management API is never exposed on the LAN. OAuth files and configuration stay in Relay's account profile with restricted permissions. A first sign-in requires network access to GitHub and Google.

| Client request | Relay account | Upstream | Current status |
| --- | --- | --- | --- |
| Anthropic Messages | Claude | Anthropic | Existing path |
| OpenAI Responses | Codex ChatGPT sign-in | ChatGPT Codex | The Codex CLI's current token is used while it is signed in to the same ChatGPT account. Otherwise Relay uses the copy saved when the account was added, until it expires. The refresh token is never copied. |
| OpenAI Responses or Chat Completions with an OpenAI API key | Codex | Public OpenAI API | Routed to the correct API |
| Messages, Responses, or Chat Completions with `x-relay-provider: antigravity` or a Gemini model | Antigravity OAuth | Account's CLIProxyAPI process | Implemented; requires a completed Google sign-in |
| Model list with `x-relay-provider: antigravity` | Antigravity OAuth | Account's CLIProxyAPI process | Implemented |
| Cross-provider fallback | Any | — | Not offered. The unfinished translator was removed. A request with no account of its provider gets a 503. |

The local `relay-sec-…` key in client setup snippets authenticates a client to Relay. It is **not** a Google or OpenAI provider key.

## Correctness and release gates

1. A provider account must not be marked connected without a real credential. OAuth is complete only after CLIProxyAPI reports success and Relay validates the saved Antigravity credential file. An OpenAI API key is checked with OpenAI before it is saved. A Codex sign-in is imported only while its access token has not expired, and its expiry comes from the access token, not the id token. A Claude account is signed in through the Claude app capture, never by copying the Claude Code CLI's tokens. A Claude account's provider cannot be changed after it is added.
2. Unknown quota is displayed as unknown. Codex and Antigravity must not be given invented zero-percent usage windows. The soonest-reset strategy only has real reset information for providers with a working quota reader.
3. A request must stay on its selected provider's protocol and upstream. Incompatible cross-provider routing fails explicitly until translation is available.
4. Test the OAuth lifecycle with a local test sidecar, and separately smoke-test the pinned binary download and management API. A live model request requires an authorized Google account and is a separate release gate.
5. Verify `npm run typecheck`, `npm test`, `npm run build`, desktop smoke, and the packaged app. The release must include the new frontend route and the runtime helper installer, and the update artifacts must be present before publishing.

## Next stages

1. **Provider quota adapters:** read real Antigravity model windows and Codex limits, including resets and cooldowns. Keep unknown values distinct from zero. Feed these into account health, pool cards, and routing.
2. **Codex OAuth lifecycle:** use the same managed helper for new Codex sign-ins and refresh. Today a ChatGPT sign-in stays fresh only while the Codex CLI on this Mac is signed in to the same ChatGPT account. The `chatgpt-account-id` header is sent with each request, but it still needs one live request against the real backend.
3. **Protocol coverage:** add tested request and response translation for tool calls, structured output, streaming, errors, and usage before enabling cross-provider fallback. Maintain session affinity when a conversation can safely stay on one account.
4. **Operational reliability:** surface helper download and startup state, restart a crashed helper once, and detect callback port conflicts. A pending Antigravity sign-in can already be cancelled, and a double click cannot start two. Not done yet: CLIProxyAPI may save a sign-in without `project_id` when project discovery fails, and Relay then rejects it. This needs a check against the real binary. The WebSocket path has no retry on another account and no limit cooldown.
5. **Cross-platform releases:** exercise the pinned helper archive and OAuth callback on each supported OS and architecture; verify code signing and update behavior on macOS, Windows, and Linux.

The user-visible Antigravity flow currently depends on the third-party helper's OAuth client and upstream behavior. Changes to its protocol require a reviewed version pin and new checksums before a Relay update.

## Registry compatibility

0.18.0 and 0.18.1 saved the gateway settings, a removed browser live-switch setting and an account's provider under registry schema 6. A 0.17 build cannot read a file like that. The registry is now schema 7. Builds up to 0.17 then read it read-only through their newer-schema path and never write it back. On first open, the live-switch setting and the cross-provider flag are dropped.
