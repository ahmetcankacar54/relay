import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const helpers = ["desktop-automation"];
/** The widget extension's bundle in dist-electron; electron-builder copies it to Contents/PlugIns. */
export const WIDGET_APPEX = "RelayWidget.appex";

function widgetPlist(version) {
  // The extension point is all chronod needs; versions follow Relay's.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.relay.workspace.widget</string>
<key>CFBundleName</key><string>RelayWidget</string>
<key>CFBundleDisplayName</key><string>Relay</string>
<key>CFBundleExecutable</key><string>RelayWidget</string>
<key>CFBundlePackageType</key><string>XPC!</string>
<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${version}</string>
<key>CFBundleSupportedPlatforms</key><array><string>MacOSX</string></array>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSExtension</key><dict><key>NSExtensionPointIdentifier</key><string>com.apple.widgetkit-extension</string></dict>
</dict></plist>
`;
}

function helperPlist(name) {
  // The helper version is independent of Relay's marketing version. Changing it
  // with every UI release would invalidate an otherwise unchanged native binary.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.relay.workspace.${name}</string>
<key>CFBundleName</key><string>Relay ${name}</string>
<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
<key>CFBundleVersion</key><string>1</string>
</dict></plist>
`;
}

async function toolIdentity(file) {
  const resolved = await fs.realpath(file);
  const stat = await fs.stat(resolved);
  return { path: resolved, size: stat.size, modifiedAt: stat.mtimeMs };
}

/**
 * Keep byte-identical native code for unchanged source/toolchain inputs. A fresh
 * Swift link can generate a new Mach-O UUID, changing an ad-hoc Keychain identity
 * even when only Relay's JavaScript changed. This does not modify Keychain ACLs,
 * TCC consent or code-signing requirements. The final app is signed by the normal
 * electron-builder pipeline; updated native code still needs a stable certificate
 * identity to retain trust across versions.
 */
