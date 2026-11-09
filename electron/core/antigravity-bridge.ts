import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes, createHash } from "node:crypto";

const execFileAsync = promisify(execFile);
export const CLI_PROXY_VERSION = "8.0.61";
const RELEASE = `https://github.com/router-for-me/CLIProxyAPI/releases/download/v${CLI_PROXY_VERSION}`;
const ASSETS: Record<string, { name: string; sha256: string }> = {
  "darwin-arm64": { name: "CLIProxyAPI_8.0.61_darwin_aarch64.tar.gz", sha256: "ed73b4e3e9a71c524c54ecb64da3235a48de5f233aabccc58c43259ac6b1392f" },
  "darwin-x64": { name: "CLIProxyAPI_8.0.61_darwin_amd64.tar.gz", sha256: "6d60879a83f2a18dc5af37ee93a571c7f524fac9a664cb0b6080ccf11126c6e6" },
  "linux-arm64": { name: "CLIProxyAPI_8.0.61_linux_aarch64.tar.gz", sha256: "ca1ba77c8140c875c66d5cb470cd6aba421f6ef71fede54e8e34703a46be5731" },
  "linux-x64": { name: "CLIProxyAPI_8.0.61_linux_amd64.tar.gz", sha256: "9d0af252b7eca7b9f670f15cd0d369b20a3bb14523b474a00b1ea334a2220078" },
  "win32-arm64": { name: "CLIProxyAPI_8.0.61_windows_aarch64.zip", sha256: "877878538504ff58469081392ec17143d9ad1d9f20042ff5a902a05f5733261c" },
  "win32-x64": { name: "CLIProxyAPI_8.0.61_windows_amd64.zip", sha256: "e6dbe1337d17b993c6fa6d75d71f2e98db6ea3653af73a4217956f0c53e025b5" },
};

const secret = () => randomBytes(32).toString("base64url");
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Installs a pinned CLIProxyAPI binary. The archive digest is checked before extraction. */
export async function installCliProxyBinary(toolsDir: string): Promise<string> {
  const asset = ASSETS[`${process.platform}-${process.arch}`];
  if (!asset) throw new Error(`CLIProxyAPI is unavailable on ${process.platform}/${process.arch}`);
  const installDir = path.join(toolsDir, `cli-proxy-api-${CLI_PROXY_VERSION}-${process.platform}-${process.arch}`);
  const binary = path.join(installDir, process.platform === "win32" ? "cli-proxy-api.exe" : "cli-proxy-api");
  try {
    await fsp.access(binary);
    return binary;
  } catch {}

  await fsp.mkdir(toolsDir, { recursive: true, mode: 0o700 });
  const temp = await fsp.mkdtemp(path.join(toolsDir, ".cli-proxy-download-"));
  try {
    const response = await fetch(`${RELEASE}/${asset.name}`, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`CLIProxyAPI download failed (${response.status})`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 100 * 1024 * 1024) throw new Error("CLIProxyAPI archive is too large");
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== asset.sha256) throw new Error("CLIProxyAPI archive checksum mismatch");
    const archive = path.join(temp, asset.name);
    await fsp.writeFile(archive, bytes, { mode: 0o600 });
    await execFileAsync("tar", [process.platform === "win32" ? "-xf" : "-xzf", archive, "-C", temp]);
    const extracted = path.join(temp, process.platform === "win32" ? "cli-proxy-api.exe" : "cli-proxy-api");
    await fsp.access(extracted);
    await fsp.mkdir(installDir, { recursive: true, mode: 0o700 });
    await fsp.copyFile(extracted, binary);
    if (process.platform !== "win32") await fsp.chmod(binary, 0o700);
    return binary;
  } finally {
    await fsp.rm(temp, { recursive: true, force: true });
  }
}

export type AntigravityOAuthState =
  | { status: "wait" }
  | { status: "ok"; email: string }
  | { status: "error"; error: string };

/** One isolated CLIProxyAPI process and OAuth store per Relay Antigravity account. */
export class AntigravityBridge {
  private child?: ChildProcess;
  private starting?: Promise<void>;
  private port?: number;
  private readonly managementKey = secret();
  private readonly clientKey = secret();
  readonly authDir: string;

  constructor(
    readonly profileDir: string,
    private readonly toolsDir: string,
    private readonly binaryProvider: (toolsDir: string) => Promise<string> = installCliProxyBinary,
  ) {
    this.authDir = path.join(profileDir, "antigravity-oauth");
  }

  get endpoint(): { url: string; key: string } | undefined {
    return this.port && this.child?.exitCode === null
      ? { url: `http://127.0.0.1:${this.port}`, key: this.clientKey }
      : undefined;
  }

