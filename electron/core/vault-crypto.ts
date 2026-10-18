import crypto from "node:crypto";

/** The first bytes of every format-2 sealed file. */
export const VAULT_MAGIC = Buffer.from("RLY2");
/** Authenticated with every format-2 file; no file of another purpose opens as one. */
export const VAULT_AAD = Buffer.from("relay-vault:v2");
const NONCE = 12;
const TAG = 16;

/** Why a sealed file could not be opened: an older format, or damaged or foreign data. */
export class VaultFormatError extends Error {
  constructor(readonly reason: "legacy" | "invalid") {
    super(
      reason === "legacy"
        ? "This vault file is in the old format. Update Relay.app to 0.12 or later and open it once."
        : "A vault file is damaged or was sealed with another key.",
    );
  }
}

export interface Sealer {
  seal(text: string): Buffer;
  unseal(data: Buffer): string;
}

export function isSealedV2(data: Buffer): boolean {
  return data.length >= VAULT_MAGIC.length && data.subarray(0, 4).equals(VAULT_MAGIC);
}

/**
 * Seals text as `RLY2`, a 12-byte random nonce, the AES-256-GCM ciphertext and its 16-byte
 * tag. Opening checks the tag, so a damaged file is refused whole. A file in another format
 * goes to `legacyUnseal` (the app's safeStorage, during migration), or is refused as legacy.
 */
export function createSealer(
  key: Buffer,
  legacyUnseal?: (data: Buffer) => string,
): Sealer {
  if (key.length !== 32) throw new Error("The vault key must be 32 bytes.");
  const own = Buffer.from(key);
  return {
    seal(text) {
      const nonce = crypto.randomBytes(NONCE);
      const cipher = crypto.createCipheriv("aes-256-gcm", own, nonce);
      cipher.setAAD(VAULT_AAD);
      const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
      return Buffer.concat([VAULT_MAGIC, nonce, body, cipher.getAuthTag()]);
    },
    unseal(data) {
      if (!isSealedV2(data)) {
        if (legacyUnseal) return legacyUnseal(data);
        throw new VaultFormatError("legacy");
      }
      if (data.length < VAULT_MAGIC.length + NONCE + TAG)
        throw new VaultFormatError("invalid");
      const nonce = data.subarray(4, 4 + NONCE);
      const body = data.subarray(4 + NONCE, data.length - TAG);
      try {
        const decipher = crypto.createDecipheriv("aes-256-gcm", own, nonce);
        decipher.setAAD(VAULT_AAD);
        decipher.setAuthTag(data.subarray(data.length - TAG));
        return Buffer.concat([decipher.update(body), decipher.final()]).toString(
          "utf8",
        );
      } catch {
        throw new VaultFormatError("invalid");
      }
    },
  };
}
