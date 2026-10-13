// Chrome owns this native messaging host. It can outlive Claude's windows and
// must not make an otherwise clean Desktop shutdown look like a running app.
export function macDesktopPids(stdout: string, executable: string): number[] {
  const marker = executable.indexOf(".app/");
  if (marker < 0) return [];
  const bundle = executable.slice(0, marker + 5);
  const browserHost = `${bundle}Contents/Helpers/chrome-native-host`;
  return stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match || match[2] === browserHost) return [];
    return match[2] === executable || match[2].startsWith(bundle)
      ? [Number(match[1])]
      : [];
  });
}
