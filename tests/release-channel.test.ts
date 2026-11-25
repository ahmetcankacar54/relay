import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
// @ts-expect-error The standalone release script has no declaration file.
import { releaseChannel } from "../scripts/release-channel.mjs";

const read = (file: string) =>
  fs.readFileSync(path.join(import.meta.dirname, "..", file), "utf8");

test("a stable version is published as before: latest.yml and latest-linux.yml, not a pre-release", () => {
  assert.deepEqual(releaseChannel("0.29.0"), {
    prerelease: false,
    channel: "latest",
    ghFlags: [],
    updaterFiles: ["latest.yml", "latest-linux.yml"],
  });
});

test("a beta is a GitHub pre-release with electron-builder's beta.yml and beta-linux.yml", () => {
  assert.deepEqual(releaseChannel("0.29.0-beta.1"), {
    prerelease: true,
    channel: "beta",
    ghFlags: ["--prerelease"],
    updaterFiles: ["beta.yml", "beta-linux.yml"],
  });
  assert.equal(releaseChannel("1.0.0-beta.12")?.channel, "beta");
});

test("tags no updater channel follows are refused", () => {
  for (const bad of [
    "0.29.0-rc.1",
    "0.29.0-beta",
    "0.29.0-alpha.1",
    "v0.29.0",
    "0.29",
    "0.29.0-1",
    "",
    undefined,
  ])
    assert.equal(releaseChannel(bad as string), undefined, String(bad));
});

test("the release tools follow the channel instead of naming latest*.yml", () => {
  const publish = read("scripts/publish-release.mjs");
  assert.match(publish, /channel\.updaterFiles\.filter/);
  assert.doesNotMatch(publish, /\["latest\.yml", "latest-linux\.yml"\]/);
  // Created and undrafted as a pre-release when it is a beta.
  assert.match(publish, /"--draft",\s*\.\.\.channel\.ghFlags/);
  assert.match(publish, /"--draft=false", \.\.\.channel\.ghFlags/);
  // The Homebrew tap gets stable releases only.
  assert.match(publish, /if \(!channel\.prerelease\) \{\s*fs\.mkdirSync/);
  const assets = read("scripts/release-assets.mjs");
  assert.match(assets, /for \(const yml of channel\.updaterFiles\)/);
  const workflow = read(".github/workflows/release.yml");
  assert.match(
    workflow,
    /- 'v\[0-9\]\+\.\[0-9\]\+\.\[0-9\]\+-beta\.\[0-9\]\+'/,
  );
  assert.match(workflow, /release\/beta\.yml/);
  assert.match(workflow, /release\/beta-linux\.yml/);
  assert.match(workflow, /\(-beta\\\.\[0-9\]\+\)\?\$/);
  assert.match(workflow, /prerelease=\(--prerelease\)/);
  assert.match(
    read("scripts/update-signing.mjs"),
    /releaseChannel\(tag\.slice\(1\)\)/,
  );
});
