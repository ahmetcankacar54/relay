import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installerName as electronInstallerName } from "../electron/core/win-linux-update";
import {
  installerName,
  renderUpdateYml,
  updaterFileName,
  writeUpdateYml,
  // @ts-expect-error The standalone release script has no declaration file.
} from "../scripts/electron-update-yml.mjs";

// electron-updater's own parser, as the installed Relay 0.x runs it.
const provider = createRequire(import.meta.url)(
  "electron-updater/out/providers/Provider.js",
) as {
  parseUpdateInfo(raw: string, file: string, url: URL): UpdateInfo;
  resolveFiles(info: UpdateInfo, base: URL): ResolvedFile[];
  findFile(
    files: ResolvedFile[],
    extension: string,
    not?: string[],
  ): ResolvedFile | undefined;
};
interface UpdateInfo {
  version: string;
  files: { url: string; sha512: string; size: number }[];
  path: string;
  sha512: string;
  releaseDate: string;
}
interface ResolvedFile {
  url: URL;
  info: { url: string; sha512: string; size: number };
}

const RELEASES =
  "https://github.com/ahmetcankacar54/relay/releases/download/v1.0.0/";

test("the Windows file is the text electron-builder published for 0.28.0", () => {
  // latest.yml of https://github.com/ahmetcankacar54/relay/releases/tag/v0.28.0, verbatim.
  const published = `version: 0.28.0
files:
  - url: Relay-Setup-0.28.0-x64.exe
    sha512: XXLApyg/VodCSE0elVAcpyxQBaVDpQJxnc9FU+fR45RlCSmjmv+dZIJQtgXZfap1h3EhCOdGd+LyYo2Lp0HW/A==
    size: 113036563
path: Relay-Setup-0.28.0-x64.exe
sha512: XXLApyg/VodCSE0elVAcpyxQBaVDpQJxnc9FU+fR45RlCSmjmv+dZIJQtgXZfap1h3EhCOdGd+LyYo2Lp0HW/A==
releaseDate: '2026-11-23T12:16:42.071Z'
`;
  assert.equal(
    renderUpdateYml({
      version: "0.28.0",
      name: "Relay-Setup-0.28.0-x64.exe",
      sha512:
        "XXLApyg/VodCSE0elVAcpyxQBaVDpQJxnc9FU+fR45RlCSmjmv+dZIJQtgXZfap1h3EhCOdGd+LyYo2Lp0HW/A==",
      size: 113036563,
      releaseDate: "2026-11-23T12:16:42.071Z",
    }),
    published,
  );
});

test("the installers carry the names Relay 0.x's updater installs", () => {
  for (const platform of ["win32", "linux"] as const)
    for (const version of ["1.0.0", "1.0.1-beta.2"])
      assert.equal(
        installerName(platform, version),
        electronInstallerName(platform, version),
      );
  assert.equal(updaterFileName("win32", "1.0.0"), "latest.yml");
  assert.equal(updaterFileName("linux", "1.0.0"), "latest-linux.yml");
  assert.equal(updaterFileName("win32", "1.0.0-beta.1"), "beta.yml");
  assert.equal(updaterFileName("linux", "1.0.0-beta.1"), "beta-linux.yml");
  assert.throws(
    () => updaterFileName("darwin", "1.0.0"),
    /no electron-updater/,
  );
  assert.throws(() => updaterFileName("win32", "1.0.0-rc.1"), /Not a release/);
});

test("electron-updater reads what is written for the NSIS installer and the AppImage", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-update-yml-"));
  try {
    for (const [platform, version, extension, not] of [
      ["win32", "1.0.0", "exe", undefined],
      ["linux", "1.0.0", "AppImage", ["rpm", "deb", "pacman"]],
      ["win32", "1.0.0-beta.3", "exe", undefined],
      ["linux", "1.0.0-beta.3", "AppImage", ["rpm", "deb", "pacman"]],
    ] as const) {
      const bytes = Buffer.from(`${platform} ${version} installer bytes`);
      const installer = path.join(dir, installerName(platform, version));
      fs.writeFileSync(installer, bytes);
      const file = await writeUpdateYml(installer, {
        version,
        releaseDate: new Date("2026-12-01T09:30:00Z"),
      });
      assert.equal(path.basename(file), updaterFileName(platform, version));
      const info = provider.parseUpdateInfo(
        fs.readFileSync(file, "utf8"),
        path.basename(file),
        new URL(path.basename(file), RELEASES),
      );
      const sha512 = createHash("sha512").update(bytes).digest("base64");
      assert.equal(info.version, version);
      assert.equal(info.path, path.basename(installer));
      assert.equal(info.sha512, sha512);
      assert.equal(info.releaseDate, "2026-12-01T09:30:00.000Z");
      const found = provider.findFile(
        provider.resolveFiles(info, new URL(RELEASES)),
        extension,
        not ? [...not] : undefined,
      );
      assert.ok(found);
      assert.equal(found.url.href, `${RELEASES}${path.basename(installer)}`);
      assert.deepEqual(found.info, {
        url: path.basename(installer),
        sha512,
        size: bytes.length,
      });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a file Relay 0.x would not install gets no updater file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-update-yml-"));
  try {
    // Tauri's own bundle names, before the release renames them.
    for (const name of [
      "Relay_1.0.0_x64-setup.exe",
      "Relay_1.0.0_amd64.AppImage",
      "Relay-Setup-1.0.1-x64.exe",
    ]) {
      const installer = path.join(dir, name);
      fs.writeFileSync(installer, "bytes");
      await assert.rejects(
        writeUpdateYml(installer, { version: "1.0.0" }),
        /is not a Relay 1\.0\.0 installer/,
      );
    }
    assert.deepEqual(
      fs.readdirSync(dir).filter((n) => n.endsWith(".yml")),
      [],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.throws(
    () =>
      renderUpdateYml({
        version: "1.0.0",
        name: "Relay-Setup-1.0.0-x64.exe",
        sha512: "abc",
        size: 1,
        releaseDate: new Date(),
      }),
    /SHA-512/,
  );
  assert.throws(
    () =>
      renderUpdateYml({
        version: "1.0.0",
        name: "Relay Setup.exe",
        sha512: "A".repeat(86) + "==",
        size: 1,
        releaseDate: new Date(),
      }),
    /release file name/,
  );
});
