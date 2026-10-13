import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const helpers = ["usage-keychain", "desktop-automation"];

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
  const targetArch = process.arch === "arm64" ? "arm64" : "x86_64";
  const target = `${targetArch}-apple-macosx13.0`;
  const toolchain = {
    swift: await toolIdentity(swift),
    linker: await toolIdentity(linker),
    version: execFileSync(swift, ["--version"], { encoding: "utf8" }),
    sdk,
    sdkSettings: sha256(await fs.readFile(path.join(sdk, "SDKSettings.json"))),
    target,
  };
  const results = [];
  for (const name of helpers) {
    const source = path.resolve("electron/native", `${name}.swift`);
    const output = path.join(outDir, name);
    const plist = helperPlist(name);
    const plistFile = path.join(cacheDir, `${name}.plist`);
    const recordFile = path.join(cacheDir, `${name}.json`);
    const args = [
      source,
      "-O",
      "-target",
      target,
      "-sdk",
      sdk,
      "-module-name",
      `Relay_${name.replaceAll("-", "_")}`,
      "-module-cache-path",
      path.join(cacheDir, "module-cache"),
      "-Xlinker",
      "-sectcreate",
      "-Xlinker",
      "__TEXT",
      "-Xlinker",
      "__info_plist",
      "-Xlinker",
      plistFile,
    ];
    const sourceHash = sha256(await fs.readFile(source));
    const inputHash = sha256(
      JSON.stringify({
        pipelineVersion: 2,
        source: sourceHash,
        plist,
        toolchain,
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
    try {
      await fs.writeFile(plistFile, plist, { mode: 0o600 });
      execFileSync(swift, [...args, "-o", temporary], { stdio: "inherit" });
      if (sha256(await fs.readFile(source)) !== sourceHash)
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
      await fs.rm(temporary, { force: true });
      await fs.rm(temporaryRecord, { force: true });
    }
  }
  return results;
}
