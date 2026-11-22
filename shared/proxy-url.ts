const bracketed = (host: string) => (host.includes(":") && !host.startsWith("[") ? `[${host}]` : host);

/** The address a client dials: a wildcard bind address is reached through loopback. */
export function clientHost(host: string): string {
  if (host === "0.0.0.0") return "127.0.0.1";
  if (host === "::" || host === "[::]") return "[::1]";
  return bracketed(host);
}

/** `http://127.0.0.1:8317`: where the gateway answers. */
export const gatewayUrl = (host: string, port: number) => `http://${clientHost(host)}:${port}`;

/** Whether an IPv4 address is in Tailscale's 100.64.0.0/10 range. */
export function isTailscaleIPv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

/** The loopback names the gateway may listen on and answer to. */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "::1"]);

export const GATEWAY_HOST_ERROR = "Use 127.0.0.1, localhost or a Tailscale address.";

/** Where the gateway may listen: this computer only, or this computer's tailnet address. */
export const gatewayHostAllowed = (host: string) => LOOPBACK_HOSTS.has(host) || isTailscaleIPv4(host);
