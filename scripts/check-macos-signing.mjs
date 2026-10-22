import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";

// Read-only validation of the final packaged artifact, never the source binaries.
// It does not launch Relay/helpers, request permissions or inspect the TCC store.
if (process.platform !== "darwin")
  throw new Error("macOS is required to validate a macOS code signature.");
if (!process.argv[2])
  throw new Error(
    "Usage: npm run check:mac-signing -- /absolute/path/Relay.app",
  );
const bundle = path.resolve(process.argv[2]);
const contents = path.join(bundle, "Contents");
const identifier = execFileSync(
  "/usr/bin/plutil",
  [
    "-extract",
    "CFBundleIdentifier",
    "raw",
    "-o",
    "-",
    path.join(contents, "Info.plist"),
  ],
  { encoding: "utf8" },
).trim();
if (identifier !== "dev.relay.workspace")
  throw new Error(`Unexpected app bundle identifier: ${identifier}`);

// Capturing stdout and stderr avoids relying on codesign's display stream.
function details(file) {
  const result = spawnSync("/usr/bin/codesign", ["-dvvv", file], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0)
    throw new Error(`Cannot inspect code signature: ${file}`, {
      cause: result.error,
    });
  return `${result.stdout}\n${result.stderr}`;
}

execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle], {
  stdio: ["ignore", "pipe", "pipe"],
});
const appSignature = details(bundle);
if (!appSignature.includes(`Identifier=${identifier}\n`))
  throw new Error(
    "The executable signing identity does not match Relay's bundle ID.",
  );
if (
  appSignature.includes("Info.plist=not bound") ||
  appSignature.includes("Sealed Resources=none")
)
  throw new Error(
    "The app signature does not bind Info.plist and bundled resources.",
  );

const helpers = ["desktop-automation"].map((name) => {
  const file = path.join(
    contents,
    "Resources/app.asar.unpacked/dist-electron",
    name,
  );
  execFileSync("/usr/bin/codesign", ["--verify", "--strict", file], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const signature = details(file);
  const helperIdentifier = signature.match(/^Identifier=(.+)$/m)?.[1];
  if (
    helperIdentifier !== `dev.relay.workspace.${name}` ||
    signature.includes("linker-signed") ||
    signature.includes("Info.plist=not bound")
  )
    throw new Error(
      `The packaged ${name} lacks its bound, stable helper identity.`,
    );
  return {
    name,
    identifier: helperIdentifier,
    cdHash: signature.match(/^CDHash=(.+)$/m)?.[1],
  };
});
// The widget: its own identity and exactly its sandbox entitlements.
const widgetFile = path.join(contents, "PlugIns/RelayWidget.appex");
execFileSync("/usr/bin/codesign", ["--verify", "--strict", widgetFile], {
  stdio: ["ignore", "pipe", "pipe"],
});
const widgetSignature = details(widgetFile);
if (!widgetSignature.includes("Identifier=dev.relay.workspace.widget\n"))
  throw new Error("The packaged widget lacks its stable identity.");
const widgetEntitlements = execFileSync(
  "/usr/bin/codesign",
  ["--display", "--entitlements", "-", "--xml", widgetFile],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
);
const widgetKeys = [...widgetEntitlements.matchAll(/<key>([^<]+)<\/key>/g)]
  .map((m) => m[1])
  .sort();
if (
  JSON.stringify(widgetKeys) !==
  JSON.stringify([
    "com.apple.security.app-sandbox",
    "com.apple.security.temporary-exception.files.home-relative-path.read-only",
  ])
)
  throw new Error("The packaged widget has other entitlements than its sandbox.");
const widget = {
  identifier: "dev.relay.workspace.widget",
  entitlements: widgetKeys,
  cdHash: widgetSignature.match(/^CDHash=(.+)$/m)?.[1],
};
const adHoc = appSignature.includes("Signature=adhoc");
process.stdout.write(
  `${JSON.stringify(
    {
      bundle,
      identifier,
      verified: true,
      helpers,
      widget,
      signing: adHoc ? "local-ad-hoc" : "certificate",
      ...(adHoc
        ? {
            permissionNote:
              "Local ad-hoc builds may require Accessibility consent again after rebuilds. Use a stable Apple Development or Developer ID identity for update continuity.",
          }
        : {}),
    },
    null,
    2,
  )}\n`,
);