export async function buildNativeHelpers() {
  if (process.platform !== "darwin") return [];
  const outDir = path.resolve("dist-electron");
  // Keep compiler module/cache files out of the packaged dist-electron glob.
  const cacheDir = path.resolve("output/.native-build");
  await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const swift = execFileSync("/usr/bin/xcrun", ["--find", "swiftc"], {
    encoding: "utf8",
  }).trim();
  const linker = execFileSync("/usr/bin/xcrun", ["--find", "ld"], {
    encoding: "utf8",
  }).trim();
  const sdk = await fs.realpath(
    execFileSync("/usr/bin/xcrun", ["--show-sdk-path"], {
      encoding: "utf8",
    }).trim(),
  );
  const lipo = execFileSync("/usr/bin/xcrun", ["--find", "lipo"], {
    encoding: "utf8",
  }).trim();
  // One universal helper serves Apple silicon and Intel builds (and a universal
  // app) alike, whichever Mac runs the build.
  const targets = ["arm64", "x86_64"].map((arch) => `${arch}-apple-macosx13.0`);
  const toolchain = {
    swift: await toolIdentity(swift),
    linker: await toolIdentity(linker),
    lipo: await toolIdentity(lipo),
    version: execFileSync(swift, ["--version"], { encoding: "utf8" }),
    sdk,
    sdkSettings: sha256(await fs.readFile(path.join(sdk, "SDKSettings.json"))),
    targets,
  };
  const { version } = JSON.parse(await fs.readFile("package.json", "utf8"));
  const appex = path.join(outDir, WIDGET_APPEX);
  const products = [
    ...helpers.map((name) => {
      const plistFile = path.join(cacheDir, `${name}.plist`);
      return {
        name,
        source: path.resolve("electron/native", `${name}.swift`),
        output: path.join(outDir, name),
        plist: helperPlist(name),
        plistFile,
        targets,
        args: [
          "-Xlinker",
          "-sectcreate",
          "-Xlinker",
          "__TEXT",
          "-Xlinker",
          "__info_plist",
          "-Xlinker",
          plistFile,
        ],
      };
    }),
    {
      // Desktop widgets and containerBackground need macOS 14; on 13 Relay has no widget.
      name: "widget",
      source: path.resolve("electron/native/widget/RelayWidget.swift"),
      output: path.join(appex, "Contents/MacOS/RelayWidget"),
      plist: widgetPlist(version),
      plistFile: path.join(appex, "Contents/Info.plist"),
      targets: ["arm64", "x86_64"].map((arch) => `${arch}-apple-macosx14.0`),
      // Without _NSExtensionMain chronod starts the extension and it exits at once.
      args: [
        "-parse-as-library",
        "-application-extension",
        "-Xlinker",
        "-e",
        "-Xlinker",
        "_NSExtensionMain",
      ],
    },
    {
      name: "widget-center",
      source: path.resolve("electron/native/widget-center.swift"),
      header: path.resolve("electron/native/node_api_subset.h"),
      output: path.join(outDir, "widget-center.node"),
      targets,
      // A Node-API addon: napi_* resolve from the Electron process that loads it.
      args: [
        "-emit-library",
        "-import-objc-header",
        path.resolve("electron/native/node_api_subset.h"),
        "-Xlinker",
        "-undefined",
        "-Xlinker",
        "dynamic_lookup",
      ],
    },
  ];
  const results = [];
  for (const product of products) {
    const { name, source, output, plist, plistFile } = product;
    const recordFile = path.join(cacheDir, `${name}.json`);
    const args = [
      source,
      "-O",
      "-sdk",
      sdk,
      "-module-name",
      `Relay_${name.replaceAll("-", "_")}`,
      "-module-cache-path",
      path.join(cacheDir, "module-cache"),
      ...product.args,
    ];
    if (plistFile) {
      await fs.mkdir(path.dirname(plistFile), { recursive: true });
      // The appex's Info.plist sits beside its binary, so it is written on every build.
      if (plistFile.startsWith(outDir))
        await fs.writeFile(plistFile, plist, { mode: 0o644 });
    }
    await fs.mkdir(path.dirname(output), { recursive: true });
    const sourceHash = sha256(
      Buffer.concat([
        await fs.readFile(source),
        ...(product.header ? [await fs.readFile(product.header)] : []),
      ]),
    );
    const inputHash = sha256(
      JSON.stringify({
        pipelineVersion: 3,
        source: sourceHash,
        plist,
        toolchain,
        targets: product.targets,
        args,
      }),
    );
    let reusable = false;
    try {
      const recordStat = await fs.lstat(recordFile);
      const outputStat = await fs.lstat(output);
      if (
        recordStat.isFile() &&
        outputStat.isFile() &&
        (outputStat.mode & 0o111) !== 0
      ) {
        const record = JSON.parse(await fs.readFile(recordFile, "utf8"));
        reusable =
          record.inputHash === inputHash &&
          record.outputHash === sha256(await fs.readFile(output));
      }
    } catch {
      // Missing, changed or incomplete cache entries get a fresh native build.
    }
    if (reusable) {
      console.log(`Native helper unchanged: ${name}`);
      results.push({ name, reused: true });
      continue;
    }
    // Neither an interrupted build nor a replacement can poison the next reuse.
    const temporary = path.join(cacheDir, `${name}-${randomUUID()}`);
    const temporaryRecord = `${recordFile}-${randomUUID()}`;
    const slices = product.targets.map((target) => `${temporary}-${target}`);
    try {
      if (plistFile && !plistFile.startsWith(outDir))
        await fs.writeFile(plistFile, plist, { mode: 0o600 });
      for (const [index, target] of product.targets.entries())
        execFileSync(swift, [...args, "-target", target, "-o", slices[index]], {
          stdio: "inherit",
        });
      execFileSync(lipo, ["-create", ...slices, "-output", temporary], {
        stdio: "inherit",
      });
      if (
        sha256(
          Buffer.concat([
            await fs.readFile(source),
            ...(product.header ? [await fs.readFile(product.header)] : []),
          ]),
        ) !== sourceHash
      )
        throw new Error(`Native source changed during compilation: ${name}`);
      // Standard local signing also binds the embedded plist in development.
      // The linker signature otherwise uses the temporary output's filename.
      // electron-builder replaces this with the final app's signing identity.
      execFileSync(
        "/usr/bin/codesign",
        [
          "--force",
          "--sign",
          "-",
          "--identifier",
          `dev.relay.workspace.${name}`,
          temporary,
        ],
        { stdio: "inherit" },
      );
      const outputHash = sha256(await fs.readFile(temporary));
      await fs.rename(temporary, output);
      await fs.writeFile(
        temporaryRecord,
        `${JSON.stringify({ inputHash, outputHash }, null, 2)}\n`,
        { mode: 0o600, flag: "wx" },
      );
      await fs.rename(temporaryRecord, recordFile);
      console.log(`Native helper built: ${name}`);
      results.push({ name, reused: false });
    } finally {
      for (const file of [temporary, temporaryRecord, ...slices])
        await fs.rm(file, { force: true });
    }
  }
  return results;
}
