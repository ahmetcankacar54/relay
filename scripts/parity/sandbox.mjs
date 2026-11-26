// The macOS sandbox the parity recordings run Relay in (rust/README.md). It hides what differs from
// one Mac to the next, the same way for the Node CLI and the Rust build:
// - the installed Relay.app (its version through plutil or its Info.plist);
// - the process census (`ps`, and the process listing a Rust port reads directly), so a running
//   Relay.app or Claude is never seen, and a lock holder's start time reads as unknown;
// - the desktop session (`launchctl managername`): unknown, which Relay takes as a desktop session;
// - the real Keychain (`/usr/bin/security`; the fixture's fake tool is used instead), AppleScript
//   and `open`, so nothing on the machine is quit, launched or read;
// - the network: nothing leaves the machine, and DNS fails at once. `localhost` stays reachable
//   only when asked for (the gateway and its fake upstreams).

const DENIED_TOOLS = [
  "/bin/ps",
  "/bin/launchctl",
  "/usr/bin/security",
  "/usr/bin/osascript",
  "/usr/bin/open",
  "/usr/bin/plutil",
];

/** The sandbox profile; `localhost` keeps loopback connections open. */
export function sandboxProfile({ localhost = false } = {}) {
  return [
    "(version 1)",
    "(allow default)",
    '(deny file-read* (subpath "/Applications/Relay.app"))',
    `(deny process-exec ${DENIED_TOOLS.map((tool) => `(literal "${tool}")`).join(" ")})`,
    "(deny process-info-listpids)",
    "(deny process-info-pidinfo (target others))",
    '(deny network-outbound (remote ip "*:*"))',
    '(deny network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))',
    ...(localhost
      ? ['(allow network-outbound (remote ip "localhost:*"))']
      : []),
  ].join("\n");
}

/** `command` run inside the sandbox. */
export function sandboxed(command, options) {
  return ["/usr/bin/sandbox-exec", "-p", sandboxProfile(options), ...command];
}
