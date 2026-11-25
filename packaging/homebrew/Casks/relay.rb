cask "relay" do
  version "0.28.0"
  sha256 "f78378dfd318607ee8d0dc97bc65c6e9a989537b355e28838078002e556e7860"

  url "https://github.com/ahmetcankacar54/relay/releases/download/v#{version}/Relay-#{version}-arm64.dmg"
  name "Relay"
  desc "Switch Claude, Codex and Antigravity accounts and plan usage windows"
  homepage "https://github.com/ahmetcankacar54/relay"

  livecheck do
    url :url
    strategy :github_latest
  end

  # Relay updates itself from its GitHub releases.
  auto_updates true
  depends_on arch: :arm64
  depends_on macos: :ventura

  app "Relay.app"

  zap trash: [
    "~/Library/Application Support/Relay",
    "~/Library/Caches/dev.relay.workspace",
    "~/Library/Caches/dev.relay.workspace.ShipIt",
    "~/Library/Containers/dev.relay.workspace.widget",
    "~/Library/HTTPStorages/dev.relay.workspace",
    "~/Library/Logs/Relay",
    "~/Library/Preferences/dev.relay.workspace.plist",
    "~/Library/Saved Application State/dev.relay.workspace.savedState",
  ]

  caveats <<~EOS
    Relay is signed with its own certificate and is not notarized by Apple,
    so macOS blocks its first launch once:
      1. Open Relay from Applications. When macOS says it cannot verify
         the app, choose Done.
      2. Open System Settings > Privacy & Security, find
         "Relay was blocked…" and choose Open Anyway, then confirm.
    A newer version may ask again. Permissions you grant Relay are kept,
    because every version is signed with the same certificate.
  EOS
end
