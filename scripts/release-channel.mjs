/**
 * Which channel a release version belongs to, and what that means for publishing it.
 *
 * A stable release is `X.Y.Z`; a beta is `X.Y.Z-beta.N`. Relay's "Get pre-releases" setting reads
 * GitHub's pre-release flag on macOS, and electron-updater on Windows and Linux follows only the
 * `alpha` and `beta` channels, so other pre-release tags (`-rc.1`) are refused here rather than
 * published where no updater finds them. electron-builder names a version's updater files after
 * its channel (the first pre-release identifier): `beta.yml` and `beta-linux.yml` for a beta,
 * `latest.yml` and `latest-linux.yml` otherwise.
 */
export const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-beta\.\d+)?$/;

/**
 * The channel of `version`: whether GitHub marks it as a pre-release (and the `gh release`
 * flags that do so), and the Windows and Linux updater files its release must carry. Undefined
 * when it is no version Relay releases.
 */
export function releaseChannel(version) {
  if (!RELEASE_VERSION.test(version ?? "")) return undefined;
  const prerelease = version.includes("-");
  const channel = prerelease ? "beta" : "latest";
  return {
    prerelease,
    channel,
    ghFlags: prerelease ? ["--prerelease"] : [],
    updaterFiles: [`${channel}.yml`, `${channel}-linux.yml`],
  };
}
