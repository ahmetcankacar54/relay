import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A stand-in for /usr/bin/security in a temp folder: it logs argv and stdin, and serves a
 * one-item "keychain" file. Never the real tool.
 */
export function fakeSecurity(options: {
  stored?: string;
  exit?: number;
  storeOnFirstFind?: string;
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-fake-security-"));
  const tool = path.join(dir, "security");
  fs.writeFileSync(
    tool,
    `#!/bin/sh
dir="$(dirname "$0")"
echo "$*" >> "$dir/argv.log"
svc=""; prev=""
for a in "$@"; do if [ "$prev" = "-s" ]; then svc="$a"; fi; prev="$a"; done
key="$(printf '%s' "$svc" | tr -c 'A-Za-z0-9' '_')"
if [ "$1" = "-i" ]; then
  input="$(cat)"
  printf '%s\\n' "$input" >> "$dir/stdin.log"
  value="$(printf '%s\\n' "$input" | grep add-generic-password | sed -E 's/.* -w ([^ ]+).*/\\1/' | head -1)"
  if [ ! -f "$dir/item-Relay_Vault_Key" ] && [ -n "$value" ]; then printf '%s' "$value" > "$dir/item-Relay_Vault_Key"; fi
  exit 0
fi
if [ "$1" = "find-generic-password" ]; then
  [ -f "$dir/force-exit" ] && exit "$(cat "$dir/force-exit")"
  if [ "$key" = "Relay_Vault_Key" ] && [ -f "$dir/race" ] && [ ! -f "$dir/race-done" ]; then touch "$dir/race-done"; cp "$dir/race" "$dir/item-Relay_Vault_Key"; exit 44; fi
  [ -f "$dir/item-$key" ] || exit 44
  cat "$dir/item-$key"; echo
  exit 0
fi
exit 9
`,
    { mode: 0o755 },
  );
  const itemFile = (service: string) =>
    path.join(dir, "item-" + service.replace(/[^A-Za-z0-9]/g, "_"));
  if (options.stored !== undefined) fs.writeFileSync(itemFile("Relay Vault Key"), options.stored);
  if (options.exit !== undefined) fs.writeFileSync(path.join(dir, "force-exit"), String(options.exit));
  if (options.storeOnFirstFind !== undefined)
    fs.writeFileSync(path.join(dir, "race"), options.storeOnFirstFind);
  const read = (name: string) => {
    try {
      return fs.readFileSync(path.join(dir, name), "utf8");
    } catch {
      return "";
    }
  };
  return {
    dir,
    tool,
    argvLog: () => read("argv.log"),
    stdinLog: () => read("stdin.log"),
    stored: () => read("item-Relay_Vault_Key"),
    /** Stores a generic password for `service`, as another tool would have. */
    setItem: (service: string, value: string) => fs.writeFileSync(itemFile(service), value),
    removeItem: (service: string) => fs.rmSync(itemFile(service), { force: true }),
    remove: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
