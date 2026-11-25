import { readStatuslineSnapshot, readStdin, statuslineColor, statuslineText } from "./statusline";

/**
 * The launcher's fast path for `relay statusline` (dist/relay-statusline.js). Anything it does not
 * handle, a missing snapshot included, goes to the full CLI, which explains it in the user's language.
 */
async function main() {
  const flags = process.argv.slice(3);
  const snapshot = flags.every((flag) => flag === "--color" || flag === "--no-color")
    ? readStatuslineSnapshot(process.env)
    : undefined;
  if (!snapshot) {
    // A computed specifier keeps esbuild from bundling the full CLI into this file.
    await import(new URL("./relay-cli.js", import.meta.url).href);
    return;
  }
  const line = statuslineText(snapshot, {
    stdin: await readStdin(process.stdin),
    env: process.env,
    now: Date.now(),
    color: statuslineColor(
      { color: flags.includes("--color"), noColor: flags.includes("--no-color") },
      !!process.stdout.isTTY,
      process.env,
    ),
  });
  if (line) process.stdout.write(`${line}\n`);
}

void main();
