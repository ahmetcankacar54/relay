# Homebrew tap

Relay is not notarized by Apple, so the official `homebrew/cask` repository does
not take it. It is installed from its own tap instead:

```sh
brew install --cask ahmetcankacar54/tap/relay
```

`Casks/relay.rb` is the cask for the tap repository
[`ahmetcankacar54/homebrew-tap`](https://github.com/ahmetcankacar54/homebrew-tap).
It is rendered by `scripts/homebrew-cask.mjs` from a release's `SHA256SUMS.txt`,
never edited by hand:

```sh
gh release download v0.29.0 --pattern SHA256SUMS.txt
node scripts/homebrew-cask.mjs 0.29.0 SHA256SUMS.txt --output packaging/homebrew/Casks/relay.rb
```

`npm run release` writes the same file to `release/homebrew/Casks/relay.rb`.
The cask has an Intel URL once the release has `Relay-<version>-x64.dmg`;
before that it is for Apple silicon only.

## Publishing a version

1. After the release is published, copy `Casks/relay.rb` into the tap repository
   at `Casks/relay.rb`, commit and push.
2. Check it: `brew update && brew audit --cask --online ahmetcankacar54/tap/relay`
   and `brew install --cask ahmetcankacar54/tap/relay` on a Mac without Relay.

Relay updates itself, so the cask sets `auto_updates true` and
`brew upgrade` leaves a running copy alone.

## Gatekeeper

The cask keeps macOS's quarantine on the download: it never runs `xattr` or a
`postflight` that removes it. Its `caveats` explain the one-time step instead:
open Relay, choose **Done**, then System Settings → Privacy & Security →
**Open Anyway**. A paid Developer ID certificate and notarization would remove
the step and allow the official cask repository.