  async start(): Promise<void> {
    if (this.endpoint) return;
    if (this.starting) return this.starting;
    this.starting = this.startNow();
    try { await this.starting; } finally { this.starting = undefined; }
  }

  private async startNow(): Promise<void> {
    const binary = await this.binaryProvider(this.toolsDir);
    await fsp.mkdir(this.authDir, { recursive: true, mode: 0o700 });
    const port = await freePort();
    const configPath = path.join(this.profileDir, "antigravity-proxy.yaml");
    // JSON quoted strings are valid YAML scalars and cannot escape into new fields.
    const config = [
      "config-version: 8", "server:", '  host: "127.0.0.1"', `  port: ${port}`,
      "management:", "  allow-remote: false", `  secret-key: ${JSON.stringify(this.managementKey)}`,
      "  disable-control-panel: true", "access:", "  api-keys:",
      `    - ${JSON.stringify(this.clientKey)}`, "oauth:",
      `  auth-dir: ${JSON.stringify(this.authDir)}`, "",
    ].join("\n");
    await fsp.writeFile(configPath, config, { mode: 0o600 });
    const child = spawn(binary, ["-config", configPath, "-local-model"], {
      cwd: this.profileDir,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    child.on("error", () => {});
    this.port = port;
    // Consume logs so a full pipe cannot stall the sidecar; never surface token material.
    child.stdout?.resume();
    child.stderr?.resume();
    const started = Date.now();
    while (Date.now() - started < 15_000) {
      if (child.exitCode !== null) break;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/v1/models`, {
          headers: { Authorization: `Bearer ${this.clientKey}` },
          signal: AbortSignal.timeout(700),
        });
        if (response.ok) return;
      } catch {}
      await pause(150);
    }
    this.stop();
    throw new Error("CLIProxyAPI could not start on the local port");
  }

  private async management<T>(route: string): Promise<T> {
    await this.start();
    const response = await fetch(`${this.endpoint!.url}/v8/management${route}`, {
      headers: { Authorization: `Bearer ${this.managementKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Antigravity OAuth service returned ${response.status}`);
    return response.json() as Promise<T>;
  }

  async beginOAuth(): Promise<{ state: string; url: string }> {
    const result = await this.management<{ status: string; state?: string; url?: string }>("/oauth/auth-url?provider=antigravity");
    if (result.status !== "ok" || !result.state || !result.url) throw new Error("Antigravity OAuth could not start");
    const url = new URL(result.url);
    if (url.protocol !== "https:" || url.hostname !== "accounts.google.com") throw new Error("Unexpected Antigravity sign-in address");
    return { state: result.state, url: result.url };
  }

  async pollOAuth(state: string): Promise<AntigravityOAuthState> {
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(state)) throw new Error("Invalid OAuth state");
    const result = await this.management<{ status: string; error?: string; auth_id?: string }>(`/oauth/status?state=${encodeURIComponent(state)}`);
    if (result.status === "wait") return { status: "wait" };
    if (result.status !== "ok" || !result.auth_id) return { status: "error", error: result.error ?? "Antigravity sign-in failed" };
    const file = path.basename(result.auth_id);
    if (file !== result.auth_id || !/^antigravity-[^/\\]+\.json$/.test(file))
      return { status: "error", error: "Invalid Antigravity credential file" };
    const credentialPath = path.join(this.authDir, file);
    const stat = await fsp.lstat(credentialPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65_536)
      return { status: "error", error: "Invalid Antigravity credential file" };
    const raw = JSON.parse(await fsp.readFile(credentialPath, "utf8"));
    if (raw?.type !== "antigravity" || typeof raw.email !== "string" ||
      typeof raw.refresh_token !== "string" || typeof raw.project_id !== "string")
      return { status: "error", error: "Incomplete Antigravity OAuth credential" };
    return { status: "ok", email: raw.email };
  }

  async hasCredential(): Promise<boolean> {
    return (await this.savedOAuthEmail()) !== undefined;
  }

  async savedOAuthEmail(): Promise<string | undefined> {
    try {
      const names = await fsp.readdir(this.authDir);
      for (const name of names) {
        if (!/^antigravity-[^/\\]+\.json$/.test(name)) continue;
        const file = path.join(this.authDir, name);
        const stat = await fsp.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65_536) continue;
        const data = JSON.parse(await fsp.readFile(file, "utf8"));
        if (data?.type === "antigravity" && typeof data.email === "string" &&
          typeof data.refresh_token === "string" && typeof data.project_id === "string")
          return data.email;
      }
    } catch {}
    return undefined;
  }

  stop(): void {
    this.child?.kill();
    this.child = undefined;
    this.port = undefined;
  }
}
