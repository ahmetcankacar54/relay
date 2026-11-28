import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  installerName,
  renderUpdateYml,
  updaterFileName,
  writeUpdateYml,
  // @ts-expect-error The standalone release script has no declaration file.
} from "../scripts/electron-update-yml.mjs";

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
  // The names Relay 0.x's electron-updater looks for (electron/core/win-linux-update.ts in 0.28.0).
  for (const version of ["1.0.0", "1.0.1-beta.2"]) {
    assert.equal(
      installerName("win32", version),
      `Relay-Setup-${version}-x64.exe`,
    );
    assert.equal(
      installerName("linux", version),
      `Relay-${version}-x86_64.AppImage`,
    );
  }
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
