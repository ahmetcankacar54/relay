import { readBytes, writeBytes } from "./desktop-files";
import { keyHint } from "../../shared/overflow";

/** Inside the vault: every overflow upstream's API key, in one sealed file. */
const FILE = "api-keys/overflow.bin";

/**
 * The gateway overflow's API keys, sealed like the rest of the vault and kept by upstream id. The
 * gateway reads them per request, so they stay in memory once read; the page only ever gets a
 * masked hint (`keyHint`).
 */
export class OverflowKeys {
  private keys?: Map<string, string>;
  private loading?: Promise<Map<string, string>>;

  constructor(
    private readonly vault: string,
    private readonly seal: (text: string) => Buffer,
    private readonly unseal: (data: Buffer) => string,
  ) {}

  private load(): Promise<Map<string, string>> {
    if (this.keys) return Promise.resolve(this.keys);
    this.loading ??= (async () => {
      const data = await readBytes(this.vault, FILE);
      const keys = new Map<string, string>();
      if (data) {
        const parsed: unknown = JSON.parse(this.unseal(data));
        if (parsed && typeof parsed === "object")
          for (const [id, key] of Object.entries(parsed))
            if (typeof key === "string" && key) keys.set(id, key);
      }
      this.keys = keys;
      return keys;
    })().finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }

  private async save(keys: Map<string, string>): Promise<void> {
    await writeBytes(this.vault, FILE, keys.size ? this.seal(JSON.stringify(Object.fromEntries(keys))) : null);
    this.keys = keys;
  }

  async get(id: string): Promise<string | undefined> {
    return (await this.load()).get(id);
  }

  async set(id: string, key: string): Promise<void> {
    const keys = new Map(await this.load());
    keys.set(id, key.trim());
    await this.save(keys);
  }

  async remove(id: string): Promise<void> {
    const keys = new Map(await this.load());
    if (!keys.delete(id)) return;
    await this.save(keys);
  }

  /** Each saved key's masked hint, by upstream id; empty until the keys were read once. */
  hints(): Record<string, string> {
    if (!this.keys) {
      void this.load().catch(() => {});
      return {};
    }
    return Object.fromEntries([...this.keys].map(([id, key]) => [id, keyHint(key)]));
  }
}
